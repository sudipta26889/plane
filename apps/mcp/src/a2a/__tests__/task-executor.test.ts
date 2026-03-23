import { describe, it, expect } from "vitest";
import { mapSkillInputToMcpArgs } from "../task-executor.js";
import { isValidTransition } from "../types.js";

describe("Task Executor", () => {
  it("maps A2A skill input to MCP tool args (pass-through)", () => {
    const result = mapSkillInputToMcpArgs("task.create", {
      title: "Buy milk",
      project_hint: "Shopping",
    });
    expect(result).toEqual({ title: "Buy milk", project_hint: "Shopping" });
  });

  it("maps task.move input correctly", () => {
    const result = mapSkillInputToMcpArgs("task.move", {
      identifier: "PROJ-42",
      state: "In Progress",
    });
    expect(result).toEqual({ identifier: "PROJ-42", state: "In Progress" });
  });

  it("state transitions follow the state machine", () => {
    expect(isValidTransition("submitted", "working")).toBe(true);
    expect(isValidTransition("submitted", "auth_required")).toBe(true);
    expect(isValidTransition("working", "completed")).toBe(true);
    expect(isValidTransition("working", "failed")).toBe(true);
    expect(isValidTransition("auth_required", "submitted")).toBe(true);
    expect(isValidTransition("auth_required", "rejected")).toBe(true);
    expect(isValidTransition("submitted", "canceled")).toBe(true);
    expect(isValidTransition("auth_required", "canceled")).toBe(true);
    expect(isValidTransition("completed", "working")).toBe(false);
    expect(isValidTransition("failed", "submitted")).toBe(false);
    expect(isValidTransition("canceled", "submitted")).toBe(false);
  });
});
