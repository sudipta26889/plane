import { describe, it, expect, vi } from "vitest";

/**
 * Project scoping, through the real handlers. The regression: a GUARDIANAI
 * query that came back with other projects' tasks, because every lookup fell
 * back to the whole workspace whenever its fuzzy match missed.
 */
const GUARD = { id: "11111111-1111-4111-8111-111111111111", identifier: "GUARDIANAI", name: "GuardianAI" };
const GUARDIAN_OPS = { id: "22222222-2222-4222-8222-222222222222", identifier: "GOPS", name: "Guardian Ops" };
const PKM = { id: "33333333-3333-4333-8333-333333333333", identifier: "PKM", name: "PKM Sources" };

const ISSUES: Record<string, any[]> = {
  [GUARD.id]: [
    { id: "g1", project: GUARD.id, sequence_id: 1, name: "Capture Guardian baseline", state: "s-todo", priority: "urgent" },
    { id: "g2", project: GUARD.id, sequence_id: 2, name: "Verify GuardianAI TaskPilot A2A write lifecycle", state: "s-done", priority: "low" },
    // A row the API should never have returned for this project.
    { id: "leak", project: PKM.id, sequence_id: 99, name: "Leaked PKM item", state: "s-todo", priority: "none" },
  ],
  [GUARDIAN_OPS.id]: [{ id: "o1", project: GUARDIAN_OPS.id, sequence_id: 1, name: "Guardian ops item", state: "s-todo", priority: "high" }],
  [PKM.id]: [{ id: "p1", project: PKM.id, sequence_id: 1, name: "PKM item", state: "s-todo", priority: "none" }],
};

const projects = { list: [GUARD, GUARDIAN_OPS, PKM] as any[] };
const created: any[] = [];

vi.mock("../../config.js", () => ({ config: { dharahilEnabled: false, frontendUrl: "https://tp.test", intakeProjects: new Map() } }));
vi.mock("../../db.js", () => ({ db: { query: async () => ({ rows: [] }) } }));
vi.mock("../../a2a/audit-log.js", () => ({ logAuditEvent: async () => {} }));
vi.mock("../taskpilot-client.js", () => ({
  getOrCreateApiToken: async () => "tok",
  TaskPilotClient: class {
    async listProjects() { return projects.list; }
    async listIssues(projectId: string) { return ISSUES[projectId] ?? []; }
    async listStates() { return [{ id: "s-todo", name: "Todo", group: "unstarted" }, { id: "s-done", name: "Done", group: "completed" }]; }
    async listLabels() { return []; }
    async listCycles() { return []; }
    async createProject(data: any) { created.push(data); return { id: "new-id", ...data }; }
  },
}));

import { executeToolCall, resolveProjectRef, planProjectCreate, precheckToolCall } from "../handlers.js";
import { routeWorkItem } from "../../routing/router.js";

const owner = { userId: "u", workspaceSlug: "ws", clientId: "mcp_owner", scopes: ["taskpilot:read", "taskpilot:write"] };
const listTasks = (args: any) => executeToolCall("list_tasks", args, owner);

describe("list_tasks is scoped to exactly the project asked for", () => {
  it.each([
    ["identifier", { project: "GUARDIANAI" }],
    ["lower-case identifier", { project: "guardianai" }],
    ["name", { project: "GuardianAI" }],
    ["project id", { project_id: GUARD.id }],
    ["project_hint alias", { project_hint: "GUARDIANAI" }],
  ])("by %s", async (_label, args) => {
    const res = await listTasks(args);

    expect(res.project_id).toBe(GUARD.id);
    expect(res.tasks.map((t: any) => t.identifier)).toEqual(["GUARDIANAI-1", "GUARDIANAI-2"]);
    expect(res.tasks.every((t: any) => t.project_id === GUARD.id)).toBe(true);
  });

  it("drops a row from another project even if the API hands one back", async () => {
    const res = await listTasks({ project: "GUARDIANAI" });
    expect(JSON.stringify(res)).not.toContain("Leaked PKM item");
  });

  it("refuses an unknown project instead of listing the whole workspace", async () => {
    const res = await listTasks({ project: "GUARDIAN" });
    expect(res.error).toMatch(/No project matches 'GUARDIAN'/);
    expect(res.tasks).toBeUndefined();
  });

  it("does not substring-match: 'Guardian' is neither GuardianAI nor Guardian Ops", async () => {
    expect((await listTasks({ project: "Guardian" })).error).toBeDefined();
  });

  it("counts the filtered set, not the project", async () => {
    const res = await listTasks({ project: "GUARDIANAI", state: "Done" });
    expect(res.tasks.map((t: any) => t.identifier)).toEqual(["GUARDIANAI-2"]);
    expect(res.count).toBe(1);
    expect(res.total).toBe(1);
    expect(res.truncated).toBe(false);
  });

  it("applies the priority filter it advertises", async () => {
    const res = await listTasks({ project: "GUARDIANAI", priority: "urgent" });
    expect(res.tasks.map((t: any) => t.identifier)).toEqual(["GUARDIANAI-1"]);
  });
});

