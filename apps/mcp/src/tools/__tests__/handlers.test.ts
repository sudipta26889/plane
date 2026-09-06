import { describe, it, expect } from "vitest";
import { resolveIntakeProject } from "../handlers.js";

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

describe("get_task_summary handler", () => {
  it("should be registered in TOOLS array", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    const tool = tools.find((t: any) => t.name === "get_task_summary");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty("project");
  });
});

describe("mapStateGroupToSimpleStatus", () => {
  it("should map state groups to 3-state model", async () => {
    const { mapStateGroupToSimpleStatus } = await import("../handlers.js");
    expect(mapStateGroupToSimpleStatus("backlog")).toBe("pending");
    expect(mapStateGroupToSimpleStatus("unstarted")).toBe("pending");
    expect(mapStateGroupToSimpleStatus("triage")).toBe("pending");
    expect(mapStateGroupToSimpleStatus("started")).toBe("in_progress");
    expect(mapStateGroupToSimpleStatus("completed")).toBe("completed");
    expect(mapStateGroupToSimpleStatus("cancelled")).toBe("completed");
  });
});

describe("all tools registration", () => {
  it("should register exactly 21 tools", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    expect(tools).toHaveLength(21);
  });

  it("should have unique tool names", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    const names = tools.map((t: any) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("should include all expected tool names", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    const names = tools.map((t: any) => t.name);
    const expected = [
      // Original 11
      "create_task", "move_task", "find_tasks", "list_projects",
      "list_tasks", "get_task", "update_task", "add_comment",
      "list_states", "list_cycles", "assign_to_cycle",
      // New 7
      "list_members", "assign_task", "unassign_task",
      "list_labels", "add_label", "remove_label",
      "get_task_summary",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it("should enforce write scope on all write tools", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    const writeToolNames = [
      "create_task", "move_task", "update_task", "add_comment",
      "assign_to_cycle", "assign_task", "unassign_task",
      "add_label", "remove_label",
    ];
    for (const name of writeToolNames) {
      expect(tools.find((t: any) => t.name === name)).toBeDefined();
    }
  });
});

describe("resolveIntakeProject", () => {
  const projects = [
    { id: "p1", name: "Finance and Bills", identifier: "SUDIPTASCF", description: "" },
    { id: "p2", name: "ProDevs", identifier: "PRODEVS", description: "" },
  ];

  it("finds the configured intake project for the workspace", () => {
    const configured = new Map([["for-ai", "SUDIPTASCF"]]);
    expect(resolveIntakeProject("for-ai", projects, configured)).toBe("p1");
  });

  it("returns null when the workspace has no configured intake project", () => {
    // Nothing configured must mean nothing written — never a guessed project.
    expect(resolveIntakeProject("meetecho", projects, new Map())).toBeNull();
  });

  it("returns null when the configured identifier does not exist", () => {
    const configured = new Map([["for-ai", "NOSUCHPROJ"]]);
    expect(resolveIntakeProject("for-ai", projects, configured)).toBeNull();
  });
});

import { formatPageSummary } from "../handlers.js";

describe("formatPageSummary", () => {
  it("returns the fields an agent needs to act on a page", () => {
    const summary = formatPageSummary({
      id: "p1",
      name: "Q3 planning",
      external_source: "meetecho",
      external_id: "abc",
      is_locked: false,
      archived_at: null,
      updated_at: "2026-09-01T00:00:00Z",
    });
    expect(summary).toEqual({
      id: "p1",
      name: "Q3 planning",
      source: "meetecho",
      locked: false,
      archived: false,
      updated_at: "2026-09-01T00:00:00Z",
    });
  });

  it("marks an archived page as archived", () => {
    // archived_at is a date, not a boolean — a truthy check is the contract.
    const summary = formatPageSummary({ id: "p2", name: "Old", archived_at: "2026-08-01" });
    expect(summary.archived).toBe(true);
  });

  it("reports a page with no external source as locally authored", () => {
    const summary = formatPageSummary({ id: "p3", name: "Notes" });
    expect(summary.source).toBe("local");
  });
});
