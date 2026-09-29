import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The whole approval-gated write lifecycle, end to end: message.send ->
 * auth_required -> DharaHIL decision -> the approval worker resumes the SAME
 * task -> exactly one terminal state, read back through task.get.
 *
 * The protocol handler, executor, state machine and approval worker are the
 * real code. Only DharaHIL, the tool call itself and the network are stubbed,
 * and `db` is an in-memory stand-in for the three tables they touch — faithful
 * where it matters: the compare-and-set on state, the conditional approval
 * claim, and the unique (client_id, idempotency_key) index.
 */
const h = vi.hoisted(() => ({
  tasks: new Map<string, any>(),
  approvals: new Map<string, any>(),
  decisions: new Map<string, any>(),
  toolCalls: [] as { name: string; args: any }[],
  toolResult: { value: undefined as any, error: null as Error | null },
  precheck: { value: {} as any },
  submitApproval: { fail: null as Error | null, count: 0 },
  webhooks: [] as { event: string; payload: any }[],
  logs: [] as string[],
}));

vi.mock("../../config.js", () => ({
  config: {
    dharahilEnabled: true,
    dharahilBaseUrl: "http://dharahil.test",
    dharahilApiKey: "k",
    dharahilTenantId: "t",
    dharahilAppId: "a",
    baseUrl: "http://mcp.test",
    qdrantUrl: "",
    embeddingUrl: "",
  },
}));

function row(taskId: string) {
  return h.tasks.get(taskId);
}

