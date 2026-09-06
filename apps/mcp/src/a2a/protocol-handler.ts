import { db } from "../db.js";
import { getAllSkills, getSkillDefinition, requiresApproval } from "./skill-registry.js";
import {
  createA2aTask,
  executeA2aTask,
  getA2aTask,
  listA2aTasks,
  transitionState,
} from "./task-executor.js";
import { buildApprovalRequest, submitApproval } from "./dharahil.js";
import { logAuditEvent } from "./audit-log.js";
import { queueWebhookDeliveries } from "./webhooks.js";
import { hasRequiredScope } from "./auth.js";
import { buildAgentCard } from "./agent-card.js";
import { config } from "../config.js";
import { isTerminalState, A2A_ERROR_CODES } from "./types.js";
import type { AuthContext } from "./types.js";

export const A2A_METHODS = [
  "initialize",
  "message.send",
  "task.get",
  "task.list",
  "task.cancel",
  "context.get",
  "agent.getCard",
] as const;

export type A2aMethod = (typeof A2A_METHODS)[number];

// This server has always dispatched on the dot form. Real clients use two other
// spellings: A2A v0.3 JSON-RPC uses slashes and a plural `tasks`, while A2A v1.0
// (OpenClaw's built-in channel) uses the gRPC service method names. Without
// these aliases both get METHOD_NOT_FOUND.
const METHOD_ALIASES: Record<string, A2aMethod> = {
  // A2A v0.3 JSON-RPC
  "message/send": "message.send",
  "tasks/get": "task.get",
  "tasks/list": "task.list",
  "tasks/cancel": "task.cancel",
  "context/get": "context.get",
  // A2A v0.2 spelling, still emitted by some clients
  "tasks/send": "message.send",
  // A2A v1.0 gRPC method names
  SendMessage: "message.send",
  GetTask: "task.get",
  ListTasks: "task.list",
  CancelTask: "task.cancel",
  GetAgentCard: "agent.getCard",
  "agent/getAuthenticatedExtendedCard": "agent.getCard",
};

export function canonicalMethod(method: string): string {
  return METHOD_ALIASES[method] ?? method;
}

export function validateJsonRpcRequest(body: any): { valid: boolean; error?: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be an object" };
  }

  if (!body.jsonrpc) {
    return { valid: false, error: "Missing required field: jsonrpc" };
  }

  if (body.jsonrpc !== "2.0") {
    return { valid: false, error: "jsonrpc must be \"2.0\"" };
  }

  if (!body.method || typeof body.method !== "string") {
    return { valid: false, error: "Missing required field: method" };
  }

  // Canonicalise in place. Validation runs first on every entry path (route and
  // handler), so every downstream comparison only ever sees the dot form.
  body.method = canonicalMethod(body.method);

  return { valid: true };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: any) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function jsonRpcResult(id: string | number, result: any) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result,
  };
}

// --- Method handlers ---

function handleInitialize(body: any) {
  const skills = getAllSkills().map((s) => ({ name: s.name, description: s.description }));
  return jsonRpcResult(body.id, {
    protocolVersion: "0.3",
    name: "TaskPilot",
    capabilities: { streaming: true, webhooks: true, humanInTheLoop: true },
    skills,
  });
}

