import crypto from "node:crypto";
import { db } from "../db.js";
import { executeToolCall } from "../tools/handlers.js";
import { getSkillDefinition } from "./skill-registry.js";
import { logAuditEvent } from "./audit-log.js";
import { queueWebhookDeliveries } from "./webhooks.js";
import { isValidTransition, isTerminalState } from "./types.js";
import type { A2aTaskState, AuthContext } from "./types.js";

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
