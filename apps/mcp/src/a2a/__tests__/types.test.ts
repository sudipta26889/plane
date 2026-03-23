import { describe, it, expect } from "vitest";
import {
  A2A_TASK_STATES,
  TERMINAL_STATES,
  isTerminalState,
  isValidTransition,
} from "../types.js";

describe("A2A types", () => {
  it("defines all task states", () => {
    expect(A2A_TASK_STATES).toContain("submitted");
    expect(A2A_TASK_STATES).toContain("working");
    expect(A2A_TASK_STATES).toContain("completed");
    expect(A2A_TASK_STATES).toContain("failed");
    expect(A2A_TASK_STATES).toContain("auth_required");
    expect(A2A_TASK_STATES).toContain("canceled");
    expect(A2A_TASK_STATES).toContain("rejected");
  });

  it("identifies terminal states", () => {
    expect(isTerminalState("completed")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
    expect(isTerminalState("canceled")).toBe(true);
    expect(isTerminalState("rejected")).toBe(true);
    expect(isTerminalState("submitted")).toBe(false);
    expect(isTerminalState("working")).toBe(false);
    expect(isTerminalState("auth_required")).toBe(false);
  });

  it("validates state transitions", () => {
    expect(isValidTransition("submitted", "working")).toBe(true);
    expect(isValidTransition("submitted", "canceled")).toBe(true);
    expect(isValidTransition("submitted", "auth_required")).toBe(true);
    expect(isValidTransition("working", "completed")).toBe(true);
    expect(isValidTransition("working", "failed")).toBe(true);
    expect(isValidTransition("auth_required", "submitted")).toBe(true);
    expect(isValidTransition("auth_required", "rejected")).toBe(true);
    expect(isValidTransition("completed", "working")).toBe(false);
    expect(isValidTransition("failed", "submitted")).toBe(false);
  });
});
