import { describe, it, expect } from "vitest";
import { hasRequiredScope } from "../auth.js";

describe("A2A Auth", () => {
  it("returns true when scope is present", () => {
    expect(hasRequiredScope(["taskpilot:read", "taskpilot:write"], "taskpilot:read")).toBe(true);
  });

  it("returns false when scope is missing", () => {
    expect(hasRequiredScope(["taskpilot:read"], "taskpilot:write")).toBe(false);
  });

  it("returns false for empty scopes", () => {
    expect(hasRequiredScope([], "taskpilot:read")).toBe(false);
  });

  it("handles exact match only", () => {
    expect(hasRequiredScope(["taskpilot:readonly"], "taskpilot:read")).toBe(false);
  });
});
