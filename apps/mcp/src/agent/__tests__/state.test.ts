import { describe, it, expect, vi } from "vitest";

// A fake table standing in for a2a_agent_runs. This models node-pg's real
// jsonb contract (the driver expects a JSON string in, and hands back a
// parsed object on the way out) without opening any connection, so the
// round trip below exercises state.ts's own query-building and
// row-to-value logic rather than a live database.
const fakeTable = new Map<string, unknown>();

vi.mock("../../db.js", () => ({
  db: {
    query: vi.fn(async (sql: string, params: any[]) => {
      const taskId = params[0];
      if (sql.includes("INSERT INTO a2a_agent_runs")) {
        fakeTable.set(taskId, JSON.parse(params[1]));
        return { rows: [] };
      }
      if (sql.includes("SELECT state FROM a2a_agent_runs")) {
        const state = fakeTable.get(taskId);
        return { rows: state === undefined ? [] : [{ state }] };
      }
      if (sql.includes("DELETE FROM a2a_agent_runs")) {
        fakeTable.delete(taskId);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  },
}));

import { saveRunState, loadRunState, clearRunState, type AgentRunState } from "../state.js";

describe("run state round trip", () => {
  it("returns null for a task that never suspended", async () => {
    await expect(loadRunState("task-never-suspended")).resolves.toBeNull();
  });

  it("saves and reloads the exact state a run suspended with", async () => {
    const state: AgentRunState = {
      messages: [
        { role: "user", content: "delete the stale sprint" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "delete_cycle", arguments: "{}" } }] },
      ],
      iteration: 2,
      pendingToolCall: { id: "call_1", name: "delete_cycle", args: { cycleId: "abc" } },
    };

    await saveRunState("task-1", state);

    await expect(loadRunState("task-1")).resolves.toEqual(state);
  });

  it("overwrites a previous save for the same task id rather than erroring", async () => {
    await saveRunState("task-2", { messages: [], iteration: 0, pendingToolCall: null });
    await saveRunState("task-2", { messages: [{ role: "user", content: "hi" }], iteration: 1, pendingToolCall: null });

    await expect(loadRunState("task-2")).resolves.toEqual({
      messages: [{ role: "user", content: "hi" }],
      iteration: 1,
      pendingToolCall: null,
    });
  });

  it("forgets the state once cleared", async () => {
    await saveRunState("task-3", { messages: [], iteration: 0, pendingToolCall: null });
    await clearRunState("task-3");

    await expect(loadRunState("task-3")).resolves.toBeNull();
  });
});
