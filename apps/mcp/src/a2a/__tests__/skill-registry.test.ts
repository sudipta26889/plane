import { describe, it, expect } from "vitest";
import {
  getSkillDefinition,
  getAllSkills,
  isCriticalAction,
  requiresApproval,
} from "../skill-registry.js";

describe("Skill Registry", () => {
  it("maps all 24 A2A skills to MCP tools", () => {
    const skills = getAllSkills();
    expect(skills.length).toBe(24);
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
