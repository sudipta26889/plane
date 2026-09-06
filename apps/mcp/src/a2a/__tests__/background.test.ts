import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The approval poller, with DharaHIL, the database and the agent loop all
 * stubbed. What is being checked here is the suspend/resume contract: an
 * approved agent run resumes from its saved state and never asks a second time
 * for the call the human already said yes to.
 */
const {
  runAgentMock,
  executeA2aTaskMock,
  submitApprovalMock,
  applyRevisionMock,
  runStates,
  taskStates,
  approvalStatuses,
  pollRows,
  decision,
} = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  executeA2aTaskMock: vi.fn(),
  submitApprovalMock: vi.fn(),
  applyRevisionMock: vi.fn(),
  runStates: new Map<string, any>(),
  taskStates: new Map<string, string>(),
  approvalStatuses: new Map<string, string>(),
  pollRows: [] as any[],
  decision: { body: {} as any },
}));

vi.mock("../../config.js", () => ({
  config: {
    dharahilEnabled: true,
    dharahilBaseUrl: "http://dharahil.test",
    dharahilApiKey: "test-key",
    dharahilTenantId: "t",
    dharahilAppId: "a",
    qdrantUrl: "",
    embeddingUrl: "",
  },
}));

vi.mock("../../db.js", () => ({
  db: {
    query: async (sql: string, params: any[] = []) => {
      if (sql.includes("FROM a2a_tasks t")) return { rows: pollRows };
      if (sql.includes("SELECT state FROM a2a_tasks")) return { rows: [{ state: taskStates.get(params[0]) }] };
      if (sql.includes("UPDATE a2a_tasks SET state = $2")) {
        taskStates.set(params[0], params[1]);
        return { rows: [] };
      }
      if (sql.includes("UPDATE a2a_approvals SET status")) {
        approvalStatuses.set(params[0], /status = '(\w+)'/.exec(sql)?.[1] ?? "?");
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO a2a_approvals")) {
        approvalStatuses.set(params[0], "pending");
        return { rows: [] };
      }
      return { rows: [] };
    },
  },
}));

vi.mock("../../agent/loop.js", () => ({ runAgent: runAgentMock }));
vi.mock("../../agent/state.js", () => ({
  loadRunState: async (taskId: string) => runStates.get(taskId) ?? null,
  saveRunState: async (taskId: string, state: any) => {
    runStates.set(taskId, state);
  },
  clearRunState: async (taskId: string) => {
    runStates.delete(taskId);
  },
}));
vi.mock("../audit-log.js", () => ({ logAuditEvent: async () => {} }));
vi.mock("../webhooks.js", () => ({ queueWebhookDeliveries: async () => {}, deliverWebhook: async () => ({ success: true }) }));
vi.mock("../sse.js", () => ({ sseManager: { notify: () => {} } }));
vi.mock("../../knowledge/index-sync.js", () => ({ syncWorkItems: async () => ({ embedded: 0, skipped: 0 }) }));
vi.mock("../../knowledge/embeddings.js", () => ({ embed: async () => [] }));
vi.mock("../dharahil.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dharahil.js")>()),
  submitApproval: submitApprovalMock,
  applyRevisionInstructions: applyRevisionMock,
}));
vi.mock("../task-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-executor.js")>()),
  executeA2aTask: executeA2aTaskMock,
}));

import { pollHitlDecisions } from "../background.js";

const PENDING_CALL = { id: "call_1", name: "bulk_cancel_tasks", args: { identifiers: ["WEB-1"] } };

const AGENT_TASK = {
  task_id: "task_agent",
  context_id: "ctx-1",
  skill: "agent.run",
  input: { text: "cancel WEB-1" },
  user_id: "user-1",
  workspace_slug: "acme",
  client_id: "peer_meetecho",
  dharahil_request_id: "req-1",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
};

const SKILL_TASK = { ...AGENT_TASK, task_id: "task_skill", skill: "task.bulk_cancel", input: { identifiers: ["WEB-1"] } };

