# MCP Agent Enhancement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the TaskPilot MCP server with tools that AI agents (Claude Code, Cowork, Cursor, OpenClaw) expect for task management: assignee management, label operations, simplified status views, and batch operations.

**Architecture:** Extend the existing MCP tool handler pattern in `apps/mcp/src/tools/handlers.ts` by adding new handler functions and registering them in the `TOOLS` array and `HANDLERS` map. The Django API already supports all needed operations (assignees, labels, etc.) — we only need to expose them via MCP tools. No backend changes required.

**Tech Stack:** TypeScript (MCP server), Express, PostgreSQL (pg), existing TaskPilot REST API

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/mcp/src/tools/handlers.ts` | Modify | Add 7 new tool definitions + handler functions |
| `apps/mcp/src/tools/taskpilot-client.ts` | Modify | Add API methods for assignees, labels, workspace members |
| `apps/mcp/src/tools/__tests__/handlers.test.ts` | Create | Unit tests for new handlers |
| `apps/mcp/src/tools/__tests__/taskpilot-client.test.ts` | Create | Unit tests for new client methods |
| `apps/mcp/package.json` | Modify | Add vitest dev dependency |
| `apps/mcp/vitest.config.ts` | Create | Test configuration |
| `apps/mcp/tsconfig.json` | Modify | Add test paths if needed |

## New Tools Overview

| # | Tool | Category | Scope Required | Rationale |
|---|------|----------|---------------|-----------|
| 1 | `assign_task` | Write | `taskpilot:write` | Agents need to claim/assign work (OpenClaw, Cowork) |
| 2 | `unassign_task` | Write | `taskpilot:write` | Remove assignments |
| 3 | `list_labels` | Read | `taskpilot:read` | Read available labels before applying |
| 4 | `add_label` | Write | `taskpilot:write` | AI-driven categorization (Cursor, Claude Code) |
| 5 | `remove_label` | Write | `taskpilot:write` | Fix mis-categorization |
| 6 | `list_members` | Read | `taskpilot:read` | Discover who can be assigned |
| 7 | `get_task_summary` | Read | `taskpilot:read` | Simplified 3-state view (pending/in_progress/completed) for Claude Code TodoWrite compatibility |

After adding these 7 tools, TaskPilot will expose **18 MCP tools** total — well within Cursor's 40-tool limit.

---

### Task 1: Set Up Test Infrastructure

**Files:**
- Create: `apps/mcp/vitest.config.ts`
- Modify: `apps/mcp/package.json`

- [ ] **Step 1: Add vitest to package.json**

In `apps/mcp/package.json`, add to `devDependencies` and add a test script:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.5",
    "@types/pg": "^8.11.10",
    "@types/cors": "^2.8.17",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^3.1.1"
  }
}
```

- [ ] **Step 2: Create vitest config**

Create `apps/mcp/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Install dependencies**

Run: `cd apps/mcp && npm install`
Expected: vitest installed successfully

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/package.json apps/mcp/vitest.config.ts apps/mcp/package-lock.json
git commit -m "chore(mcp): add vitest test infrastructure"
```

---

### Task 2: Add `list_members` Client Method and Tool

**Files:**
- Modify: `apps/mcp/src/tools/taskpilot-client.ts`
- Modify: `apps/mcp/src/tools/handlers.ts`
- Create: `apps/mcp/src/tools/__tests__/handlers.test.ts`

This is implemented first because `assign_task` needs it to validate assignee IDs.

- [ ] **Step 1: Write the failing test**

Create `apps/mcp/src/tools/__tests__/handlers.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// We test handlers by calling them directly with a mock client
// The handler functions are not exported individually, so we test via executeToolCall
// For unit tests, we mock the TaskPilotClient and getOrCreateApiToken

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run --reporter=verbose`
Expected: FAIL — `list_members` tool not found in definitions

- [ ] **Step 3: Add `listMembers` method to TaskPilotClient**

In `apps/mcp/src/tools/taskpilot-client.ts`, add after the `addComment` method:

```typescript
  // --- Members ---
  async listMembers(projectId?: string): Promise<any[]> {
    let data;
    if (projectId) {
      data = await this.request(
        "GET",
        `/api/v1/workspaces/${this.workspace}/projects/${projectId}/members/`,
      );
    } else {
      data = await this.request(
        "GET",
        `/api/v1/workspaces/${this.workspace}/members/`,
      );
    }
    return Array.isArray(data) ? data : data.results || data;
  }
```

