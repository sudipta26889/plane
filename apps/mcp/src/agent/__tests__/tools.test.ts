import { describe, it, expect } from "vitest";
import { buildToolDefinitions, resolveToolName } from "../tools.js";
import { getAllSkills } from "../../a2a/skill-registry.js";

describe("buildToolDefinitions", () => {
  it("offers every skill to a read+write caller", () => {
    const tools = buildToolDefinitions(["taskpilot:read", "taskpilot:write"]);
    expect(tools.length).toBe(getAllSkills().length);
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.parameters).toBeDefined();
    }
  });

  it("hides write tools from a read-only caller", () => {
    const tools = buildToolDefinitions(["taskpilot:read"]);
    const names = tools.map((t) => t.function.name);
    const writes = getAllSkills().filter((s) => s.scope === "taskpilot:write");
    for (const skill of writes) {
      expect(names, `${skill.mcpTool} must not be offered`).not.toContain(skill.mcpTool);
    }
    expect(tools.length).toBeGreaterThan(0);
  });

  it("uses the MCP tool name so results map straight back to a handler", () => {
    const tools = buildToolDefinitions(["taskpilot:read"]);
    const first = tools[0]!.function.name;
    expect(resolveToolName(first)?.mcpTool).toBe(first);
  });

  it("returns undefined for a name the model invented", () => {
    expect(resolveToolName("definitely_not_a_tool")).toBeUndefined();
  });
});
