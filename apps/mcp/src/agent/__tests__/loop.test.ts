import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuthContext } from "../../a2a/types.js";

/**
 * Nothing here touches the network. The OpenAI client is replaced wholesale so
 * the test scripts the exact sequence of model responses, and `executeToolCall`
 * is a spy so "did this write actually run?" is answerable directly rather than
 * inferred from the return value.
 */
const { createMock, executeToolCallMock, runStates, recordedTurns } = vi.hoisted(() => ({
  createMock: vi.fn(),
  executeToolCallMock: vi.fn(),
  runStates: new Map<string, any>(),
  recordedTurns: [] as Array<{ contextId: string; message: any }>,
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

// Spread the real module: agent/tools.ts needs the genuine getToolDefinitions,
// and only the executor is swapped out.
vi.mock("../../tools/handlers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tools/handlers.js")>()),
  executeToolCall: executeToolCallMock,
}));

vi.mock("../../tools/smart-router.js", () => ({
  getLlmConfig: async () => ({ apiKey: "test-key", baseUrl: "http://llm.test/v1", model: "test-model" }),
}));

vi.mock("../longmemory.js", () => ({
  recallForPrompt: async () => "",
}));

vi.mock("../memory.js", () => ({
  recordTurn: async (contextId: string, message: any) => {
    recordedTurns.push({ contextId, message });
  },
  loadConversation: async () => [],
}));

// A stand-in for the a2a_agent_runs table, round-tripped through JSON the way
// the real jsonb column does, so the test reads back what actually persisted.
vi.mock("../state.js", () => ({
  saveRunState: async (taskId: string, state: any) => {
    runStates.set(taskId, JSON.parse(JSON.stringify(state)));
  },
  loadRunState: async (taskId: string) => runStates.get(taskId) ?? null,
  clearRunState: async (taskId: string) => {
    runStates.delete(taskId);
  },
}));

import { runAgent, MAX_ITERATIONS, WALL_CLOCK_MS } from "../loop.js";
import { loadRunState } from "../state.js";

const OWNER: AuthContext = {
  userId: "user-1",
  workspaceSlug: "acme",
  clientId: "mcp_owner",
  scopes: ["taskpilot:read", "taskpilot:write"],
};
const PEER: AuthContext = { ...OWNER, clientId: "peer_meetecho" };

function callsResponse(calls: Array<{ id: string; name: string; args: Record<string, any> }>) {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
  };
}

function answerResponse(text: string) {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] };
}

/** The messages the model was handed on its nth call (1-indexed). */
function messagesOnCall(n: number): any[] {
  return createMock.mock.calls[n - 1]![0].messages;
}

function run(overrides: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return runAgent({
    text: "find the ITR-3 task and comment that it is done",
    contextId: "ctx-1",
    auth: OWNER,
    taskId: "task-1",
    ...overrides,
  });
}

beforeEach(() => {
  createMock.mockReset();
  executeToolCallMock.mockReset();
  runStates.clear();
  recordedTurns.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runAgent: one tool call then an answer", () => {
  it("executes the tool, feeds the result back, and returns the model's answer", async () => {
    executeToolCallMock.mockResolvedValue({ tasks: [{ id: "TP-42", name: "File ITR-3" }] });
    createMock
      .mockResolvedValueOnce(callsResponse([{ id: "call_1", name: "find_tasks", args: { query: "ITR-3" } }]))
      .mockResolvedValueOnce(answerResponse("TP-42 is the ITR-3 task."));

    const result = await run();

    expect(result).toEqual({
      status: "completed",
      answer: "TP-42 is the ITR-3 task.",
      toolsUsed: ["find_tasks"],
    });
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(executeToolCallMock).toHaveBeenCalledWith("find_tasks", { query: "ITR-3" }, OWNER, false);

    // The second model call must have seen the tool's output.
    const second = messagesOnCall(2);
    const toolMessage = second.find((m) => m.role === "tool");
    expect(toolMessage.tool_call_id).toBe("call_1");
    expect(toolMessage.content).toContain("TP-42");
  });

  it("offers the model only the tools the caller's scopes allow", async () => {
    createMock.mockResolvedValue(answerResponse("nothing to do"));

    await run({ auth: { ...OWNER, scopes: ["taskpilot:read"] } });

    const names = createMock.mock.calls[0]![0].tools.map((t: any) => t.function.name);
    expect(names).toContain("find_tasks");
    expect(names).not.toContain("add_comment");
  });
});