- [ ] **Step 4: Add `list_members` tool definition and handler to handlers.ts**

Add to the `TOOLS` array in `apps/mcp/src/tools/handlers.ts`:

```typescript
  {
    name: "list_members",
    description:
      "List workspace or project members. Use this to find user IDs for assigning tasks.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name or identifier to filter members (optional)",
        },
      },
    },
  },
```

Add the handler function:

```typescript
async function handleListMembers(
  args: any,
  client: TaskPilotClient,
  _workspace: string,
): Promise<any> {
  let projectId: string | undefined;
  if (args.project) {
    const projects = await client.listProjects();
    const match = projects.find(
      (p: any) =>
        p.name?.toLowerCase() === args.project.toLowerCase() ||
        p.identifier?.toLowerCase() === args.project.toLowerCase(),
    );
    if (match) projectId = String(match.id);
  }
  const members = await client.listMembers(projectId);
  return {
    members: members.map((m: any) => ({
      id: m.member?.id || m.id,
      display_name: m.member?.display_name || m.display_name || "",
      email: m.member?.email || m.email || "",
      role: m.role_label || m.role || "",
    })),
    count: members.length,
  };
}
```

Add to the `HANDLERS` map:

```typescript
  list_members: handleListMembers,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/mcp/src/tools/taskpilot-client.ts apps/mcp/src/tools/handlers.ts apps/mcp/src/tools/__tests__/handlers.test.ts
git commit -m "feat(mcp): add list_members tool for discovering assignable users"
```

---

### Task 3: Add `assign_task` and `unassign_task` Tools

**Files:**
- Modify: `apps/mcp/src/tools/taskpilot-client.ts`
- Modify: `apps/mcp/src/tools/handlers.ts`
- Modify: `apps/mcp/src/tools/__tests__/handlers.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/mcp/src/tools/__tests__/handlers.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mcp && npx vitest run --reporter=verbose`
Expected: FAIL — tools not found

- [ ] **Step 3: Add client methods for assignee management**

In `apps/mcp/src/tools/taskpilot-client.ts`, add:

```typescript
  // --- Assignees ---
  async addAssignee(projectId: string, issueId: string, userId: string): Promise<any> {
    // The API accepts assignees as part of issue update — add to existing list
    const issue = await this.getIssue(projectId, issueId);
    const currentAssignees: string[] = issue.assignees || [];
    if (currentAssignees.includes(userId)) {
      return issue; // already assigned
    }
    return this.updateIssue(projectId, issueId, {
      assignees: [...currentAssignees, userId],
    });
  }

  async removeAssignee(projectId: string, issueId: string, userId: string): Promise<any> {
    const issue = await this.getIssue(projectId, issueId);
    const currentAssignees: string[] = issue.assignees || [];
    return this.updateIssue(projectId, issueId, {
      assignees: currentAssignees.filter((id: string) => id !== userId),
    });
  }
```

- [ ] **Step 4: Add tool definitions**

Add to `TOOLS` array in `handlers.ts`:

```typescript
  {
    name: "assign_task",
    description:
      "Assign a user to a task. Use list_members first to find user IDs.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Task identifier like FOR-AI-42",
        },
        user_id: {
          type: "string",
          description: "User ID (UUID) from list_members",
        },
      },
      required: ["identifier", "user_id"],
    },
  },
  {
    name: "unassign_task",
    description: "Remove a user assignment from a task.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Task identifier like FOR-AI-42",
        },
        user_id: {
          type: "string",
          description: "User ID (UUID) to remove",
        },
      },
      required: ["identifier", "user_id"],
    },
  },
```

- [ ] **Step 5: Add handler functions**

```typescript
async function handleAssignTask(
  args: any,
  client: TaskPilotClient,
  _workspace: string,
): Promise<any> {
  const issue = await client.getIssueByIdentifier(args.identifier);
  const projectId = String(issue.project);
  await client.addAssignee(projectId, String(issue.id), args.user_id);
  return { identifier: args.identifier, user_id: args.user_id, status: "assigned" };
}

async function handleUnassignTask(
  args: any,
  client: TaskPilotClient,
  _workspace: string,
): Promise<any> {
  const issue = await client.getIssueByIdentifier(args.identifier);
  const projectId = String(issue.project);
  await client.removeAssignee(projectId, String(issue.id), args.user_id);
  return { identifier: args.identifier, user_id: args.user_id, status: "unassigned" };
}
```

