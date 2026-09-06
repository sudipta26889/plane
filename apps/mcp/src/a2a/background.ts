import { config } from "../config.js";
import { db } from "../db.js";
import { runAgent } from "../agent/loop.js";
import { clearRunState, loadRunState, saveRunState } from "../agent/state.js";
import { interpretDecision, applyRevisionInstructions } from "./dharahil.js";
import { transitionState, executeA2aTask, settleAgentRun } from "./task-executor.js";
import { deliverWebhook } from "./webhooks.js";
import { logAuditEvent } from "./audit-log.js";
import { sseManager } from "./sse.js";
import { syncWorkItems, syncPages } from "../knowledge/index-sync.js";
import { embed } from "../knowledge/embeddings.js";

/**
 * Poll DharaHIL for pending HITL decisions and handle expired approvals.
 * Runs every 30 seconds.
 */
export async function pollHitlDecisions() {
  if (!config.dharahilEnabled) return;

  try {
    // Find tasks awaiting approval
    const tasks = await db.query(
      `SELECT t.task_id, t.context_id, t.skill, t.input, t.user_id, t.workspace_slug, t.client_id,
              a.dharahil_request_id, a.expires_at
       FROM a2a_tasks t
       JOIN a2a_approvals a ON t.task_id = a.task_id
       WHERE t.state = 'auth_required' AND a.status = 'pending'`
    );

    for (const task of tasks.rows) {
      // Check if expired
      if (new Date(task.expires_at) < new Date()) {
        await clearRunState(task.task_id);
        await transitionState(task.task_id, "rejected", "Approval expired");
        await db.query(
          `UPDATE a2a_approvals SET status = 'expired', responded_at = NOW() WHERE task_id = $1`,
          [task.task_id]
        );
        await logAuditEvent({ userId: task.user_id, clientId: task.client_id, ipAddress: "", operation: "approval.expired", taskId: task.task_id, skill: task.skill, success: false });
        sseManager.notify(task.task_id, "task.rejected", { taskId: task.task_id, state: "rejected", reason: "Approval expired" });
        continue;
      }

      // Poll DharaHIL for decision
      if (!task.dharahil_request_id) continue;

      try {
        const response = await fetch(`${config.dharahilBaseUrl}/v1/requests/${task.dharahil_request_id}`, {
          headers: {
            "X-DHARA-API-KEY": config.dharahilApiKey,
          },
        });

        if (!response.ok) continue;
        const data = await response.json() as any;
        if (data.status === "PENDING") continue;

        const decision = interpretDecision({ action: data.action || data.status, reason: data.reason || data.last_decision_note, revise_input: data.last_decision_revise_input || data.revise_input });

        if (decision.shouldProceed) {
          // Approved — transition back to submitted, then execute
          await db.query(
            `UPDATE a2a_approvals SET status = 'approved', responded_at = NOW(), responded_by = $2 WHERE task_id = $1`,
            [task.task_id, data.approver || null]
          );
          await transitionState(task.task_id, "submitted", "Approved by human");

          const auth = { userId: task.user_id, workspaceSlug: task.workspace_slug, clientId: task.client_id, scopes: ["taskpilot:read", "taskpilot:write"] };
          const input = typeof task.input === "string" ? JSON.parse(task.input) : task.input;

          // A saved transcript means this is an agent run, suspended mid-loop
          // on the call the human just approved. Hand that call back to the
          // loop as `resumeFrom` so it executes pre-approved — asking a second
          // time is how an approved write gets lost to an expired request.
          const runState = await loadRunState(task.task_id);
          if (runState) {
            const result = await runAgent({
              text: input?.text ?? "",
              contextId: task.context_id,
              auth,
              taskId: task.task_id,
              resumeFrom: runState,
            });
            await settleAgentRun(task.task_id, task.context_id, result, auth);
          } else {
            await executeA2aTask(task.task_id, task.skill, input, auth);
          }

          await logAuditEvent({ userId: task.user_id, clientId: task.client_id, ipAddress: "", operation: "approval.approved", taskId: task.task_id, skill: task.skill, success: true });
        } else if (decision.shouldRevise) {
          // Revised — use LLM to interpret instructions, modify args, re-execute
          console.log(`[a2a] REVISE requested for ${task.task_id}: "${decision.reviseInput}"`);

          // An agent run suspended on one specific tool call. Revising it means
          // rewriting THAT call's arguments inside the saved transcript, then
          // resuming — the revised arguments are what the human approved, so
          // the resumed call is pre-approved exactly as the plain approve path
          // is. Re-asking would lose the write to an expired second request.
          const reviseState = await loadRunState(task.task_id);
          if (reviseState) {
            const pending = reviseState.pendingToolCall;
            if (!pending) {
              await clearRunState(task.task_id);
              await transitionState(task.task_id, "rejected", "Nothing was pending to revise");
              continue;
            }

            const auth = { userId: task.user_id, workspaceSlug: task.workspace_slug, clientId: task.client_id, scopes: ["taskpilot:read", "taskpilot:write"] };
            const input = typeof task.input === "string" ? JSON.parse(task.input) : task.input;

            try {
              const revisedArgs = await applyRevisionInstructions(pending.name, pending.args, decision.reviseInput);
              console.log(`[a2a] Revised ${pending.name} for ${task.task_id}:`, JSON.stringify(revisedArgs));

              await saveRunState(task.task_id, {
                ...reviseState,
                pendingToolCall: { ...pending, args: revisedArgs },
              });
              await db.query(
                `UPDATE a2a_approvals SET status = 'revised', responded_at = NOW() WHERE task_id = $1`,
                [task.task_id]
              );
              await transitionState(task.task_id, "submitted", `Revised by human: ${decision.reviseInput}`);

              const revisedState = await loadRunState(task.task_id);
              const result = await runAgent({
                text: input?.text ?? "",
                contextId: task.context_id,
                auth,
                taskId: task.task_id,
                resumeFrom: revisedState!,
              });
              await settleAgentRun(task.task_id, task.context_id, result, auth);
              await logAuditEvent({ userId: task.user_id, clientId: task.client_id, ipAddress: "", operation: "approval.revised", taskId: task.task_id, skill: task.skill, success: true, metadata: { revise_input: decision.reviseInput, revised_args: JSON.stringify(revisedArgs) } });
            } catch (err: any) {
              // A failed revision must not fall through and execute the
              // ORIGINAL arguments — those are the ones the human rejected.
              await clearRunState(task.task_id);
              await transitionState(task.task_id, "rejected", `Revision failed: ${err.message}`);
              await logAuditEvent({ userId: task.user_id, clientId: task.client_id, ipAddress: "", operation: "approval.revised", taskId: task.task_id, skill: task.skill, success: false, errorMessage: err.message });
            }
            continue;
          }

          try {
            const originalInput = typeof task.input === "string" ? JSON.parse(task.input) : task.input;
            const { getSkillDefinition } = await import("./skill-registry.js");
            const skillDef = getSkillDefinition(task.skill);
            const mcpTool = skillDef?.mcpTool || task.skill;

            // LLM interprets the human's revision instructions
            const revisedArgs = await applyRevisionInstructions(mcpTool, originalInput, decision.reviseInput);
            console.log(`[a2a] Revised args for ${task.task_id}:`, JSON.stringify(revisedArgs));

            // Update the task input with revised args
            await db.query(
              `UPDATE a2a_tasks SET input = $2, updated_at = NOW() WHERE task_id = $1`,
              [task.task_id, JSON.stringify(revisedArgs)]
            );

            await db.query(
              `UPDATE a2a_approvals SET status = 'revised', responded_at = NOW() WHERE task_id = $1`,
              [task.task_id]
            );

            // Transition to submitted, then execute with revised args
            await transitionState(task.task_id, "submitted", `Revised by human: ${decision.reviseInput}`);

            const auth = { userId: task.user_id, workspaceSlug: task.workspace_slug, clientId: task.client_id, scopes: ["taskpilot:read", "taskpilot:write"] };
            await executeA2aTask(task.task_id, task.skill, revisedArgs, auth);

            await logAuditEvent({ userId: task.user_id, clientId: task.client_id, ipAddress: "", operation: "approval.revised", taskId: task.task_id, skill: task.skill, success: true, metadata: { revise_input: decision.reviseInput, revised_args: JSON.stringify(revisedArgs) } });
          } catch (err: any) {
            console.error(`[a2a] REVISE failed for ${task.task_id}:`, err);
            await db.query(
              `UPDATE a2a_approvals SET status = 'rejected', responded_at = NOW() WHERE task_id = $1`,
              [task.task_id]
            );
            await transitionState(task.task_id, "rejected", `Revision failed: ${err.message}`);
            await logAuditEvent({ userId: task.user_id, clientId: task.client_id, ipAddress: "", operation: "approval.revised", taskId: task.task_id, skill: task.skill, success: false, errorMessage: err.message });
          }
        } else {
          // Rejected — the suspended write is dead, so is its transcript.
          await clearRunState(task.task_id);
          await db.query(
            `UPDATE a2a_approvals SET status = 'rejected', responded_at = NOW() WHERE task_id = $1`,
            [task.task_id]
          );
          await transitionState(task.task_id, "rejected", decision.reason);

          await logAuditEvent({ userId: task.user_id, clientId: task.client_id, ipAddress: "", operation: "approval.rejected", taskId: task.task_id, skill: task.skill, success: false, errorMessage: decision.reason });
          sseManager.notify(task.task_id, "task.rejected", { taskId: task.task_id, state: "rejected", reason: decision.reason });
        }
      } catch (err) {
        console.error(`[a2a] Failed to poll DharaHIL for ${task.task_id}:`, err);
      }
    }
  } catch (err) {
    console.error("[a2a] HITL polling error:", err);
  }
}

