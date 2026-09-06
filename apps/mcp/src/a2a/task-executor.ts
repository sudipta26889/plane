import crypto from "node:crypto";
import { db } from "../db.js";
import { clearRunState } from "../agent/state.js";
import { executeToolCall } from "../tools/handlers.js";
import { buildApprovalRequest, submitApproval } from "./dharahil.js";
import { getSkillDefinition } from "./skill-registry.js";
import { logAuditEvent } from "./audit-log.js";
import { queueWebhookDeliveries } from "./webhooks.js";
import { isValidTransition, isTerminalState } from "./types.js";
import type { A2aTaskState, AuthContext } from "./types.js";
import type { AgentResult } from "../agent/loop.js";

/**
 * The skill an agent-loop task records. Deliberately absent from the skill
 * registry, so `message.send` can never be asked to dispatch it directly — an
 * agent run only ever starts from free text.
 */
export const AGENT_SKILL = "agent.run";

/**
 * Maps A2A skill input to MCP tool args.
 * Currently a pass-through since A2A skill input matches MCP tool args.
 */
export function mapSkillInputToMcpArgs(
  _skill: string,
  input: Record<string, any>,
): Record<string, any> {
  return { ...input };
}

/**
 * Create a new A2A task in the database.
 */
export async function createA2aTask(params: {
  taskId?: string;
  contextId: string;
  clientId: string;
  userId: string;
  workspaceSlug: string;
  skill: string;
  input: Record<string, any>;
  state?: A2aTaskState;
  requiresApproval?: boolean;
  idempotencyKey?: string;
}): Promise<string> {
  const taskId = params.taskId || `task_${crypto.randomUUID()}`;
  const state = params.state || "submitted";

  await db.query(
    `INSERT INTO a2a_tasks (task_id, context_id, client_id, user_id, workspace_slug, skill, input, state, requires_approval, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      taskId,
      params.contextId,
      params.clientId,
      params.userId,
      params.workspaceSlug,
      params.skill,
      JSON.stringify(params.input),
      state,
      params.requiresApproval || false,
      params.idempotencyKey || null,
    ],
  );

  await db.query(
    `INSERT INTO a2a_task_history (task_id, from_state, to_state, reason)
     VALUES ($1, NULL, $2, 'Task created')`,
    [taskId, state],
  );

  return taskId;
}

/**
 * Transition an A2A task to a new state.
 */
export async function transitionState(
  taskId: string,
  newState: A2aTaskState,
  reason?: string,
): Promise<void> {
  const result = await db.query(
    `SELECT state FROM a2a_tasks WHERE task_id = $1`,
    [taskId],
  );
  if (result.rows.length === 0) throw new Error(`Task not found: ${taskId}`);

  const currentState = result.rows[0].state;

  if (isTerminalState(currentState)) {
    throw new Error(`Cannot transition from terminal state: ${currentState}`);
  }

  if (!isValidTransition(currentState, newState)) {
    throw new Error(`Invalid transition: ${currentState} → ${newState}`);
  }

  const updates: string[] = [`state = $2`, `updated_at = NOW()`];
  const params: any[] = [taskId, newState];
  let paramIdx = 3;

  if (reason) {
    updates.push(`state_reason = $${paramIdx}`);
    params.push(reason);
    paramIdx++;
  }

  if (isTerminalState(newState)) {
    updates.push(`completed_at = NOW()`);
  }

  await db.query(
    `UPDATE a2a_tasks SET ${updates.join(", ")} WHERE task_id = $1`,
    params,
  );

  await db.query(
    `INSERT INTO a2a_task_history (task_id, from_state, to_state, reason)
     VALUES ($1, $2, $3, $4)`,
    [taskId, currentState, newState, reason || null],
  );
}

/**
 * Store the result of a completed task.
 */
export async function storeResult(taskId: string, result: any): Promise<void> {
  await db.query(
    `UPDATE a2a_tasks SET result = $2, updated_at = NOW() WHERE task_id = $1`,
    [taskId, JSON.stringify(result)],
  );
}

/**
 * Store an error for a failed task.
 */
export async function storeError(taskId: string, error: any): Promise<void> {
  await db.query(
    `UPDATE a2a_tasks SET error = $2, updated_at = NOW() WHERE task_id = $1`,
    [taskId, JSON.stringify(error)],
  );
}

/**
 * Execute an A2A task by calling the underlying MCP tool handler.
 * Handles state transitions, retries, audit logging, and webhook delivery.
 */
export async function executeA2aTask(
  taskId: string,
  skill: string,
  input: Record<string, any>,
  auth: AuthContext,
): Promise<any> {
  const skillDef = getSkillDefinition(skill);
  if (!skillDef) throw new Error(`Unknown skill: ${skill}`);

  const startTime = Date.now();

  try {
    // Transition to working
    await transitionState(taskId, "working");

    // Map A2A input to MCP args and call handler
    const mcpArgs = mapSkillInputToMcpArgs(skill, input);
    // The A2A path already ran its own approval flow before reaching here (the
    // task sat in auth_required until a human approved), so do not ask again.
    const result = await executeToolCall(skillDef.mcpTool, mcpArgs, auth, true);

    // Success
    await storeResult(taskId, result);
    await transitionState(taskId, "completed");

    // Audit
    await logAuditEvent({
      userId: auth.userId,
      clientId: auth.clientId,
      ipAddress: "",
      operation: "task.completed",
      taskId,
      skill,
      success: true,
      metadata: { duration_ms: Date.now() - startTime },
    });

    // Webhooks
    await queueWebhookDeliveries(taskId, "task.completed", {
      task_id: taskId,
      context_id: "",
      skill,
      state: "completed",
      result,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }, auth.clientId);

    return result;
  } catch (err: any) {
    // Check retry
    const task = await db.query(
      `SELECT retry_count, max_retries FROM a2a_tasks WHERE task_id = $1`,
      [taskId],
    );

    if (task.rows.length > 0) {
      const { retry_count, max_retries } = task.rows[0];
      if (retry_count < max_retries) {
        await db.query(
          `UPDATE a2a_tasks SET retry_count = retry_count + 1, updated_at = NOW() WHERE task_id = $1`,
          [taskId],
        );
        // For inline execution, we don't retry — just fail
      }
    }

    await storeError(taskId, { message: err.message, stack: err.stack });
    await transitionState(taskId, "failed", err.message);

    await logAuditEvent({
      userId: auth.userId,
      clientId: auth.clientId,
      ipAddress: "",
      operation: "task.failed",
      taskId,
      skill,
      success: false,
      errorMessage: err.message,
      metadata: { duration_ms: Date.now() - startTime },
    });

    await queueWebhookDeliveries(taskId, "task.failed", {
      task_id: taskId,
      context_id: "",
      skill,
      state: "failed",
      error: { message: err.message },
      created_at: new Date().toISOString(),
    }, auth.clientId);

    throw err;
  }
}

/**
 * Ask DharaHIL to approve one tool call and record it as this task's pending
 * approval.
 *
 * The upsert is not incidental: `a2a_approvals` holds one row per task, and a
 * resumed agent run can suspend again on a later call in the same turn. A plain
 * INSERT would throw there and leave the run parked with no live request.
 */
export async function requestApproval(params: {
  taskId: string;
  skill: string;
  toolName: string;
  toolArgs: Record<string, any>;
  userId: string;
  contextSummary: string;
}): Promise<void> {
  const { requestId, expiresAt } = await submitApproval(
    buildApprovalRequest({
      toolName: params.toolName,
      toolArgs: params.toolArgs,
      userId: params.userId,
      taskId: params.taskId,
      contextSummary: params.contextSummary,
    }),
  );

  await db.query(
    `INSERT INTO a2a_approvals (task_id, skill, request_data, dharahil_request_id, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (task_id) DO UPDATE SET
       skill = EXCLUDED.skill,
       request_data = EXCLUDED.request_data,
       dharahil_request_id = EXCLUDED.dharahil_request_id,
       expires_at = EXCLUDED.expires_at,
       status = 'pending',
       responded_at = NULL,
       responded_by = NULL`,
    [params.taskId, params.skill, JSON.stringify(params.toolArgs), requestId, expiresAt],
  );
}

/**
 * Settle an A2A task from one agent-loop outcome, and return the state it
 * ended in. The task must exist and still be in `submitted` — that holds both
 * for a fresh run and for a resumed one, which the poller moves back to
 * `submitted` when the human approves.
 *
 * The loop has already executed whatever it executed, each call through
 * `executeToolCall` with its own scope check, approval gate and audit entry.
 * Nothing here runs a tool.
 */
export async function settleAgentRun(
  taskId: string,
  contextId: string,
  result: AgentResult,
  auth: AuthContext,
): Promise<A2aTaskState> {
  const event = (state: A2aTaskState, extra: Record<string, any> = {}) =>
    queueWebhookDeliveries(
      taskId,
      state === "completed" ? "task.completed" : state === "failed" ? "task.failed" : "task.approval_required",
      { task_id: taskId, context_id: contextId, skill: AGENT_SKILL, state, ...extra, created_at: new Date().toISOString() },
      auth.clientId,
    );

  if (result.status === "needs_approval") {
    const { name, args } = result.toolCall;
    await transitionState(taskId, "auth_required", `Awaiting approval for ${name}`);
    try {
      await requestApproval({
        taskId,
        skill: AGENT_SKILL,
        toolName: name,
        toolArgs: args,
        userId: auth.userId,
        contextSummary: `TaskPilot agent wants to call ${name}`,
      });
    } catch (err: any) {
      // Same posture as the single-skill path: log and leave the task parked.
      // Failing closed strands the run; it never executes the write.
      console.error(`[a2a] Failed to submit approval for ${taskId}:`, err);
    }
    await event("auth_required");
    return "auth_required";
  }

  // Past this point the run is over either way, so the saved transcript is dead
  // weight. (A run that completed normally already cleared its own.)
  await clearRunState(taskId);

  if (result.status === "failed") {
    await storeError(taskId, { message: result.error });
    await transitionState(taskId, "failed", result.error);
    await event("failed", { error: { message: result.error } });
    return "failed";
  }

  await transitionState(taskId, "working");
  await storeResult(taskId, { answer: result.answer, toolsUsed: result.toolsUsed });

  // `stoppedEarly` is the only thing allowed to decide this. The answer text
  // says so too, but reading prose to set a state is how a run that merely
  // mentions a limit ends up marked failed.
  if (result.stoppedEarly) {
    await transitionState(taskId, "failed", "Agent stopped early: step or time limit reached");
    await event("failed", { result: { answer: result.answer, toolsUsed: result.toolsUsed } });
    return "failed";
  }

  await transitionState(taskId, "completed");
  await event("completed", { result: { answer: result.answer, toolsUsed: result.toolsUsed }, completed_at: new Date().toISOString() });
  return "completed";
}

/**
 * Get an A2A task by taskId.
 */
export async function getA2aTask(taskId: string): Promise<any | null> {
  const result = await db.query(
    `SELECT * FROM a2a_tasks WHERE task_id = $1`,
    [taskId],
  );
  return result.rows[0] || null;
}

/**
 * List A2A tasks by contextId.
 */
export async function listA2aTasks(contextId: string, clientId: string): Promise<any[]> {
  const result = await db.query(
    `SELECT * FROM a2a_tasks WHERE context_id = $1 AND client_id = $2 ORDER BY created_at DESC`,
    [contextId, clientId],
  );
  return result.rows;
}
