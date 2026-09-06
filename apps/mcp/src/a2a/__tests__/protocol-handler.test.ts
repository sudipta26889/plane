import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Nothing here reaches a network or a database. The agent loop, the intent
 * adapter and DharaHIL are all stubs, and `db` is a table-sized fake that
 * tracks only what the state machine reads back: one state per task.
 */
const { runAgentMock, resolveIntentMock, executeA2aTaskMock, submitApprovalMock, taskStates, taskRows } =
  vi.hoisted(() => ({
    runAgentMock: vi.fn(),
    resolveIntentMock: vi.fn(),
    executeA2aTaskMock: vi.fn(),
    submitApprovalMock: vi.fn(),
    taskStates: new Map<string, string>(),
    taskRows: [] as any[],
  }));

vi.mock("../../db.js", () => ({
  db: {
    query: async (sql: string, params: any[] = []) => {
      if (sql.includes("INSERT INTO a2a_tasks")) {
        taskStates.set(params[0], params[7]);
        taskRows.push({ taskId: params[0], skill: params[5], input: params[6], state: params[7] });
        return { rows: [] };
      }
      if (sql.includes("SELECT state FROM a2a_tasks")) {
        return { rows: [{ state: taskStates.get(params[0]) }] };
      }
      if (sql.includes("UPDATE a2a_tasks SET state = $2")) {
        taskStates.set(params[0], params[1]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  },
}));

vi.mock("../../agent/loop.js", () => ({ runAgent: runAgentMock }));
vi.mock("../intent.js", () => ({ resolveIntent: resolveIntentMock }));
vi.mock("../audit-log.js", () => ({ logAuditEvent: async () => {} }));
vi.mock("../webhooks.js", () => ({ queueWebhookDeliveries: async () => {} }));
vi.mock("../../agent/state.js", () => ({ clearRunState: async () => {} }));
vi.mock("../dharahil.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dharahil.js")>()),
  submitApproval: submitApprovalMock,
}));
// Only the executor is swapped: settleAgentRun and the state machine around it
// are the code under test.
vi.mock("../task-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-executor.js")>()),
  executeA2aTask: executeA2aTaskMock,
}));

import {
  validateJsonRpcRequest,
  canonicalMethod,
  normalizeMessageParams,
  extractMessageText,
  handleA2aRequest,
  A2A_METHODS,
} from "../protocol-handler.js";
import type { AuthContext } from "../types.js";

describe("extractMessageText", () => {
  it("joins every text part and ignores non-text parts", () => {
    expect(
      extractMessageText({ parts: [{ text: "one" }, { data: { skill: "x" } }, { text: "two" }] }),
    ).toBe("one\ntwo");
  });

  it("returns an empty string when there is no text", () => {
    expect(extractMessageText({ parts: [{ data: {} }] })).toBe("");
    expect(extractMessageText(undefined)).toBe("");
  });
});

