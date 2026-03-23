import { TaskPilotClient, getOrCreateApiToken } from "./taskpilot-client.js";
import { routeTask } from "./smart-router.js";
import { isCriticalAction } from "../a2a/skill-registry.js";
import { runApprovalLoop } from "../a2a/dharahil.js";
import { config } from "../config.js";

interface AuthContext {
  userId: string;
  workspaceSlug: string;
  clientId: string;
  scopes: string[];
}

const WRITE_TOOLS = new Set(["create_task", "move_task", "update_task", "add_comment", "assign_to_cycle", "assign_task", "unassign_task", "add_label", "remove_label"]);

/** Resolve state UUID to name using a states lookup map */
function resolveStateName(stateId: string | undefined, statesMap: Map<string, string>): string {
  if (!stateId) return "";
  return statesMap.get(stateId) || "";
}

/** Build a Map of state UUID -> state name for a project */
async function buildStatesMap(client: TaskPilotClient, projectId: string): Promise<Map<string, string>> {
  const states = await client.listStates(projectId);
  const map = new Map<string, string>();
  for (const s of states) {
    map.set(s.id, s.name || "");
  }
  return map;
}

/** Client-side text search filter */
function matchesSearch(issue: any, query: string): boolean {
  const q = query.toLowerCase();
  const text = `${issue.name || ""} ${issue.description_stripped || ""}`.toLowerCase();
  return q.split(/\s+/).every((word) => text.includes(word));
}

export function getToolDefinitions() {
  return TOOLS;
}

