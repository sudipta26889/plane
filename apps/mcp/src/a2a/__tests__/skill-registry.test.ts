import { describe, it, expect } from "vitest";
import {
  getSkillDefinition,
  getAllSkills,
  isCriticalAction,
  requiresApproval,
} from "../skill-registry.js";

describe("Skill Registry", () => {
  it("maps all 28 A2A skills to MCP tools", () => {
    const skills = getAllSkills();
    expect(skills.length).toBe(28);
  });

  it("resolves task.create to create_task", () => {
    const skill = getSkillDefinition("task.create");
    expect(skill).toBeDefined();
    expect(skill!.mcpTool).toBe("create_task");
    expect(skill!.scope).toBe("taskpilot:write");
    expect(skill!.approval).toBe(false);
  });

  it("resolves project.list to list_projects", () => {
    const skill = getSkillDefinition("project.list");
    expect(skill).toBeDefined();
    expect(skill!.mcpTool).toBe("list_projects");
    expect(skill!.scope).toBe("taskpilot:read");
  });

  it("returns undefined for unknown skills", () => {
    expect(getSkillDefinition("nonexistent")).toBeUndefined();
  });

  it("identifies task.move to Cancelled as critical", () => {
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "Cancelled" })).toBe(true);
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "cancelled" })).toBe(true);
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "In Progress" })).toBe(false);
    expect(isCriticalAction("create_task", { title: "test" })).toBe(false);
  });

  it("requiresApproval detects conditional skills", () => {
    expect(requiresApproval("task.move", { identifier: "X-1", state: "Cancelled" })).toBe(true);
    expect(requiresApproval("task.move", { identifier: "X-1", state: "Done" })).toBe(false);
    expect(requiresApproval("task.create", { title: "test" })).toBe(false);
    expect(requiresApproval("nonexistent", {})).toBe(false);
  });
});

describe("isCriticalAction covers destructive page operations", () => {
  it("treats archiving a page as critical", () => {
    // page.archive is approval:true for A2A, but MCP clients call the tool
    // directly and only isCriticalAction gates that path.
    expect(isCriticalAction("page_archive", {})).toBe(true);
  });

  it("leaves non-destructive page tools alone", () => {
    expect(isCriticalAction("page_update", {})).toBe(false);
    expect(isCriticalAction("page_create", {})).toBe(false);
  });
});

describe("intake rejection is gated, acceptance is not", () => {
  it("treats rejecting an intake item as critical", () => {
    // Rejecting discards work that was captured because the router could not
    // place it; accepting merely files it where it already sits.
    expect(isCriticalAction("intake_triage", { decision: "reject" })).toBe(true);
  });

  it("leaves acceptance ungated", () => {
    expect(isCriticalAction("intake_triage", { decision: "accept" })).toBe(false);
  });

  it("requires approval only for the reject decision", () => {
    expect(requiresApproval("intake.triage", { decision: "reject" })).toBe(true);
    expect(requiresApproval("intake.triage", { decision: "accept" })).toBe(false);
  });
});
