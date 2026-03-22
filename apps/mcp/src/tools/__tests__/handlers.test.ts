import { describe, it, expect } from "vitest";

describe("list_members handler", () => {
  it("should be registered in TOOLS array", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    const listMembers = tools.find((t: any) => t.name === "list_members");
    expect(listMembers).toBeDefined();
    expect(listMembers!.name).toBe("list_members");
    expect(listMembers!.inputSchema.properties).toHaveProperty("project");
  });
});

describe("assign_task handler", () => {
  it("should be registered in TOOLS array with required fields", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    const assignTask = tools.find((t: any) => t.name === "assign_task");
    expect(assignTask).toBeDefined();
    expect(assignTask!.inputSchema.required).toContain("identifier");
    expect(assignTask!.inputSchema.required).toContain("user_id");
  });
});

describe("unassign_task handler", () => {
  it("should be registered in TOOLS array with required fields", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    const unassignTask = tools.find((t: any) => t.name === "unassign_task");
    expect(unassignTask).toBeDefined();
    expect(unassignTask!.inputSchema.required).toContain("identifier");
    expect(unassignTask!.inputSchema.required).toContain("user_id");
  });
});

describe("label tools", () => {
  it("should register list_labels tool", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    expect(tools.find((t: any) => t.name === "list_labels")).toBeDefined();
  });

  it("should register add_label tool with required fields", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    const tool = tools.find((t: any) => t.name === "add_label");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toContain("identifier");
    expect(tool!.inputSchema.required).toContain("label");
  });

  it("should register remove_label tool with required fields", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    const tool = tools.find((t: any) => t.name === "remove_label");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toContain("identifier");
    expect(tool!.inputSchema.required).toContain("label");
  });
});