/**
 * Maps TaskPilot's 6 state groups to the 3-state model used by
 * Claude Code's TodoWrite and other AI agent task systems.
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

export async function executeToolCall(
  name: string,
  args: Record<string, any>,
  auth: AuthContext,
): Promise<any> {
  if (WRITE_TOOLS.has(name) && !auth.scopes.includes("taskpilot:write")) {
    throw new Error(`Tool '${name}' requires 'taskpilot:write' scope`);
  }
  if (!auth.scopes.includes("taskpilot:read")) {
    throw new Error("Requires 'taskpilot:read' scope");
  }

  const handler = HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // DharaHIL HITL check for critical actions (shared between MCP and A2A)
  if (config.dharahilEnabled && isCriticalAction(name, args)) {
    const decision = await runApprovalLoop({
      toolName: name,
      toolArgs: args,
      userId: auth.userId,
      taskId: `mcp_${Date.now()}`,
      contextSummary: `MCP: ${name} with args ${JSON.stringify(args)}`,
    }, config.mcpHitlTimeoutMs);

    if (!decision.shouldProceed) {
      throw new Error(`Action requires human approval: ${decision.reason || "Rejected or timed out"}`);
    }
  }

  // Get or create API token for this user from the shared database
  const apiToken = await getOrCreateApiToken(auth.userId, auth.workspaceSlug);
  const client = new TaskPilotClient(auth.workspaceSlug, apiToken);
  return handler(args, client, auth.workspaceSlug);
}

// --- Tool Definitions ---
const TOOLS = [
  {
    name: "create_task",
    description: "Create a task. Automatically routes to the right project, or specify project_hint.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Detailed description (optional)" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"], description: "Priority level" },
        project_hint: { type: "string", description: "Project name or identifier to route to (optional)" },
      },
      required: ["title"],
    },
  },
  {
    name: "move_task",
    description: "Move a task to a different state (e.g., In Progress, Done).",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Task identifier like FOR-AI-42" },
        state: { type: "string", description: "Target state name (e.g., 'In Progress', 'Done')" },
      },
      required: ["identifier", "state"],
    },
  },
  {
    name: "find_tasks",
    description: "Search for tasks across the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        state: { type: "string", description: "Filter by state name" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
        project_hint: { type: "string", description: "Filter by project name" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_projects",
    description: "List all projects in the workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_tasks",
    description: "List tasks with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or ID" },
        state: { type: "string", description: "State name filter" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
        limit: { type: "integer", description: "Max results (default 20)", default: 20 },
      },
    },
  },
  {
    name: "get_task",
    description: "Get full details of a task by identifier.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Task identifier like FOR-AI-42" },
      },
      required: ["identifier"],
    },
  },
  {
    name: "update_task",
    description: "Update task fields (title, description, priority, dates).",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Task identifier like FOR-AI-42" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        target_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["identifier"],
    },
  },
  {
    name: "add_comment",
    description: "Add a comment to a task.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Task identifier like FOR-AI-42" },
        comment: { type: "string", description: "Comment text" },
      },
      required: ["identifier", "comment"],
    },
  },
  {
    name: "list_states",
    description: "List workflow states for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or ID (optional)" },
      },
    },
  },
  {
    name: "list_cycles",
    description: "List sprints/cycles for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or ID" },
      },
      required: ["project"],
    },
  },
  {
    name: "assign_to_cycle",
    description: "Add a task to a sprint/cycle.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Task identifier like FOR-AI-42" },
        cycle_id: { type: "string", description: "Cycle UUID" },
      },
      required: ["identifier", "cycle_id"],
    },
  },
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
];

// --- Handler Implementations ---

async function handleCreateTask(args: any, client: TaskPilotClient, workspace: string) {
  const projects = await client.listProjects();
  const projectId = await routeTask(workspace, args.title, args.project_hint, client);
  const project = projects.find((p: any) => String(p.id) === projectId);
  const data: any = { name: args.title };
  if (args.description) data.description_html = `<p>${args.description}</p>`;
  if (args.priority) data.priority = args.priority;
  const issue = await client.createIssue(projectId, data);
  return {
    identifier: `${project?.identifier || "?"}-${issue.sequence_id || "?"}`,
    id: issue.id,
    project: project?.name || "",
    title: issue.name,
  };
}

async function handleMoveTask(args: any, client: TaskPilotClient, _workspace: string) {
  const issue = await client.getIssueByIdentifier(args.identifier);
  const projectId = String(issue.project);
  const states = await client.listStates(projectId);
  const targetState = states.find((s: any) => args.state.toLowerCase().includes(s.name?.toLowerCase()) || s.name?.toLowerCase().includes(args.state.toLowerCase()));
  if (!targetState) {
    return { error: `State '${args.state}' not found. Available: ${states.map((s: any) => s.name)}` };
  }
  await client.updateIssue(projectId, String(issue.id), { state: targetState.id });
  return { identifier: args.identifier, state: targetState.name, status: "moved" };
}

async function handleFindTasks(args: any, client: TaskPilotClient, _workspace: string) {
  const projects = await client.listProjects();
  const results: any[] = [];
  for (const project of projects) {
    if (args.project_hint && !project.name?.toLowerCase().includes(args.project_hint.toLowerCase())) continue;
    const issues = await client.listIssues(String(project.id));
    const statesMap = await buildStatesMap(client, String(project.id));
    const filtered = (issues || []).filter((issue: any) => matchesSearch(issue, args.query));
    for (const issue of filtered.slice(0, 10)) {
      results.push({
        identifier: `${project.identifier || "?"}-${issue.sequence_id || "?"}`,
        title: issue.name || "",
        state: resolveStateName(issue.state, statesMap),
        priority: issue.priority || "",
        project: project.name || "",
      });
    }
  }
  return { tasks: results.slice(0, 20), count: results.length };
}

async function handleListProjects(_args: any, client: TaskPilotClient, _workspace: string) {
  const projects = await client.listProjects();
  return {
    projects: projects.map((p: any) => ({
      id: p.id,
      name: p.name,
      identifier: p.identifier || "",
      description: p.description || "",
    })),
  };
}

async function handleListTasks(args: any, client: TaskPilotClient, _workspace: string) {
  const projects = await client.listProjects();
  let targetProjects = projects;
  if (args.project) {
    const match = projects.find(
      (p: any) => args.project.toLowerCase().includes(p.name?.toLowerCase()) || args.project === String(p.id),
    );
    if (match) targetProjects = [match];
  }
  const results: any[] = [];
  const limit = args.limit || 20;
  for (const project of targetProjects) {
    const issues = await client.listIssues(String(project.id));
    const statesMap = await buildStatesMap(client, String(project.id));
    for (const issue of issues || []) {
      results.push({
        identifier: `${project.identifier || "?"}-${issue.sequence_id || "?"}`,
        title: issue.name || "",
        state: resolveStateName(issue.state, statesMap),
        priority: issue.priority || "",
      });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }
  return { tasks: results, count: results.length };
}

async function handleGetTask(args: any, client: TaskPilotClient, _workspace: string) {
  const issue = await client.getIssueByIdentifier(args.identifier);
  const statesMap = await buildStatesMap(client, String(issue.project));
  return {
    id: issue.id,
    identifier: args.identifier,
    title: issue.name || "",
    description: issue.description_stripped || "",
    state: resolveStateName(issue.state, statesMap),
    priority: issue.priority || "",
    assignees: (issue.assignee_detail || issue.assignees || []).map((a: any) => a.display_name || a),
    start_date: issue.start_date,
    target_date: issue.target_date,
    created_at: issue.created_at,
  };
}

async function handleUpdateTask(args: any, client: TaskPilotClient, _workspace: string) {
  const issue = await client.getIssueByIdentifier(args.identifier);
  const data: any = {};
  if (args.title) data.name = args.title;
  if (args.description) data.description_html = `<p>${args.description}</p>`;
  if (args.priority) data.priority = args.priority;
  if (args.start_date) data.start_date = args.start_date;
  if (args.target_date) data.target_date = args.target_date;
  if (Object.keys(data).length === 0) return { error: "No fields to update" };
  await client.updateIssue(String(issue.project), String(issue.id), data);
  return { identifier: args.identifier, status: "updated", fields: Object.keys(data) };
}

async function handleAddComment(args: any, client: TaskPilotClient, _workspace: string) {
  const issue = await client.getIssueByIdentifier(args.identifier);
  const comment = await client.addComment(String(issue.project), String(issue.id), args.comment);
  return { identifier: args.identifier, comment_id: comment.id || "", status: "added" };
}

async function handleListStates(args: any, client: TaskPilotClient, _workspace: string) {
  const projects = await client.listProjects();
  let targetProjects = projects;
  if (args.project) {
    const match = projects.find((p: any) => args.project.toLowerCase().includes(p.name?.toLowerCase()));
    if (match) targetProjects = [match];
  }
  // Aggregate states from target projects (v1 API only supports project-level states)
  const allStates: any[] = [];
  const seen = new Set<string>();
  for (const p of targetProjects) {
    const states = await client.listStates(String(p.id));
    for (const s of states) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        allStates.push({ id: s.id, name: s.name, group: s.group || "" });
      }
    }
  }
  return { states: allStates };
}

async function handleListCycles(args: any, client: TaskPilotClient, _workspace: string) {
  const projects = await client.listProjects();
  const p = projects.find((p: any) => args.project.toLowerCase().includes(p.name?.toLowerCase()));
  if (!p) return { error: `Project '${args.project}' not found` };
  const cycles = await client.listCycles(String(p.id));
  return {
    cycles: cycles.map((c: any) => ({
      id: c.id,
      name: c.name,
      start_date: c.start_date,
      end_date: c.end_date,
    })),
  };
}

async function handleAssignToCycle(args: any, client: TaskPilotClient, _workspace: string) {
  const issue = await client.getIssueByIdentifier(args.identifier);
  await client.addIssueToCycle(String(issue.project), args.cycle_id, [String(issue.id)]);
  return { identifier: args.identifier, cycle_id: args.cycle_id, status: "assigned" };
}

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
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(label)) {
    return label;
  }
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

const HANDLERS: Record<string, (args: any, client: TaskPilotClient, workspace: string) => Promise<any>> = {
  create_task: handleCreateTask,
  move_task: handleMoveTask,
  find_tasks: handleFindTasks,
  list_projects: handleListProjects,
  list_tasks: handleListTasks,
  get_task: handleGetTask,
  update_task: handleUpdateTask,
  add_comment: handleAddComment,
  list_states: handleListStates,
  list_cycles: handleListCycles,
  assign_to_cycle: handleAssignToCycle,
  list_members: handleListMembers,
  assign_task: handleAssignTask,
  unassign_task: handleUnassignTask,
  list_labels: handleListLabels,
  add_label: handleAddLabel,
  remove_label: handleRemoveLabel,
  get_task_summary: handleGetTaskSummary,
};