beforeEach(() => {
  vi.clearAllMocks();
  runStates.clear();
  taskStates.clear();
  approvalStatuses.clear();
  pollRows.length = 0;
  decision.body = { status: "APPROVED", action: "APPROVED", approver: "sudipta" };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => decision.body })) as any);
  executeA2aTaskMock.mockResolvedValue({ ok: true });
  submitApprovalMock.mockResolvedValue({ requestId: "req-2", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollHitlDecisions — agent run resume", () => {
  it("resumes the loop from the saved state rather than re-dispatching a skill", async () => {
    pollRows.push(AGENT_TASK);
    taskStates.set(AGENT_TASK.task_id, "auth_required");
    runStates.set(AGENT_TASK.task_id, {
      messages: [{ role: "user", content: "cancel WEB-1" }],
      iteration: 1,
      pendingToolCall: PENDING_CALL,
    });
    runAgentMock.mockResolvedValue({ status: "completed", answer: "Cancelled WEB-1.", toolsUsed: ["bulk_cancel_tasks"] });

    await pollHitlDecisions();

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const call = runAgentMock.mock.calls[0][0];
    expect(call.taskId).toBe(AGENT_TASK.task_id);
    expect(call.contextId).toBe("ctx-1");
    // The approved call must reach the loop as resumeFrom, which is what makes
    // the loop run it pre-approved instead of gating it again.
    expect(call.resumeFrom.pendingToolCall).toEqual(PENDING_CALL);
    expect(executeA2aTaskMock).not.toHaveBeenCalled();
    expect(taskStates.get(AGENT_TASK.task_id)).toBe("completed");
  });

  it("does not open a second approval request for the call already approved", async () => {
    pollRows.push(AGENT_TASK);
    taskStates.set(AGENT_TASK.task_id, "auth_required");
    runStates.set(AGENT_TASK.task_id, { messages: [], iteration: 1, pendingToolCall: PENDING_CALL });
    runAgentMock.mockResolvedValue({ status: "completed", answer: "done", toolsUsed: ["bulk_cancel_tasks"] });

    await pollHitlDecisions();

    expect(submitApprovalMock).not.toHaveBeenCalled();
    expect(approvalStatuses.get(AGENT_TASK.task_id)).toBe("approved");
  });

  it("asks for a fresh approval when the resumed run suspends on a different call", async () => {
    pollRows.push(AGENT_TASK);
    taskStates.set(AGENT_TASK.task_id, "auth_required");
    runStates.set(AGENT_TASK.task_id, { messages: [], iteration: 1, pendingToolCall: PENDING_CALL });
    runAgentMock.mockResolvedValue({
      status: "needs_approval",
      toolCall: { id: "call_2", name: "page_archive", args: { page_id: "p1" } },
    });

    await pollHitlDecisions();

    expect(submitApprovalMock).toHaveBeenCalledTimes(1);
    expect(submitApprovalMock.mock.calls[0][0].tool_name).toBe("page_archive");
    expect(taskStates.get(AGENT_TASK.task_id)).toBe("auth_required");
    // The approval row has to go back to pending or the poller will never look
    // at this task again.
    expect(approvalStatuses.get(AGENT_TASK.task_id)).toBe("pending");
  });

  it("still dispatches the plain skill path when there is no saved run", async () => {
    pollRows.push(SKILL_TASK);
    taskStates.set(SKILL_TASK.task_id, "auth_required");

    await pollHitlDecisions();

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(executeA2aTaskMock).toHaveBeenCalledWith(
      SKILL_TASK.task_id,
      "task.bulk_cancel",
      { identifiers: ["WEB-1"] },
      expect.objectContaining({ userId: "user-1", clientId: "peer_meetecho" }),
    );
  });

  it("clears the saved run and rejects the task with the human's reason", async () => {
    pollRows.push(AGENT_TASK);
    taskStates.set(AGENT_TASK.task_id, "auth_required");
    runStates.set(AGENT_TASK.task_id, { messages: [], iteration: 1, pendingToolCall: PENDING_CALL });
    decision.body = { status: "DENIED", action: "DENIED", reason: "Wrong ticket" };

    await pollHitlDecisions();

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(runStates.has(AGENT_TASK.task_id)).toBe(false);
    expect(taskStates.get(AGENT_TASK.task_id)).toBe("rejected");
  });

  it("clears the saved run when the approval expires unanswered", async () => {
    pollRows.push({ ...AGENT_TASK, expires_at: new Date(Date.now() - 1000).toISOString() });
    taskStates.set(AGENT_TASK.task_id, "auth_required");
    runStates.set(AGENT_TASK.task_id, { messages: [], iteration: 1, pendingToolCall: PENDING_CALL });

    await pollHitlDecisions();

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(runStates.has(AGENT_TASK.task_id)).toBe(false);
    expect(taskStates.get(AGENT_TASK.task_id)).toBe("rejected");
  });

  it("applies a revision to the pending call and resumes with the revised args", async () => {
    pollRows.push(AGENT_TASK);
    taskStates.set(AGENT_TASK.task_id, "auth_required");
    runStates.set(AGENT_TASK.task_id, { messages: [], iteration: 1, pendingToolCall: PENDING_CALL });
    decision.body = { status: "REVISE_REQUESTED", action: "REVISE_REQUESTED", revise_input: "cancel WEB-2 instead" };
    applyRevisionMock.mockResolvedValue({ identifier: "WEB-2" });

    await pollHitlDecisions();

    // The revision was interpreted against the PENDING call, not the task input.
    expect(applyRevisionMock).toHaveBeenCalledWith(PENDING_CALL.name, PENDING_CALL.args, "cancel WEB-2 instead");

    // And the loop resumed carrying the revised arguments — what the human
    // actually approved — rather than the originals they rejected.
    expect(runAgentMock).toHaveBeenCalled();
    const resumed = runAgentMock.mock.calls[0][0].resumeFrom;
    expect(resumed.pendingToolCall.args).toEqual({ identifier: "WEB-2" });
    expect(resumed.pendingToolCall.id).toBe(PENDING_CALL.id);
  });

  it("rejects rather than executing the ORIGINAL args when a revision fails", async () => {
    // The originals are precisely what the human declined; falling through to
    // them would execute the thing the revision was meant to prevent.
    pollRows.push(AGENT_TASK);
    taskStates.set(AGENT_TASK.task_id, "auth_required");
    runStates.set(AGENT_TASK.task_id, { messages: [], iteration: 1, pendingToolCall: PENDING_CALL });
    decision.body = { status: "REVISE_REQUESTED", action: "REVISE_REQUESTED", revise_input: "something the model cannot parse" };
    applyRevisionMock.mockRejectedValue(new Error("could not interpret"));

    await pollHitlDecisions();

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(executeA2aTaskMock).not.toHaveBeenCalled();
    expect(runStates.has(AGENT_TASK.task_id)).toBe(false);
    expect(taskStates.get(AGENT_TASK.task_id)).toBe("rejected");
  });
});