describe("Protocol Handler", () => {
  it("validates a correct JSON-RPC request", () => {
    const result = validateJsonRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects missing jsonrpc field", () => {
    const result = validateJsonRpcRequest({ id: 1, method: "initialize" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("jsonrpc");
  });

  it("rejects wrong jsonrpc version", () => {
    const result = validateJsonRpcRequest({ jsonrpc: "1.0", id: 1, method: "test" });
    expect(result.valid).toBe(false);
  });

  it("rejects missing method", () => {
    const result = validateJsonRpcRequest({ jsonrpc: "2.0", id: 1 });
    expect(result.valid).toBe(false);
  });

  it("accepts spec-form method names as aliases", () => {
    expect(canonicalMethod("message/send")).toBe("message.send");
    expect(canonicalMethod("tasks/get")).toBe("task.get");
    expect(canonicalMethod("tasks/list")).toBe("task.list");
    expect(canonicalMethod("tasks/cancel")).toBe("task.cancel");
    expect(canonicalMethod("context/get")).toBe("context.get");
  });

  it("accepts A2A v1.0 gRPC method names", () => {
    // OpenClaw's built-in a2a channel sends these, not the slash form.
    expect(canonicalMethod("SendMessage")).toBe("message.send");
    expect(canonicalMethod("GetTask")).toBe("task.get");
    expect(canonicalMethod("ListTasks")).toBe("task.list");
    expect(canonicalMethod("CancelTask")).toBe("task.cancel");
    expect(canonicalMethod("GetAgentCard")).toBe("agent.getCard");
  });

  it("accepts the older tasks/send spelling", () => {
    expect(canonicalMethod("tasks/send")).toBe("message.send");
  });

  it("leaves dot-form and unknown methods alone", () => {
    expect(canonicalMethod("message.send")).toBe("message.send");
    expect(canonicalMethod("initialize")).toBe("initialize");
    expect(canonicalMethod("message/stream")).toBe("message/stream");
  });

  it("canonicalises the method on the validated body", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "message/send" };
    expect(validateJsonRpcRequest(body).valid).toBe(true);
    // Routing, rate limiting and dispatch all compare against the dot form.
    expect(body.method).toBe("message.send");
  });

  it("reads skill and input out of spec-form Message params", () => {
    const normalized = normalizeMessageParams({
      message: {
        kind: "message",
        messageId: "msg-1",
        contextId: "ctx-1",
        parts: [
          { kind: "text", text: "please create a task" },
          { kind: "data", data: { skill: "task.create", input: { title: "Fix login" } } },
        ],
      },
    });
    expect(normalized.contextId).toBe("ctx-1");
    expect(normalized.skill).toBe("task.create");
    expect(normalized.input).toEqual({ title: "Fix login" });
    expect(normalized.idempotencyKey).toBe("msg-1");
  });

  it("reads a v1.0 data part, which carries no kind tag", () => {
    // A2A v1.0 parts are bare {text} / {data}; v0.3 tags them with kind.
    const normalized = normalizeMessageParams({
      message: {
        messageId: "msg-2",
        role: "ROLE_USER",
        contextId: "ctx-oc-taskpilot",
        parts: [
          { text: "file this please" },
          { data: { skill: "task.create", input: { title: "Renew domain" } } },
        ],
      },
    });
    expect(normalized.skill).toBe("task.create");
    expect(normalized.input).toEqual({ title: "Renew domain" });
    expect(normalized.contextId).toBe("ctx-oc-taskpilot");
    expect(normalized.text).toBe("file this please");
  });

  it("surfaces free text when a message carries no skill", () => {
    // Text alone cannot name a skill, but the caller needs to see what arrived.
    const normalized = normalizeMessageParams({
      message: { messageId: "m", contextId: "c", parts: [{ text: "what is due today?" }] },
    });
    expect(normalized.skill).toBeUndefined();
    expect(normalized.text).toBe("what is due today?");
  });

  it("passes flat params through untouched", () => {
    const flat = { contextId: "ctx-1", skill: "task.get", input: { identifier: "WEB-1" } };
    expect(normalizeMessageParams(flat)).toBe(flat);
  });

  it("serves the agent card over JSON-RPC without auth", async () => {
    const response: any = await handleA2aRequest(
      { jsonrpc: "2.0", id: 1, method: "GetAgentCard" },
      null,
      "127.0.0.1",
    );
    expect(response.error).toBeUndefined();
    expect(response.result.name).toBe("TaskPilot");
    expect(response.result.supportedInterfaces?.[0]?.protocolBinding).toBe("JSONRPC");
  });

  it("defines all A2A methods", () => {
    expect(A2A_METHODS).toContain("initialize");
    expect(A2A_METHODS).toContain("message.send");
    expect(A2A_METHODS).toContain("task.get");
    expect(A2A_METHODS).toContain("task.list");
    expect(A2A_METHODS).toContain("task.cancel");
    expect(A2A_METHODS).toContain("context.get");
  });
});

