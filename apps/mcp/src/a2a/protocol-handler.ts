import crypto from "node:crypto";
import { db } from "../db.js";
import { runAgent } from "../agent/loop.js";
import { getAllSkills, getSkillDefinition, requiresApproval } from "./skill-registry.js";
import {
  AGENT_SKILL,
  createA2aTask,
  executeA2aTask,
  getA2aTask,
  listA2aTasks,
  requestApproval,
  settleAgentRun,
  transitionState,
} from "./task-executor.js";
import { logAuditEvent } from "./audit-log.js";
import { queueWebhookDeliveries } from "./webhooks.js";
import { hasRequiredScope } from "./auth.js";
import { buildAgentCard } from "./agent-card.js";
import { resolveIntent } from "./intent.js";
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
  let { contextId, skill, input } = params;
  const { idempotencyKey } = params;

  // Checked before anything else now, not just before dispatch: an agent run
  // costs model calls, and a client's retry must not buy a second one.
  if (idempotencyKey) {
    const existing = await db.query(
      `SELECT * FROM a2a_tasks WHERE idempotency_key = $1 AND client_id = $2`,
      [idempotencyKey, auth.clientId],
    );
    if (existing.rows.length > 0) {
      const task = existing.rows[0];
      return jsonRpcResult(body.id, { taskId: task.task_id, state: task.state, result: task.result });
    }
  }

  // Free text goes to the ReAct loop, which can chain tool calls — look an item
  // up, then act on it. An explicit skill never comes through here: that path
  // is exact and callers depend on it.
  if (!skill && params.text && contextId) {
    // The task row is written only once the run's outcome is known. That is
    // what lets a loop which never got off the ground fall through to the
    // intent adapter without stranding a phantom task behind it.
    const taskId = `task_${crypto.randomUUID()}`;
    const result = await runAgent({ text: params.text, contextId, auth, taskId });

    // Fall back only while nothing has run. Once the loop has executed a tool,
    // re-running the same text through the single-shot adapter would repeat
    // that write — losing a feature is better than doing one twice.
    if (result.status === "failed" && result.toolsUsed.length === 0) {
      console.warn(`[agent] loop unavailable (${result.error}); falling back to the intent adapter`);
    } else {
      await createA2aTask({
        taskId,
        contextId,
        clientId: auth.clientId,
        userId: auth.userId,
        workspaceSlug: auth.workspaceSlug,
        skill: AGENT_SKILL,
        input: { text: params.text },
        requiresApproval: result.status === "needs_approval",
        idempotencyKey,
      });

      const state = await settleAgentRun(taskId, contextId, result, auth);

      await logAuditEvent({
        userId: auth.userId,
        clientId: auth.clientId,
        ipAddress,
        operation: "message.send",
        taskId,
        skill: AGENT_SKILL,
        success: state === "completed",
        ...(result.status === "failed" ? { errorMessage: result.error } : {}),
        metadata: { agent: true, state },
      });

      return jsonRpcResult(body.id, {
        taskId,
        state,
        ...(result.status === "completed"
          ? { result: { answer: result.answer, toolsUsed: result.toolsUsed } }
          : {}),
        ...(result.status === "failed" ? { error: { message: result.error } } : {}),
      });
    }
  }

  // Peers that can only send free text (OpenClaw's built-in channel) name no
  // skill. Ask the LLM which one they meant; it returns null when unsure, and
  // we then refuse below rather than act on a guess.
  if (!skill && params.text) {
    const intent = await resolveIntent(params.text);
    if (intent) {
      skill = intent.skill;
      input = intent.input;
      console.log(`[intent] "${String(params.text).slice(0, 60)}" -> ${intent.skill}`);
    }
  }

  if (!skill || !contextId) {
    // Two different failures reach here. Text that no skill matched is the
    // adapter declining; no text at all is a malformed send. Saying "add a data
    // part" for the first would be misleading advice.
    // A resolved skill with no contextId is neither of those: it is a caller
    // that sent usable text but no conversation to attach it to, and blaming
    // intent resolution for it sends the reader looking in the wrong place.
    const message = skill && !contextId
      ? `Resolved the action "${skill}" but no contextId was supplied. Send a contextId so the request can be attached to a conversation.`
      : params.text
      ? `Could not determine which TaskPilot action you meant from: "${String(params.text).slice(0, 80)}". Rephrase as a specific request (create, find, update, assign, comment, cancel), or send a data part carrying { skill, input }.`
      : "Missing required params: skill, contextId. Send either a flat { contextId, skill, input }, or a message whose parts include text or a data part carrying { skill, input }.";
    return jsonRpcError(body.id, A2A_ERROR_CODES.INVALID_PARAMS, message);
  }

  const skillDef = getSkillDefinition(skill);
  if (!skillDef) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.METHOD_NOT_FOUND, `Unknown skill: ${skill}`);
  }

  if (!hasRequiredScope(auth.scopes, skillDef.scope)) {
    return jsonRpcError(body.id, A2A_ERROR_CODES.AUTH_REQUIRED, `Missing required scope: ${skillDef.scope}`);
  }

  const taskInput = input || {};

  if (requiresApproval(skill, taskInput, auth.clientId)) {
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
      await requestApproval({
        taskId,
        skill,
        toolName: skillDef.mcpTool,
        toolArgs: taskInput,
        userId: auth.userId,
        contextSummary: `A2A ${skill} request`,
      });
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