/** Free text carried by a Message, joined across all its text parts. */
export function extractMessageText(message: any): string {
  const parts: any[] = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

// Spec-form message sends wrap everything in a Message object; ours takes a flat
// { contextId, skill, input }. Accept both, and both part shapes: A2A v0.3 tags
// parts with `kind: "data"`, while v1.0 just carries a `data` key. The skill
// rides in that data part because free text alone cannot name a skill.
export function normalizeMessageParams(params: any) {
  const message = params?.message;
  if (!message || params.skill) return params ?? {};

  const parts: any[] = Array.isArray(message.parts) ? message.parts : [];
  const data = parts.find((part) => part?.kind === "data" || part?.data)?.data ?? {};

  return {
    contextId: message.contextId ?? params.contextId,
    skill: data.skill,
    input: data.input ?? {},
    // messageId is stable across a client's retries, which is what we want here.
    idempotencyKey: params.idempotencyKey ?? message.messageId,
    text: extractMessageText(message),
  };
}

function handleGetAgentCard(body: any) {
  // The card is already public over GET /.well-known/agent-card.json, so
  // serving it here needs no auth either.
  return jsonRpcResult(body.id, buildAgentCard(config.baseUrl));
}

async function handleMessageSend(body: any, auth: AuthContext, ipAddress: string) {
  const params = normalizeMessageParams(body.params || {});
  const { contextId, skill, input, idempotencyKey } = params;

  if (!skill || !contextId) {
    const received = params.text
      ? ` Received free text with no skill: "${String(params.text).slice(0, 80)}".`
      : "";
    return jsonRpcError(
      body.id,
      A2A_ERROR_CODES.INVALID_PARAMS,
      `Missing required params: skill, contextId. Spec-form senders must include a data part carrying { skill, input } alongside any text part.${received}`,
    );
  }

  const skillDef = getSkillDefinition(skill);
  if (!skillDef) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.METHOD_NOT_FOUND, `Unknown skill: ${skill}`);
  }

  if (!hasRequiredScope(auth.scopes, skillDef.scope)) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.AUTH_REQUIRED, `Missing required scope: ${skillDef.scope}`);
  }

  // Idempotency check
  if (idempotencyKey) {
    const existing = await db.query(
      `SELECT * FROM a2a_tasks WHERE idempotency_key = $1 AND client_id = $2`,
      [idempotencyKey, auth.clientId],
    );
    if (existing.rows.length > 0) {
      const task = existing.rows[0];
      return jsonRpcResult(body.id, {
        taskId: task.task_id,
        state: task.state,
        result: task.result,
      });
    }
  }

  const taskInput = input || {};

  if (requiresApproval(skill, taskInput)) {
    // Create task in auth_required state
    const taskId = await createA2aTask({
      contextId,
      clientId: auth.clientId,
      userId: auth.userId,
      workspaceSlug: auth.workspaceSlug,
      skill,
      input: taskInput,
      state: "auth_required",
      requiresApproval: true,
      idempotencyKey,
    });

    // Submit approval request
    try {
      const approvalRequest = buildApprovalRequest({
        toolName: skillDef.mcpTool,
        toolArgs: taskInput,
        userId: auth.userId,
        taskId,
        contextSummary: `A2A ${skill} request`,
      });
      const { requestId, expiresAt } = await submitApproval(approvalRequest);

      // Save approval record
      await db.query(
        `INSERT INTO a2a_approvals (task_id, skill, request_data, dharahil_request_id, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [taskId, skill, JSON.stringify(taskInput), requestId, expiresAt],
      );
    } catch (err: any) {
      console.error("[a2a] Failed to submit approval:", err);
    }

    // Audit & webhooks
    await logAuditEvent({
      userId: auth.userId,
      clientId: auth.clientId,
      ipAddress,
      operation: "message.send",
      taskId,
      skill,
      success: true,
      metadata: { requires_approval: true },
    });

    await queueWebhookDeliveries(taskId, "task.approval_required", {
      task_id: taskId,
      context_id: contextId,
      skill,
      state: "auth_required",
      created_at: new Date().toISOString(),
    }, auth.clientId);

    return jsonRpcResult(body.id, {
      taskId,
      state: "auth_required",
    });
  }

  // No approval needed — create and execute inline
  const taskId = await createA2aTask({
    contextId,
    clientId: auth.clientId,
    userId: auth.userId,
    workspaceSlug: auth.workspaceSlug,
    skill,
    input: taskInput,
    idempotencyKey,
  });

  try {
    const result = await executeA2aTask(taskId, skill, taskInput, auth);

    await logAuditEvent({
      userId: auth.userId,
      clientId: auth.clientId,
      ipAddress,
      operation: "message.send",
      taskId,
      skill,
      success: true,
    });

    return jsonRpcResult(body.id, {
      taskId,
      state: "completed",
      result,
    });
  } catch (err: any) {
    await logAuditEvent({
      userId: auth.userId,
      clientId: auth.clientId,
      ipAddress,
      operation: "message.send",
      taskId,
      skill,
      success: false,
      errorMessage: err.message,
    });

    return jsonRpcResult(body.id, {
      taskId,
      state: "failed",
      error: { message: err.message },
    });
  }
}

async function handleTaskGet(body: any, auth: AuthContext) {
  const params = body.params || {};
  const { taskId } = params;

  if (!taskId) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.INVALID_PARAMS, "Missing required param: taskId");
  }

  const task = await getA2aTask(taskId);
  if (!task) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.INVALID_PARAMS, `Task not found: ${taskId}`);
  }

  if (task.client_id !== auth.clientId) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.AUTH_REQUIRED, "Task does not belong to this client");
  }

  return jsonRpcResult(body.id, {
    taskId: task.task_id,
    contextId: task.context_id,
    skill: task.skill,
    state: task.state,
    stateReason: task.state_reason,
    result: task.result,
    error: task.error,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    completedAt: task.completed_at,
  });
}

async function handleTaskList(body: any, auth: AuthContext) {
  const params = body.params || {};
  const { contextId } = params;

  if (!contextId) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.INVALID_PARAMS, "Missing required param: contextId");
  }

  const tasks = await listA2aTasks(contextId, auth.clientId);
  return jsonRpcResult(body.id, {
    tasks: tasks.map((t) => ({
      taskId: t.task_id,
      contextId: t.context_id,
      skill: t.skill,
      state: t.state,
      stateReason: t.state_reason,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      completedAt: t.completed_at,
    })),
  });
}

async function handleTaskCancel(body: any, auth: AuthContext, ipAddress: string) {
  const params = body.params || {};
  const { taskId } = params;

  if (!taskId) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.INVALID_PARAMS, "Missing required param: taskId");
  }

  const task = await getA2aTask(taskId);
  if (!task) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.INVALID_PARAMS, `Task not found: ${taskId}`);
  }

  if (task.client_id !== auth.clientId) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.AUTH_REQUIRED, "Task does not belong to this client");
  }

  if (isTerminalState(task.state)) {
    return jsonRpcResult(body.id, {
      taskId: task.task_id,
      state: task.state,
      message: "Task is already in a terminal state",
    });
  }

  await transitionState(taskId, "canceled", "Client-initiated cancellation");

  await logAuditEvent({
    userId: auth.userId,
    clientId: auth.clientId,
    ipAddress,
    operation: "task.cancel",
    taskId,
    skill: task.skill,
    success: true,
  });

  await queueWebhookDeliveries(taskId, "task.canceled", {
    task_id: taskId,
    context_id: task.context_id,
    skill: task.skill,
    state: "canceled",
    created_at: task.created_at?.toISOString?.() || new Date().toISOString(),
  }, auth.clientId);

  return jsonRpcResult(body.id, {
    taskId: task.task_id,
    state: "canceled",
  });
}

async function handleContextGet(body: any, auth: AuthContext) {
  return handleTaskList(body, auth);
}

// --- Main dispatch ---

export async function handleA2aRequest(
  body: any,
  auth: AuthContext | null,
  ipAddress: string,
): Promise<any> {
  const validation = validateJsonRpcRequest(body);
  if (!validation.valid) {
    return jsonRpcError(body?.id ?? null, A2A_ERROR_CODES.INVALID_REQUEST, validation.error!);
  }

  const method = body.method as string;

  // Neither initialize nor the agent card requires auth.
  if (method === "initialize" || method === "agent.getCard") {
    try {
      return method === "agent.getCard" ? handleGetAgentCard(body) : handleInitialize(body);
    } catch (err: any) {
      return jsonRpcError(body.id, A2A_ERROR_CODES.INTERNAL_ERROR, err.message);
    }
  }

  // All other methods require auth
  if (!auth) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.AUTH_REQUIRED, "Authentication required");
  }

  try {
    switch (method) {
      case "message.send":
        return await handleMessageSend(body, auth, ipAddress);
      case "task.get":
        return await handleTaskGet(body, auth);
      case "task.list":
        return await handleTaskList(body, auth);
      case "task.cancel":
        return await handleTaskCancel(body, auth, ipAddress);
      case "context.get":
        return await handleContextGet(body, auth);
      default:
        return jsonRpcError(body.id, A2A_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  } catch (err: any) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.INTERNAL_ERROR, err.message);
  }
}