describe("runAgent: chaining", () => {
  it("threads the first call's result into the second call's arguments", async () => {
    executeToolCallMock.mockImplementation(async (name: string) => {
      if (name === "find_tasks") return { tasks: [{ id: "TP-42", name: "File ITR-3" }] };
      return { ok: true };
    });

    // The stub reads the transcript it was given rather than replaying a fixed
    // script: it can only produce TP-42 if the loop actually fed the first
    // tool's result back into the conversation.
    createMock.mockImplementation(async ({ messages }: any) => {
      const toolResults = messages.filter((m: any) => m.role === "tool");
      if (toolResults.length === 0) {
        return callsResponse([{ id: "call_1", name: "find_tasks", args: { query: "ITR-3" } }]);
      }
      if (toolResults.length === 1) {
        const found = JSON.parse(toolResults[0].content);
        return callsResponse([
          { id: "call_2", name: "add_comment", args: { taskId: found.tasks[0].id, comment: "done" } },
        ]);
      }
      return answerResponse("Commented on TP-42.");
    });

    const result = await run();

    expect(result.status).toBe("completed");
    expect(executeToolCallMock.mock.calls.map((c) => c[0])).toEqual(["find_tasks", "add_comment"]);
    // The load-bearing assertion: the id in the second call came from the first
    // call's result, so the loop threaded it through.
    expect(executeToolCallMock.mock.calls[1]![1]).toEqual({ taskId: "TP-42", comment: "done" });
    expect((result as any).toolsUsed).toEqual(["find_tasks", "add_comment"]);
  });
});

describe("runAgent: approval suspension", () => {
  it("does NOT execute a write needing approval, and persists the pending call", async () => {
    createMock.mockResolvedValue(
      callsResponse([{ id: "call_9", name: "bulk_cancel_tasks", args: { taskIds: ["TP-1", "TP-2"] } }]),
    );

    const result = await run();

    // Proof the write did not happen: the only path to a handler is this spy.
    expect(executeToolCallMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "needs_approval",
      toolCall: { id: "call_9", name: "bulk_cancel_tasks", args: { taskIds: ["TP-1", "TP-2"] } },
    });

    const saved = await loadRunState("task-1");
    expect(saved!.pendingToolCall).toEqual({
      id: "call_9",
      name: "bulk_cancel_tasks",
      args: { taskIds: ["TP-1", "TP-2"] },
    });
    // The assistant turn that asked for the write must be in the saved
    // transcript, and it must have no tool reply yet.
    const assistant = saved!.messages.filter((m: any) => m.role === "assistant").at(-1);
    expect(assistant.tool_calls[0].id).toBe("call_9");
    expect(saved!.messages.some((m: any) => m.role === "tool")).toBe(false);
  });

  it("gates any write by an external peer, not just destructive ones", async () => {
    createMock.mockResolvedValue(
      callsResponse([{ id: "call_p", name: "add_comment", args: { taskId: "TP-1", comment: "hi" } }]),
    );

    const result = await run({ auth: PEER });

    expect(executeToolCallMock).not.toHaveBeenCalled();
    expect(result.status).toBe("needs_approval");
  });

  it("stops the turn at the gated call — nothing after it executes", async () => {
    executeToolCallMock.mockResolvedValue({ tasks: [] });
    createMock.mockResolvedValue(
      callsResponse([
        { id: "call_a", name: "find_tasks", args: { query: "stale" } },
        { id: "call_b", name: "bulk_cancel_tasks", args: { taskIds: ["TP-1"] } },
        { id: "call_c", name: "add_label", args: { taskId: "TP-1", label: "done" } },
      ]),
    );

    const result = await run();

    expect(result.status).toBe("needs_approval");
    const executed = executeToolCallMock.mock.calls.map((c) => c[0]);
    expect(executed).toEqual(["find_tasks"]);
    expect(executed).not.toContain("bulk_cancel_tasks");
    expect(executed).not.toContain("add_label");
  });

  it("runs the approved call on resume, and only that one without a fresh gate", async () => {
    // The state a suspended run left behind.
    const suspended = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "cancel the stale tasks" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_9",
              type: "function",
              function: { name: "bulk_cancel_tasks", arguments: JSON.stringify({ taskIds: ["TP-1"] }) },
            },
          ],
        },
      ],
      iteration: 1,
      pendingToolCall: { id: "call_9", name: "bulk_cancel_tasks", args: { taskIds: ["TP-1"] } },
    };
    runStates.set("task-1", suspended);
    executeToolCallMock.mockResolvedValue({ cancelled: 1 });
    createMock.mockResolvedValue(answerResponse("Cancelled 1 task."));

    const result = await run({ resumeFrom: suspended as any });

    expect(result).toEqual({ status: "completed", answer: "Cancelled 1 task.", toolsUsed: ["bulk_cancel_tasks"] });
    // approvalAlreadyGranted must be true, or the executor asks a second time
    // for an approval the human already gave.
    expect(executeToolCallMock).toHaveBeenCalledWith("bulk_cancel_tasks", { taskIds: ["TP-1"] }, OWNER, true);
    // The resumed run must not be replayable.
    expect(await loadRunState("task-1")).toBeNull();
  });

  it("fails loudly rather than dropping an approved write the state cannot locate", async () => {
    const broken = {
      messages: [{ role: "user", content: "cancel them" }],
      iteration: 1,
      pendingToolCall: { id: "call_missing", name: "bulk_cancel_tasks", args: {} },
    };

    const result = await run({ resumeFrom: broken as any });

    expect(result.status).toBe("failed");
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });
});