vi.mock("../../db.js", () => ({
  db: {
    query: async (sql: string, p: any[] = []) => {
      const q = sql.replace(/\s+/g, " ");
      if (q.startsWith("INSERT INTO a2a_tasks")) {
        const [task_id, context_id, client_id, user_id, workspace_slug, skill, input, state, requires_approval, idempotency_key] = p;
        if (idempotency_key && [...h.tasks.values()].some((t) => t.client_id === client_id && t.idempotency_key === idempotency_key)) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        }
        h.tasks.set(task_id, {
          task_id, context_id, client_id, user_id, workspace_slug, skill,
          input: JSON.parse(input), state, requires_approval, idempotency_key,
          state_reason: null, result: null, error: null, created_at: new Date(), updated_at: new Date(), completed_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("INSERT INTO a2a_task_history")) return { rows: [], rowCount: 1 };
      if (q.startsWith("SELECT state FROM a2a_tasks")) return { rows: row(p[0]) ? [{ state: row(p[0]).state }] : [] };
      if (q.startsWith("UPDATE a2a_tasks SET state = $2")) {
        const t = row(p[0]);
        if (!t || t.state !== p[2]) return { rows: [], rowCount: 0 };
        Object.assign(t, { state: p[1], state_reason: p[3], updated_at: new Date() });
        if (q.includes("completed_at")) t.completed_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE a2a_tasks SET result")) { row(p[0]).result = JSON.parse(p[1]); return { rows: [], rowCount: 1 }; }
      if (q.startsWith("UPDATE a2a_tasks SET error")) { row(p[0]).error = JSON.parse(p[1]); return { rows: [], rowCount: 1 }; }
      if (q.startsWith("SELECT retry_count")) return { rows: [{ retry_count: 0, max_retries: 3 }] };
      if (q.startsWith("UPDATE a2a_tasks SET retry_count")) return { rows: [], rowCount: 1 };
      if (q.startsWith("SELECT * FROM a2a_tasks WHERE task_id")) return { rows: row(p[0]) ? [row(p[0])] : [] };
      if (q.startsWith("SELECT * FROM a2a_tasks WHERE idempotency_key")) {
        return { rows: [...h.tasks.values()].filter((t) => t.idempotency_key === p[0] && t.client_id === p[1]) };
      }
      if (q.startsWith("INSERT INTO a2a_approvals")) {
        h.approvals.set(p[0], { task_id: p[0], dharahil_request_id: p[3], expires_at: p[4], status: "pending", responded_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("SELECT dharahil_request_id")) return { rows: h.approvals.has(p[0]) ? [h.approvals.get(p[0])] : [] };
      if (q.includes("JOIN a2a_approvals a ON t.task_id = a.task_id")) {
        return {
          rows: [...h.tasks.values()]
            .filter((t) => t.state === "auth_required" && h.approvals.get(t.task_id)?.status === "pending")
            .map((t) => ({ ...t, ...h.approvals.get(t.task_id) })),
        };
      }
      if (q.startsWith("UPDATE a2a_approvals SET status")) {
        const a = h.approvals.get(p[0]);
        if (!a || (q.includes("AND status = 'pending'") && a.status !== "pending")) return { rows: [], rowCount: 0 };
        a.status = /status = '(\w+)'/.exec(q)![1];
        return { rows: [], rowCount: 1 };
      }
      if (q.includes("LEFT JOIN a2a_approvals")) {
        return {
          rows: [...h.tasks.values()]
            .filter((t) => (t.state === "auth_required" && !h.approvals.has(t.task_id)) || ["submitted", "working"].includes(t.state))
            .filter((t) => t.updated_at < new Date(Date.now() - 10 * 60 * 1000)),
        };
      }
      return { rows: [], rowCount: 0 };
    },
  },
}));

vi.mock("../../tools/handlers.js", () => ({
  executeToolCall: async (name: string, args: any) => {
    h.toolCalls.push({ name, args });
    if (h.toolResult.error) throw h.toolResult.error;
    return h.toolResult.value;
  },
  precheckToolCall: async () => h.precheck.value,
}));
vi.mock("../dharahil.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dharahil.js")>()),
  submitApproval: async () => {
    h.submitApproval.count++;
    if (h.submitApproval.fail) throw h.submitApproval.fail;
    return { requestId: `req-${h.submitApproval.count}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  },
}));
vi.mock("../webhooks.js", () => ({
  queueWebhookDeliveries: async (_taskId: string, event: string, payload: any) => { h.webhooks.push({ event, payload }); },
  deliverWebhook: async () => ({ success: true }),
}));
vi.mock("../audit-log.js", () => ({ logAuditEvent: async () => {} }));
vi.mock("../sse.js", () => ({ sseManager: { notify: () => {} } }));
vi.mock("../intent.js", () => ({ resolveIntent: async () => null }));
vi.mock("../../agent/loop.js", () => ({ runAgent: vi.fn() }));
vi.mock("../../agent/state.js", () => ({ loadRunState: async () => null, saveRunState: async () => {}, clearRunState: async () => {} }));
vi.mock("../../agent/mqtt.js", () => ({ publish: async () => {}, TOPIC: {} }));
vi.mock("../../knowledge/index-sync.js", () => ({ syncWorkItems: async () => ({}), syncPages: async () => ({}) }));
vi.mock("../../knowledge/embeddings.js", () => ({ embed: async () => [] }));

import { handleA2aRequest } from "../protocol-handler.js";
import { pollHitlDecisions, failStrandedTasks } from "../background.js";
import { A2A_ERROR_CODES } from "../types.js";
import type { AuthContext } from "../types.js";

const peer: AuthContext = { userId: "u1", workspaceSlug: "ws", clientId: "peer_mitra", scopes: ["taskpilot:read", "taskpilot:write"] };
const TITLE = "Verify GuardianAI TaskPilot A2A write lifecycle";

let rpcId = 0;
function send(input: any, opts: { skill?: string; messageId?: string; auth?: AuthContext; contextId?: string } = {}) {
  return handleA2aRequest(
    {
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "SendMessage",
      params: {
        message: {
          contextId: opts.contextId ?? "ctx-canary",
          ...(opts.messageId ? { messageId: opts.messageId } : {}),
          parts: [{ data: { skill: opts.skill ?? "task.create", input } }],
        },
      },
    },
    opts.auth ?? peer,
    "127.0.0.1",
  );
}

const getTask = (taskId: string, auth: AuthContext = peer) =>
  handleA2aRequest({ jsonrpc: "2.0", id: ++rpcId, method: "tasks/get", params: { taskId } }, auth, "127.0.0.1");

/** DharaHIL answers `status` for every outstanding request. */
function decide(status: string, extra: Record<string, any> = {}) {
  vi.stubGlobal("fetch", async (url: string) => ({
    ok: true,
    json: async () => ({ request_id: String(url).split("/").pop(), status, action: status, ...extra }),
  }));
}

beforeEach(() => {
  h.tasks.clear();
  h.approvals.clear();
  h.toolCalls.length = 0;
  h.webhooks.length = 0;
  h.toolResult.value = { id: "issue-1", identifier: "GUARDIANAI-7", project: "GuardianAI" };
  h.toolResult.error = null;
  h.precheck.value = { project: { id: "p-guard", identifier: "GUARDIANAI", name: "GuardianAI" } };
  h.submitApproval.fail = null;
  h.submitApproval.count = 0;
  decide("PENDING");
});

describe("approval-gated write lifecycle", () => {
  it("parks a peer write in auth_required, names the approval, and writes nothing yet", async () => {
    const res = await send({ title: TITLE, project_hint: "GUARDIANAI" });

    expect(res.result.state).toBe("auth_required");
    expect(res.result.taskId).toMatch(/^task_/);
    expect(res.result.contextId).toBe("ctx-canary");
    expect(res.result.approval).toMatchObject({ id: "req-1", status: "pending" });
    expect(res.result.project.identifier).toBe("GUARDIANAI");
    // Tells the caller what to do, and that it is not a credentials problem.
    expect(res.result.message).toMatch(/NOT an authentication error/);
    expect(res.result.message).toMatch(/tasks\/get/);
    expect(h.toolCalls).toHaveLength(0);
  });

  it("resumes the same task on approval and completes it exactly once", async () => {
    const { result: sent } = await send({ title: TITLE, project_hint: "GUARDIANAI" });
    decide("APPROVED");

    await pollHitlDecisions();
    // A second tick — or a duplicate approval callback — sees the same approval.
    await pollHitlDecisions();

    expect(h.toolCalls).toHaveLength(1);
    expect(h.toolCalls[0]).toEqual({ name: "create_task", args: { title: TITLE, project_hint: "GUARDIANAI" } });

    const { result: got } = await getTask(sent.taskId);
    expect(got.taskId).toBe(sent.taskId);
    expect(got.state).toBe("completed");
    expect(got.result.identifier).toBe("GUARDIANAI-7");
    expect(got.approval.status).toBe("approved");
    expect(got.stateReason).toBeNull();
    expect(h.webhooks.find((w) => w.event === "task.completed")?.payload.context_id).toBe("ctx-canary");
  });

  it("runs the write once when two workers race on the same approval", async () => {
    const { result: sent } = await send({ title: TITLE });
    decide("APPROVED");

    // Two independent workers (two processes, or an overlapping tick), each
    // with its own in-memory state. Only the database arbitrates between them.
    vi.resetModules();
    const a = await import("../background.js");
    vi.resetModules();
    const b = await import("../background.js");
    await Promise.all([a.pollHitlDecisions(), b.pollHitlDecisions()]);

    expect(h.toolCalls).toHaveLength(1);
    expect((await getTask(sent.taskId)).result.state).toBe("completed");
  });

  it("ends rejected when the human rejects, and never writes", async () => {
    const { result: sent } = await send({ title: TITLE });
    decide("REJECTED", { reason: "not now" });

    await pollHitlDecisions();

    const { result: got } = await getTask(sent.taskId);
    expect(got.state).toBe("rejected");
    expect(got.stateReason).toBe("not now");
    expect(h.toolCalls).toHaveLength(0);
    expect(h.webhooks.some((w) => w.event === "task.rejected")).toBe(true);
  });

  it("ends rejected when the approval times out", async () => {
    const { result: sent } = await send({ title: TITLE });
    h.approvals.get(sent.taskId).expires_at = new Date(Date.now() - 1000).toISOString();

    await pollHitlDecisions();

    expect((await getTask(sent.taskId)).result.state).toBe("rejected");
    expect(h.toolCalls).toHaveLength(0);
  });

  it("ends failed when the approved write throws", async () => {
    const { result: sent } = await send({ title: TITLE });
    h.toolResult.error = new Error("TaskPilot API error 500");
    decide("APPROVED");

    await pollHitlDecisions();

    const { result: got } = await getTask(sent.taskId);
    expect(got.state).toBe("failed");
    expect(got.error).toEqual({ message: "TaskPilot API error 500" });
  });

  it("ends failed, not completed, when the approved handler wrote nothing", async () => {
    const { result: sent } = await send({ title: TITLE });
    h.toolResult.value = { status: "possible_duplicate", duplicate_of: "GUARDIANAI-1", hint: "pass force_create" };
    decide("APPROVED");

    await pollHitlDecisions();

    const { result: got } = await getTask(sent.taskId);
    expect(got.state).toBe("failed");
    expect(got.error.message).toMatch(/Nothing was written: possible duplicate of GUARDIANAI-1/);
  });

  it("survives a restart while approval is pending: a fresh worker finishes the task", async () => {
    const { result: sent } = await send({ title: TITLE });

    // Everything the worker needs is in the database, none of it in memory.
    vi.resetModules();
    const fresh = await import("../background.js");
    decide("APPROVED");
    await fresh.pollHitlDecisions();

    expect((await getTask(sent.taskId)).result.state).toBe("completed");
    expect(h.toolCalls).toHaveLength(1);
  });

  it("fails a task whose approval request could not be opened, instead of stranding it", async () => {
    h.submitApproval.fail = new Error("DharaHIL gateway error: 502");

    const res = await send({ title: TITLE });

    expect(res.result.state).toBe("failed");
    expect(res.result.error.message).toMatch(/Could not open the human approval request/);
    expect((await getTask(res.result.taskId)).result.state).toBe("failed");
  });

  it("sweeps up tasks stranded before this fix", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    h.tasks.set("task_orphan", { task_id: "task_orphan", client_id: "peer_mitra", state: "auth_required", updated_at: old });
    h.tasks.set("task_hung", { task_id: "task_hung", client_id: "peer_mitra", state: "working", updated_at: old });

    await failStrandedTasks();

    expect(h.tasks.get("task_orphan").state).toBe("failed");
    expect(h.tasks.get("task_hung").state).toBe("failed");
    expect(h.tasks.get("task_hung").state_reason).toMatch(/may or may not have happened/);
  });
});

describe("idempotency", () => {
  it("returns the original task for a repeated messageId, without a second approval request", async () => {
    const first = await send({ title: TITLE }, { messageId: "msg-1" });
    const again = await send({ title: TITLE }, { messageId: "msg-1" });

    expect(again.result.taskId).toBe(first.result.taskId);
    expect(again.result.replayed).toBe(true);
    expect(again.result.approval.id).toBe("req-1");
    expect(h.submitApproval.count).toBe(1);
    expect(h.tasks.size).toBe(1);
  });

  it("deduplicates an identical write even when the caller sent no messageId", async () => {
    const first = await send({ title: TITLE, project_hint: "GUARDIANAI" });
    const again = await send({ project_hint: "GUARDIANAI", title: TITLE });

    expect(again.result.taskId).toBe(first.result.taskId);
    expect(h.tasks.size).toBe(1);
  });

  it("replaying after completion returns the result and does not write again", async () => {
    const { result: sent } = await send({ title: TITLE }, { messageId: "msg-2" });
    decide("APPROVED");
    await pollHitlDecisions();

    const again = await send({ title: TITLE }, { messageId: "msg-2" });

    expect(again.result).toMatchObject({ taskId: sent.taskId, state: "completed", replayed: true });
    expect(again.result.result.identifier).toBe("GUARDIANAI-7");
    expect(h.toolCalls).toHaveLength(1);
  });

  it("refuses a reused key carrying a different request", async () => {
    await send({ title: TITLE }, { messageId: "msg-3" });
    const res = await send({ title: "Something else" }, { messageId: "msg-3" });

    expect(res.error.code).toBe(A2A_ERROR_CODES.IDEMPOTENCY_CONFLICT);
    expect(h.tasks.size).toBe(1);
  });

  it("does not deduplicate across clients", async () => {
    await send({ title: TITLE }, { messageId: "msg-4" });
    await send({ title: TITLE }, { messageId: "msg-4", auth: { ...peer, clientId: "peer_other" } });

    expect(h.tasks.size).toBe(2);
  });
});

describe("authentication, scope and approval are three different answers", () => {
  it("a missing write scope is INSUFFICIENT_SCOPE, never an approval wait or an auth error", async () => {
    const res = await send({ title: TITLE }, { auth: { ...peer, scopes: ["taskpilot:read"] } });

    expect(res.error.code).toBe(A2A_ERROR_CODES.INSUFFICIENT_SCOPE);
    expect(res.error.code).not.toBe(A2A_ERROR_CODES.AUTH_REQUIRED);
    expect(res.error.data).toEqual({ requiredScope: "taskpilot:write", grantedScopes: ["taskpilot:read"] });
    expect(h.tasks.size).toBe(0);
    expect(h.submitApproval.count).toBe(0);
  });

  it("no credentials at all is AUTH_REQUIRED", async () => {
    const res = await handleA2aRequest({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { taskId: "x" } }, null, "");
    expect(res.error.code).toBe(A2A_ERROR_CODES.AUTH_REQUIRED);
  });

  it("an invalid target is refused before anyone is asked to approve it", async () => {
    h.precheck.value = { error: "No project matches 'GUARDIAN'." };

    const res = await send({ title: TITLE, project_hint: "GUARDIAN" });

    expect(res.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
    expect(res.error.message).toMatch(/refused before approval/);
    expect(h.tasks.size).toBe(0);
    expect(h.submitApproval.count).toBe(0);
  });

  it("another client's task reads as not found", async () => {
    const { result: sent } = await send({ title: TITLE });
    const res = await getTask(sent.taskId, { ...peer, clientId: "peer_other" });
    expect(res.error.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });
});

describe("project.create", () => {
  it("is always approval-gated", async () => {
    h.precheck.value = {};
    const res = await send({ name: "New", identifier: "NEW" }, { skill: "project.create", auth: { ...peer, clientId: "mcp_owner" } });
    expect(res.result.state).toBe("auth_required");
  });

  it("returns an existing exact match immediately, with nothing to approve", async () => {
    h.precheck.value = { result: { id: "p-guard", identifier: "GUARDIANAI", name: "GuardianAI", status: "exists" } };

    const res = await send({ name: "GuardianAI", identifier: "GUARDIANAI" }, { skill: "project.create" });

    expect(res.result.state).toBe("completed");
    expect(res.result.result).toMatchObject({ id: "p-guard", status: "exists" });
    expect(h.submitApproval.count).toBe(0);
    expect(h.toolCalls).toHaveLength(0);
  });
});

describe("what never leaves the server", () => {
  it("logs ids and states, not the content of the write", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation((line: any) => { h.logs.push(String(line)); });
    h.logs.length = 0;
    const secretish = "private body text 7f3a";
    await send({ title: TITLE, description: secretish });
    decide("APPROVED");
    await pollHitlDecisions();
    spy.mockRestore();

    expect(h.logs.some((l) => l.includes('"evt":"a2a.transition"'))).toBe(true);
    expect(h.logs.join("\n")).not.toContain(secretish);
  });

  it("does not return a stack trace to the peer", async () => {
    const { result: sent } = await send({ title: TITLE });
    h.toolResult.error = new Error("boom");
    decide("APPROVED");
    await pollHitlDecisions();

    expect((await getTask(sent.taskId)).result.error).toEqual({ message: "boom" });
  });
});