/**
 * Retry failed webhook deliveries.
 * Runs every 30 seconds.
 */
export async function retryWebhooks() {
  try {
    const deliveries = await db.query(
      `SELECT d.id, d.webhook_config_id, d.task_id, d.event, d.payload, d.attempts,
              c.url, c.secret
       FROM a2a_webhook_deliveries d
       JOIN a2a_webhook_configs c ON d.webhook_config_id = c.id
       WHERE d.status = 'pending' AND d.next_retry_at <= NOW() AND d.attempts < 5`
    );

    for (const delivery of deliveries.rows) {
      const payload = typeof delivery.payload === "string" ? JSON.parse(delivery.payload) : delivery.payload;
      const result = await deliverWebhook(delivery.url, delivery.secret, payload);

      if (result.success) {
        await db.query(
          `UPDATE a2a_webhook_deliveries SET status = 'delivered', last_attempt_at = NOW(), response_status = $2, attempts = $3 WHERE id = $1`,
          [delivery.id, result.status, delivery.attempts + 1]
        );
      } else {
        const nextAttempt = delivery.attempts + 1;
        if (nextAttempt >= 5) {
          await db.query(
            `UPDATE a2a_webhook_deliveries SET status = 'failed', last_attempt_at = NOW(), attempts = $2, response_status = $3, response_body = $4 WHERE id = $1`,
            [delivery.id, nextAttempt, result.status || null, result.body?.substring(0, 1000) || null]
          );
        } else {
          const backoff = [1000, 5000, 15000, 60000, 300000];
          const nextRetry = new Date(Date.now() + backoff[nextAttempt - 1]);
          await db.query(
            `UPDATE a2a_webhook_deliveries SET last_attempt_at = NOW(), attempts = $2, next_retry_at = $3, response_status = $4, response_body = $5 WHERE id = $1`,
            [delivery.id, nextAttempt, nextRetry, result.status || null, result.body?.substring(0, 1000) || null]
          );
        }
      }
    }
  } catch (err) {
    console.error("[a2a] Webhook retry error:", err);
  }
}

