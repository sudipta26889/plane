import { config } from "../config.js";
import { db } from "../db.js";
import { interpretDecision } from "./dharahil.js";
import { transitionState, executeA2aTask } from "./task-executor.js";
import { deliverWebhook } from "./webhooks.js";
import { logAuditEvent } from "./audit-log.js";
import { sseManager } from "./sse.js";

/**
 * Poll DharaHIL for pending HITL decisions and handle expired approvals.
 * Runs every 30 seconds.
 */
export async function pollHitlDecisions() {
  if (!config.dharahilEnabled) return;

  try {
    // Find tasks awaiting approval
    const tasks = await db.query(
      `SELECT t.task_id, t.skill, t.input, t.user_id, t.workspace_slug, t.client_id,
              a.dharahil_request_id, a.expires_at
       FROM a2a_tasks t
       JOIN a2a_approvals a ON t.task_id = a.task_id
       WHERE t.state = 'auth_required' AND a.status = 'pending'`
    );

    for (const task of tasks.rows) {
      // Check if expired
      if (new Date(task.expires_at) < new Date()) {
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
            Authorization: `Bearer ${config.dharahilApiKey}`,
            "X-Tenant-Id": config.dharahilTenantId,
            "X-App-Id": config.dharahilAppId,
          },
        });

        if (!response.ok) continue;
        const data = await response.json() as any;
        if (data.status === "PENDING") continue;

        const decision = interpretDecision({ action: data.action || data.status, reason: data.reason });

        if (decision.shouldProceed) {
          // Approved — transition back to submitted, then execute
          await db.query(
            `UPDATE a2a_approvals SET status = 'approved', responded_at = NOW(), responded_by = $2 WHERE task_id = $1`,
            [task.task_id, data.approver || null]
          );
          await transitionState(task.task_id, "submitted", "Approved by human");

          const auth = { userId: task.user_id, workspaceSlug: task.workspace_slug, clientId: task.client_id, scopes: ["taskpilot:read", "taskpilot:write"] };
          const input = typeof task.input === "string" ? JSON.parse(task.input) : task.input;
          await executeA2aTask(task.task_id, task.skill, input, auth);

          await logAuditEvent({ userId: task.user_id, clientId: task.client_id, ipAddress: "", operation: "approval.approved", taskId: task.task_id, skill: task.skill, success: true });
        } else {
          // Rejected
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

    // 30-day retention for webhook deliveries
    await db.query(`DELETE FROM a2a_webhook_deliveries WHERE created_at < NOW() - INTERVAL '30 days'`);

    console.log("[a2a] Data retention cleanup complete");
  } catch (err) {
    console.error("[a2a] Cleanup error:", err);
  }
}