describe("message.send free-text routing", () => {
  const AUTH: AuthContext = {
    userId: "user-1",
    workspaceSlug: "acme",
    clientId: "mcp_owner",
    scopes: ["taskpilot:read", "taskpilot:write"],
  };

  function send(params: any, id: number | string = 1) {
    return handleA2aRequest({ jsonrpc: "2.0", id, method: "message.send", params }, AUTH, "127.0.0.1") as Promise<any>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    taskStates.clear();
    taskRows.length = 0;
    submitApprovalMock.mockResolvedValue({ requestId: "req-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    executeA2aTaskMock.mockResolvedValue({ ok: true });
  });

  it("dispatches an explicit skill directly, never through the loop", async () => {
    const response = await send({ contextId: "ctx-1", skill: "task.get", input: { identifier: "WEB-1" } });

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(resolveIntentMock).not.toHaveBeenCalled();
    expect(executeA2aTaskMock).toHaveBeenCalledWith(
      expect.any(String),
      "task.get",
      { identifier: "WEB-1" },
      AUTH,
    );
    expect(response.result.state).toBe("completed");
  });

  it("sends free text to the agent loop and returns its answer", async () => {
    runAgentMock.mockResolvedValue({ status: "completed", answer: "Three tasks are due today.", toolsUsed: ["find_tasks"] });

    const response = await send({
      message: { messageId: "m1", contextId: "ctx-1", parts: [{ text: "what is due today?" }] },
    });

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "what is due today?", contextId: "ctx-1", auth: AUTH }),
    );
    expect(resolveIntentMock).not.toHaveBeenCalled();
    expect(response.result.state).toBe("completed");
    expect(response.result.result.answer).toBe("Three tasks are due today.");
    expect(taskStates.get(response.result.taskId)).toBe("completed");
  });

  it("fails the task on stoppedEarly, reading the flag and not the answer text", async () => {
    runAgentMock.mockResolvedValue({
      status: "completed",
      // Deliberately cheerful prose: only the flag may decide the state.
      answer: "All done, everything is finished.",
      toolsUsed: ["find_tasks"],
      stoppedEarly: true,
    });

    const response = await send({
      message: { messageId: "m2", contextId: "ctx-1", parts: [{ text: "do a lot of things" }] },
    });

    expect(response.result.state).toBe("failed");
    expect(taskStates.get(response.result.taskId)).toBe("failed");
  });

  it("completes a run whose answer merely mentions a limit", async () => {
    // The mirror of the test above: prose about limits must not fail a run
    // that finished.
    runAgentMock.mockResolvedValue({
      status: "completed",
      answer: "I hit the rate limit on the first try, then it worked.",
      toolsUsed: ["find_tasks"],
    });

    const response = await send({
      message: { messageId: "m3", contextId: "ctx-1", parts: [{ text: "retry that" }] },
    });

    expect(response.result.state).toBe("completed");
  });

  it("parks the task for approval when the loop suspends on a write", async () => {
    runAgentMock.mockResolvedValue({
      status: "needs_approval",
      toolCall: { id: "call_1", name: "bulk_cancel_tasks", args: { identifiers: ["WEB-1"] } },
    });

    const response = await send({
      message: { messageId: "m4", contextId: "ctx-1", parts: [{ text: "cancel WEB-1" }] },
    });

    expect(response.result.state).toBe("auth_required");
    expect(taskStates.get(response.result.taskId)).toBe("auth_required");
    expect(submitApprovalMock).toHaveBeenCalledTimes(1);
    expect(submitApprovalMock.mock.calls[0][0].tool_name).toBe("bulk_cancel_tasks");
  });

  it("falls back to the intent adapter when the loop never got off the ground", async () => {
    runAgentMock.mockResolvedValue({ status: "failed", error: "No LLM API key configured", toolsUsed: [] });
    resolveIntentMock.mockResolvedValue({ skill: "task.get", input: { identifier: "WEB-9" }, confidence: 0.9, reason: "" });

    const response = await send({
      message: { messageId: "m5", contextId: "ctx-1", parts: [{ text: "show me WEB-9" }] },
    });

    expect(resolveIntentMock).toHaveBeenCalledWith("show me WEB-9");
    expect(executeA2aTaskMock).toHaveBeenCalledWith(expect.any(String), "task.get", { identifier: "WEB-9" }, AUTH);
    expect(response.result.state).toBe("completed");
    // No phantom task for the run that never happened.
    expect(taskRows.filter((t) => t.skill === "agent.run")).toHaveLength(0);
  });

  it("does NOT fall back once the loop has already run tools", async () => {
    // Re-running the text through the single-shot adapter would repeat a write
    // the loop already performed.
    runAgentMock.mockResolvedValue({ status: "failed", error: "socket hang up", toolsUsed: ["create_task"] });

    const response = await send({
      message: { messageId: "m6", contextId: "ctx-1", parts: [{ text: "file a bug about login" }] },
    });

    expect(resolveIntentMock).not.toHaveBeenCalled();
    expect(executeA2aTaskMock).not.toHaveBeenCalled();
    expect(response.result.state).toBe("failed");
    expect(response.result.error.message).toBe("socket hang up");
  });
});