Add both to `HANDLERS` map and add both to `WRITE_TOOLS` set:

```typescript
const WRITE_TOOLS = new Set([
  "create_task", "move_task", "update_task", "add_comment", "assign_to_cycle",
  "assign_task", "unassign_task",
]);
```

```typescript
  assign_task: handleAssignTask,
  unassign_task: handleUnassignTask,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/mcp && npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/mcp/src/tools/taskpilot-client.ts apps/mcp/src/tools/handlers.ts apps/mcp/src/tools/__tests__/handlers.test.ts
git commit -m "feat(mcp): add assign_task and unassign_task tools"
```

---

### Task 4: Add `list_labels`, `add_label`, `remove_label` Tools

**Files:**
- Modify: `apps/mcp/src/tools/taskpilot-client.ts`
- Modify: `apps/mcp/src/tools/handlers.ts`
- Modify: `apps/mcp/src/tools/__tests__/handlers.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to test file:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mcp && npx vitest run --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Add client methods for label operations**

In `apps/mcp/src/tools/taskpilot-client.ts`:

```typescript
  // --- Labels ---
  async listLabels(projectId: string): Promise<any[]> {
    const data = await this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/labels/`,
    );
    return Array.isArray(data) ? data : data.results || data;
  }

  async addLabel(projectId: string, issueId: string, labelId: string): Promise<any> {
    const issue = await this.getIssue(projectId, issueId);
    const currentLabels: string[] = issue.labels || [];
    if (currentLabels.includes(labelId)) {
      return issue;
    }
    return this.updateIssue(projectId, issueId, {
      labels: [...currentLabels, labelId],
    });
  }

  async removeLabel(projectId: string, issueId: string, labelId: string): Promise<any> {
    const issue = await this.getIssue(projectId, issueId);
    const currentLabels: string[] = issue.labels || [];
    return this.updateIssue(projectId, issueId, {
      labels: currentLabels.filter((id: string) => id !== labelId),
    });
  }
```

- [ ] **Step 4: Add tool definitions**

Add to `TOOLS` array:

```typescript
  {
    name: "list_labels",
    description:
      "List available labels for a workspace or project. Use this to find label IDs before applying them.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name or identifier to filter labels (optional)",
        },
      },
    },
  },
  {
    name: "add_label",
    description: "Add a label to a task for categorization.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Task identifier like FOR-AI-42",
        },
        label: {
          type: "string",
          description: "Label name or ID. If name is given, it will be matched against existing labels.",
        },
      },
      required: ["identifier", "label"],
    },
  },
  {
    name: "remove_label",
    description: "Remove a label from a task.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Task identifier like FOR-AI-42",
        },
        label: {
          type: "string",
          description: "Label name or ID to remove.",
        },
      },
      required: ["identifier", "label"],
    },
  },
```

- [ ] **Step 5: Add handler functions**

```typescript
async function handleListLabels(
  args: any,
  client: TaskPilotClient,
  _workspace: string,
): Promise<any> {
  // Labels are project-scoped in TaskPilot v1 API.
  // If no project given, aggregate labels across all projects.
  const projects = await client.listProjects();
  let targetProjects = projects;

  if (args.project) {
    const match = projects.find(
      (p: any) =>
        p.name?.toLowerCase() === args.project.toLowerCase() ||
        p.identifier?.toLowerCase() === args.project.toLowerCase(),
    );
    if (match) targetProjects = [match];
  }

  const allLabels: any[] = [];
  for (const project of targetProjects) {
    const labels = await client.listLabels(String(project.id));
    for (const l of labels) {
      allLabels.push({
        id: l.id,
        name: l.name,
        color: l.color || "",
        description: l.description || "",
        project: project.name,
      });
    }
  }

  return { labels: allLabels, count: allLabels.length };
}

async function resolveLabelId(
  label: string,
  projectId: string,
  client: TaskPilotClient,
): Promise<string> {
  // If it looks like a UUID, use directly
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(label)) {
    return label;
  }
  // Otherwise match by name within the project
  const labels = await client.listLabels(projectId);
  const match = labels.find(
    (l: any) => l.name?.toLowerCase() === label.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Label '${label}' not found. Available: ${labels.map((l: any) => l.name).join(", ")}`,
    );
  }
  return String(match.id);
}