/**
 * Delete old tasks, approvals, audit logs, and webhook deliveries per retention policy.
 * Runs every 24 hours.
 */
export async function cleanupOldData() {
  try {
    // 90-day retention for tasks, history, approvals, audit logs
    await db.query(`DELETE FROM a2a_task_history WHERE task_id IN (SELECT task_id FROM a2a_tasks WHERE state IN ('completed','failed','canceled','rejected') AND created_at < NOW() - INTERVAL '90 days')`);
    await db.query(`DELETE FROM a2a_approvals WHERE task_id IN (SELECT task_id FROM a2a_tasks WHERE state IN ('completed','failed','canceled','rejected') AND created_at < NOW() - INTERVAL '90 days')`);
    await db.query(`DELETE FROM a2a_tasks WHERE state IN ('completed','failed','canceled','rejected') AND created_at < NOW() - INTERVAL '90 days'`);
    await db.query(`DELETE FROM a2a_audit_logs WHERE created_at < NOW() - INTERVAL '90 days'`);

    // A suspended agent run whose approval nobody answered in a week is dead;
    // DharaHIL TTLs are hours. Without this the transcripts accumulate forever.
    await db.query(`DELETE FROM a2a_agent_runs WHERE updated_at < NOW() - INTERVAL '7 days'`);

    // 30-day retention for webhook deliveries
    await db.query(`DELETE FROM a2a_webhook_deliveries WHERE created_at < NOW() - INTERVAL '30 days'`);

    console.log("[a2a] Data retention cleanup complete");
  } catch (err) {
    console.error("[a2a] Cleanup error:", err);
  }
}