describe("runAgent: bounds", () => {
  it("stops at MAX_ITERATIONS and says so instead of truncating silently", async () => {
    executeToolCallMock.mockResolvedValue({ tasks: [] });
    createMock.mockResolvedValue(callsResponse([{ id: "call_x", name: "find_tasks", args: { query: "again" } }]));

    const result = await run();

    expect(createMock).toHaveBeenCalledTimes(MAX_ITERATIONS);
    expect(result.status).toBe("completed");
    expect((result as any).stoppedEarly).toBe(true);
    expect((result as any).answer).toMatch(/step limit/i);
  });

  it("gives up on the wall clock before the caller's timeout", async () => {
    vi.useFakeTimers();
    executeToolCallMock.mockResolvedValue({ tasks: [] });
    createMock.mockImplementation(async () => {
      vi.advanceTimersByTime(40_000);
      return callsResponse([{ id: "call_x", name: "find_tasks", args: { query: "slow" } }]);
    });

    const result = await run();

    // 40s + 40s is still inside the budget; the third call would land past it.
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock).not.toHaveBeenCalledTimes(MAX_ITERATIONS);
    expect(result.status).toBe("completed");
    expect((result as any).stoppedEarly).toBe(true);
    expect((result as any).answer).toMatch(/time limit/i);
    expect(WALL_CLOCK_MS).toBe(90_000);
  });

  it("stops executing tools mid-turn once the clock runs out", async () => {
    vi.useFakeTimers();
    executeToolCallMock.mockImplementation(async () => {
      vi.advanceTimersByTime(50_000);
      return { ok: true };
    });
    createMock.mockResolvedValue(
      callsResponse([
        { id: "c1", name: "find_tasks", args: { query: "a" } },
        { id: "c2", name: "find_tasks", args: { query: "b" } },
        { id: "c3", name: "find_tasks", args: { query: "c" } },
      ]),
    );

    const result = await run();

    // 0s and 50s are inside the budget; the third call starts past 90s.
    expect(executeToolCallMock).toHaveBeenCalledTimes(2);
    expect((result as any).stoppedEarly).toBe(true);
    expect((result as any).answer).toMatch(/time limit/i);
  });
});

describe("runAgent: recovery", () => {
  it("feeds an invented tool name back as an error the model can recover from", async () => {
    createMock
      .mockResolvedValueOnce(callsResponse([{ id: "call_h", name: "summon_unicorn", args: {} }]))
      .mockResolvedValueOnce(answerResponse("Sorry, I cannot do that."));

    const result = await run();

    expect(executeToolCallMock).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect((result as any).answer).toBe("Sorry, I cannot do that.");
    const toolMessage = messagesOnCall(2).find((m: any) => m.role === "tool");
    expect(toolMessage.tool_call_id).toBe("call_h");
    expect(toolMessage.content).toMatch(/summon_unicorn/);
  });

  it("feeds a failed tool call back rather than aborting the run", async () => {
    executeToolCallMock.mockRejectedValueOnce(new Error("Tool 'add_comment' requires 'taskpilot:write' scope"));
    createMock
      .mockResolvedValueOnce(callsResponse([{ id: "call_e", name: "add_comment", args: { taskId: "TP-1", comment: "x" } }]))
      .mockResolvedValueOnce(answerResponse("I do not have permission to comment."));

    const result = await run();

    expect(result.status).toBe("completed");
    const toolMessage = messagesOnCall(2).find((m: any) => m.role === "tool");
    expect(toolMessage.content).toMatch(/taskpilot:write/);
    // A failed call is not a step completed.
    expect((result as any).toolsUsed).toEqual([]);
  });

  it("feeds unparseable arguments back instead of throwing", async () => {
    createMock
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_b", type: "function", function: { name: "find_tasks", arguments: "{not json" } }],
            },
          },
        ],
      })
      .mockResolvedValueOnce(answerResponse("Let me try again differently."));

    const result = await run();

    expect(executeToolCallMock).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(messagesOnCall(2).find((m: any) => m.role === "tool").content).toMatch(/argument/i);
  });

  it("returns failed when the model itself is unreachable", async () => {
    createMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await run();

    expect(result).toEqual({ status: "failed", error: expect.stringContaining("ECONNREFUSED"), toolsUsed: [] });
  });
});

describe("runAgent: conversation memory", () => {
  it("records the user's message and the final answer for the next turn", async () => {
    createMock.mockResolvedValue(answerResponse("Nothing to do."));

    await run();

    expect(recordedTurns.map((t) => t.message.role)).toEqual(["user", "assistant"]);
    expect(recordedTurns[0]!.contextId).toBe("ctx-1");
    expect(recordedTurns[1]!.message.content).toBe("Nothing to do.");
  });
});