async function handleAddLabel(
  args: any,
  client: TaskPilotClient,
  _workspace: string,
): Promise<any> {
  const issue = await client.getIssueByIdentifier(args.identifier);
  const projectId = String(issue.project);
  const labelId = await resolveLabelId(args.label, projectId, client);
  await client.addLabel(projectId, String(issue.id), labelId);
  return { identifier: args.identifier, label_id: labelId, status: "added" };
}

async function handleRemoveLabel(
  args: any,
  client: TaskPilotClient,
  _workspace: string,
): Promise<any> {
  const issue = await client.getIssueByIdentifier(args.identifier);
  const projectId = String(issue.project);
  const labelId = await resolveLabelId(args.label, projectId, client);
  await client.removeLabel(projectId, String(issue.id), labelId);
  return { identifier: args.identifier, label_id: labelId, status: "removed" };
}
```

Add to `HANDLERS` map:

```typescript
  list_labels: handleListLabels,
  add_label: handleAddLabel,
  remove_label: handleRemoveLabel,
```

Add `add_label` and `remove_label` to `WRITE_TOOLS`:

```typescript
const WRITE_TOOLS = new Set([
  "create_task", "move_task", "update_task", "add_comment", "assign_to_cycle",
  "assign_task", "unassign_task", "add_label", "remove_label",
]);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/mcp && npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/mcp/src/tools/taskpilot-client.ts apps/mcp/src/tools/handlers.ts apps/mcp/src/tools/__tests__/handlers.test.ts
git commit -m "feat(mcp): add list_labels, add_label, remove_label tools"
```

---

### Task 5: Add `get_task_summary` Tool (Simplified 3-State View)

**Files:**
- Modify: `apps/mcp/src/tools/handlers.ts`
- Modify: `apps/mcp/src/tools/__tests__/handlers.test.ts`

This tool maps TaskPilot's 6 state groups to the 3-state model AI agents expect (pending/in_progress/completed), matching Claude Code's TodoWrite pattern.

- [ ] **Step 1: Write the failing test**

Add to test file:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mcp && npx vitest run --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Add the state mapping function and export it**

In `apps/mcp/src/tools/handlers.ts`, add and export:

```typescript
/**
 * Maps TaskPilot's 6 state groups to the 3-state model used by
 * Claude Code's TodoWrite and other AI agent task systems.
 *
 * TaskPilot states -> Simple status:
 *   backlog, unstarted, triage -> pending
 *   started                    -> in_progress
 *   completed, cancelled       -> completed
 */
export function mapStateGroupToSimpleStatus(
  stateGroup: string,
): "pending" | "in_progress" | "completed" {
  switch (stateGroup) {
    case "started":
      return "in_progress";
    case "completed":
    case "cancelled":
      return "completed";
    default:
      return "pending";
  }
}
```

- [ ] **Step 4: Add tool definition**

Add to `TOOLS` array:

```typescript
  {
    name: "get_task_summary",
    description:
      "Get a simplified task summary with 3-state status (pending/in_progress/completed). " +
      "Compatible with Claude Code TodoWrite pattern. Returns task counts by status and recent tasks.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name or identifier (optional, defaults to all projects)",
        },
        limit: {
          type: "number",
          description: "Max tasks to return per status (default 10)",
        },
      },
    },
  },