describe("the other project-scoped reads refuse an unknown project too", () => {
  it.each(["find_tasks", "list_states", "list_labels", "list_cycles", "list_members", "get_task_summary"])("%s", async (tool) => {
    const res = await executeToolCall(tool, { query: "x", project: "NOPE" }, owner);
    expect(res.error).toMatch(/No project matches 'NOPE'/);
  });

  it("find_tasks searches only the hinted project", async () => {
    const res = await executeToolCall("find_tasks", { query: "guardian", project_hint: "GUARDIANAI" }, owner);
    expect(res.tasks.map((t: any) => t.identifier)).toEqual(["GUARDIANAI-1", "GUARDIANAI-2"]);
  });
});

describe("resolveProjectRef", () => {
  it("reports an ambiguous reference instead of picking one", () => {
    const clash = [GUARD, { id: "x", identifier: "GUARDIANAI2", name: "GUARDIANAI" }];
    const res = resolveProjectRef("GuardianAI", clash);
    expect("error" in res && res.error).toMatch(/ambiguous/);
  });
});

describe("a caller's project_hint is never overridden by routing", () => {
  it("an unmatched hint writes nothing rather than routing by similarity", async () => {
    const client: any = { listProjects: async () => projects.list, cacheScope: () => "s" };
    const decision = await routeWorkItem({ workspace: "ws", title: "t", projectHint: "GUARDIAN" }, client);
    expect(decision.projectId).toBeNull();
    expect(decision.reason).toMatch(/matches no project exactly/);
  });
});

describe("project.create", () => {
  it("returns the existing project for an exact name + identifier match", () => {
    const plan = planProjectCreate({ name: "guardianai", identifier: "guardianai" }, projects.list);
    expect(plan).toEqual({ exists: GUARD });
  });

  it("refuses an identifier already used by a differently named project", () => {
    const plan = planProjectCreate({ name: "Something Else", identifier: "GUARDIANAI" }, projects.list);
    expect("error" in plan && plan.error).toMatch(/identifier GUARDIANAI is already used by project 'GuardianAI'/);
  });

  it("refuses a name already used under another identifier", () => {
    const plan = planProjectCreate({ name: "GuardianAI", identifier: "GAI2" }, projects.list);
    expect("error" in plan && plan.error).toMatch(/already exists with identifier GUARDIANAI/);
  });

  it.each(["", "WAY-TOO-LONG-KEY", "has space", "ÜML"])("rejects identifier %j", (identifier) => {
    expect("error" in planProjectCreate({ name: "X", identifier }, projects.list)).toBe(true);
  });

  it("creates with a normalised identifier and returns id, identifier, name and url", async () => {
    created.length = 0;
    const res = await executeToolCall("create_project", { name: "New Thing", identifier: "newt", description: "d" }, owner);
    expect(created).toEqual([{ name: "New Thing", identifier: "NEWT", description: "d" }]);
    expect(res).toMatchObject({ id: "new-id", identifier: "NEWT", name: "New Thing", status: "created", url: "https://tp.test/ws/projects/new-id/issues" });
  });

  it("does not modify or recreate an existing project", async () => {
    created.length = 0;
    const res = await executeToolCall("create_project", { name: "GuardianAI", identifier: "GUARDIANAI" }, owner);
    expect(res).toMatchObject({ id: GUARD.id, status: "exists" });
    expect(created).toHaveLength(0);
  });
});

describe("precheckToolCall", () => {
  it("names the target project so the approver can see it", async () => {
    const res = await precheckToolCall("page_create", { title: "Canary", project_hint: "GUARDIANAI" }, owner);
    expect(res.project).toEqual({ id: GUARD.id, identifier: "GUARDIANAI", name: "GuardianAI" });
  });

  it("refuses a missing required field", async () => {
    expect((await precheckToolCall("create_task", { title: "  " }, owner)).error).toBe("title is required");
  });

  it("refuses an unresolvable project", async () => {
    expect((await precheckToolCall("create_task", { title: "t", project_hint: "NOPE" }, owner)).error).toMatch(/No project matches/);
  });
});

describe("A2A and MCP expose the same surface", () => {
  it("every A2A skill is an MCP tool, and every MCP tool is an A2A skill", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const { getAllSkills } = await import("../../a2a/skill-registry.js");
    const tools = getToolDefinitions().map((t: any) => t.name).sort();
    const mapped = getAllSkills().map((s) => s.mcpTool).sort();
    expect(mapped).toEqual(tools);
  });
});