/**
 * Keep the work-item index current. Incremental by content hash, so a run
 * with no changes costs one Qdrant lookup and no embedding calls.
 */
// syncWorkItems pages the whole corpus from a fresh cursor every call, so two
// overlapping runs duplicate all the DB and embedding work. A first run against
// an unindexed corpus can outlast the 10-minute interval, so guard reentry.
let syncInFlight = false;

// Last outcome, surfaced through /health. A sync that fails every tick would
// otherwise be visible only in logs someone happens to be reading — the same
// silent-degradation shape this codebase already got bitten by.
let lastSyncError: string | null = null;

export function getIndexSyncStatus(): { ok: boolean; detail: string } {
  if (lastSyncError) return { ok: false, detail: `last sync failed: ${lastSyncError}` };
  return { ok: true, detail: syncInFlight ? "sync in progress" : "idle" };
}

export async function syncKnowledgeIndex() {
  if (!config.qdrantUrl || !config.embeddingUrl) return;
  if (syncInFlight) {
    console.warn("[knowledge] Previous sync still running; skipping this tick");
    return;
  }

  syncInFlight = true;
  try {
    const items = await syncWorkItems();
    if (items.embedded > 0) {
      console.log(`[knowledge] Indexed ${items.embedded} work items (${items.skipped} unchanged)`);
    }

    // Pages are the larger corpus — 5,908 of them — so they follow work items
    // rather than competing with them for the CPU-bound embedder.
    const pages = await syncPages();
    if (pages.embedded > 0) {
      console.log(`[knowledge] Indexed ${pages.embedded} pages (${pages.skipped} unchanged)`);
    }

    lastSyncError = null;
  } catch (err: any) {
    lastSyncError = err?.message ? String(err.message).slice(0, 200) : "unknown error";
    console.error(`[knowledge] Index sync failed: ${lastSyncError}`);
  } finally {
    syncInFlight = false;
  }
}

/**
 * The embedding server unloads the model after 300s idle and takes ~10.5s to
 * reload. A cheap embed every few minutes keeps it resident.
 */
export async function keepEmbedderWarm() {
  if (!config.embeddingUrl) return;

  try {
    await embed("keepalive");
  } catch (err: any) {
    console.warn(`[knowledge] Keepalive failed: ${err.message}`);
  }
}