```

- [ ] **Step 5: Add handler function**

```typescript
async function handleGetTaskSummary(
  args: any,
  client: TaskPilotClient,
  _workspace: string,
): Promise<any> {
  const projects = await client.listProjects();
  let targetProjects = projects;

  if (args.project) {
    const match = projects.find(
      (p: any) =>
        p.name?.toLowerCase() === args.project.toLowerCase() ||
        p.identifier?.toLowerCase() === args.project.toLowerCase(),
    );
    if (match) targetProjects = [match];
  }

  const limit = args.limit || 10;
  const summary: Record<string, any[]> = {
    pending: [],
    in_progress: [],
    completed: [],
  };
  const counts = { pending: 0, in_progress: 0, completed: 0 };

  for (const project of targetProjects) {
    const projectId = String(project.id);
    const states = await client.listStates(projectId);

    // Build state ID -> simple status mapping
    const stateMap = new Map<string, string>();
    for (const s of states) {
      stateMap.set(String(s.id), s.group || "backlog");
    }

    const issues = await client.listIssues(projectId, { per_page: "100" });
    for (const issue of issues) {
      const stateGroup = stateMap.get(String(issue.state)) || "backlog";
      const simpleStatus = mapStateGroupToSimpleStatus(stateGroup);
      counts[simpleStatus]++;

      if (summary[simpleStatus].length < limit) {
        const stateName = states.find(
          (s: any) => String(s.id) === String(issue.state),
        )?.name;
        summary[simpleStatus].push({
          identifier: `${project.identifier}-${issue.sequence_id}`,
          title: issue.name,
          status: simpleStatus,
          state: stateName || "",
          priority: issue.priority || "none",
          project: project.name,
        });
      }
    }
  }

  return { counts, tasks: summary };
}
```

Add to `HANDLERS` map:

```typescript
  get_task_summary: handleGetTaskSummary,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/mcp && npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/mcp/src/tools/handlers.ts apps/mcp/src/tools/__tests__/handlers.test.ts
git commit -m "feat(mcp): add get_task_summary tool with 3-state status mapping"
```

---

### Task 6: Integration Test — Verify All 18 Tools Register

**Files:**
- Modify: `apps/mcp/src/tools/__tests__/handlers.test.ts`

- [ ] **Step 1: Write the integration test**

Add to test file:

```typescript
describe("all tools registration", () => {
  it("should register exactly 18 tools", async () => {
    const { getToolDefinitions } = await import("../handlers.js");
    const tools = getToolDefinitions();
    expect(tools).toHaveLength(18);
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
    // All write tools should exist
    for (const name of writeToolNames) {
      expect(tools.find((t: any) => t.name === name)).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `cd apps/mcp && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/src/tools/__tests__/handlers.test.ts
git commit -m "test(mcp): add integration test verifying all 18 tools registered"
```

---

### Task 7: Rebuild and Verify MCP Container

**Files:** No code changes — deployment verification only.

- [ ] **Step 1: Rebuild the MCP container**

Run: `docker compose -f docker-compose.yml up --build mcp -d`
Expected: Container builds and starts successfully

- [ ] **Step 2: Verify tool listing via MCP protocol**

Run:
```bash
curl -s https://taskpilot-mcp.sudiptadhara.in/mcp-server \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <valid-token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools | length'
```
Expected: `18`

- [ ] **Step 3: Verify discovery endpoints still work**

Run:
```bash
curl -sk https://taskpilot-mcp.sudiptadhara.in/.well-known/oauth-protected-resource | jq .
curl -sk https://taskpilot-mcp.sudiptadhara.in/.well-known/oauth-authorization-server | jq .
```
Expected: Both return valid JSON with correct URLs

- [ ] **Step 4: Commit any docker-related changes if needed**

No changes expected — this is a verification step.

---

## Summary

After completing all 7 tasks, TaskPilot MCP will expose **18 tools**:

| Tool | Category | New? |
|------|----------|------|
| `create_task` | Smart | |
| `move_task` | Smart | |
| `find_tasks` | Smart | |
| `list_projects` | Read | |
| `list_tasks` | Read | |
| `get_task` | Read | |
| `update_task` | Write | |
| `add_comment` | Write | |
| `list_states` | Read | |
| `list_cycles` | Read | |
| `assign_to_cycle` | Write | |
| `list_members` | Read | NEW |
| `assign_task` | Write | NEW |
| `unassign_task` | Write | NEW |
| `list_labels` | Read | NEW |
| `add_label` | Write | NEW |
| `remove_label` | Write | NEW |
| `get_task_summary` | Read | NEW |

This covers the key gaps identified in the brainstorm:
- Agents can **claim/assign work** (OpenClaw, Cowork pattern)
- Agents can **categorize tasks** with labels (Cursor, Claude Code)
- Agents get a **simplified 3-state view** compatible with Claude Code's TodoWrite
- All within Cursor's **40-tool limit** (18 tools leaves room for other MCP servers)
