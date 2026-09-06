import type OpenAI from "openai";
import { getAllSkills, type SkillDefinition } from "../a2a/skill-registry.js";
import { getToolDefinitions } from "../tools/handlers.js";

/**
 * OpenAI function-calling definitions for every skill the caller's scopes
 * allow, keyed by the MCP tool name so `tool_calls[].function.name` maps
 * straight back to a handler with no translation table.
 */
export function buildToolDefinitions(scopes: string[]): OpenAI.Chat.ChatCompletionTool[] {
  const mcpToolsByName = new Map(getToolDefinitions().map((t) => [t.name, t]));

  return getAllSkills()
    .filter((skill) => scopes.includes(skill.scope))
    .map((skill) => {
      const mcpTool = mcpToolsByName.get(skill.mcpTool);
      return {
        type: "function" as const,
        function: {
          name: skill.mcpTool,
          description: mcpTool?.description ?? skill.description,
          parameters: mcpTool?.inputSchema ?? { type: "object", properties: {} },
        },
      };
    });
}

/** Look up the skill behind an MCP tool name, or undefined if the model invented one. */
export function resolveToolName(fnName: string): SkillDefinition | undefined {
  return getAllSkills().find((skill) => skill.mcpTool === fnName);
}
