import { TaskPilotClient, getOrCreateApiToken } from "./taskpilot-client.js";
import { routeWorkItem } from "../routing/router.js";
import { findDuplicate } from "../routing/dedupe.js";
import { searchPages } from "../knowledge/page-search.js";
import { buildIndexText } from "../knowledge/index-sync.js";
import { isCriticalAction, getWriteTools, requiresHumanApproval, isExternalPeer } from "../a2a/skill-registry.js";
import { runApprovalLoop } from "../a2a/dharahil.js";
import { logAuditEvent } from "../a2a/audit-log.js";
import { config } from "../config.js";

interface AuthContext {
  userId: string;
  workspaceSlug: string;
  clientId: string;
  scopes: string[];
}

// Derived from the registry, not hand-listed: a skill declaring taskpilot:write
// is scope-gated by construction, so adding one cannot forget this file.
const WRITE_TOOLS = getWriteTools();

/** Exactly the values IssueRelationCreateSerializer accepts. */
export const RELATION_TYPES = [
  "blocking", "blocked_by", "duplicate", "relates_to",
  "start_before", "start_after", "finish_before", "finish_after",
] as const;

export function isValidRelationType(type: string): boolean {
  return (RELATION_TYPES as readonly string[]).includes(type);
}

/** Exactly the categories CATEGORY_TO_PROJECT accepts in call_note.py. Each
 * maps server-side to a hardcoded project for this workspace — the API has
 * no project field to route with. */
export const CALL_NOTE_CATEGORIES = ["home_automation", "export", "event", "prodevs"] as const;

export function isValidCallNoteCategory(category: string): boolean {
  return (CALL_NOTE_CATEGORIES as readonly string[]).includes(category);
}

/** TaskPilot stores intake status as a small int; agents need the name. */
/** IntakeIssue.status for an item nobody has triaged yet (intake.py:43). */
export const INTAKE_PENDING = -2;

export function intakeStatusName(status: number): string {
  switch (status) {
    case -2: return "pending";
    case -1: return "rejected";
    case 0: return "snoozed";
    case 1: return "accepted";
    case 2: return "duplicate";
    default: return `unknown(${status})`;
  }
}

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

/** Trim a page to what an agent needs: identity, provenance, and whether it can be edited. */
export function formatPageSummary(page: any) {
  return {
    id: page.id,
    name: page.name || "",
    // MeetEcho writes most pages; a locally authored one has no external source.
    source: page.external_source || "local",
    // Without the id, knowing a page came from "meetecho" gives an agent no way
    // to correlate it back to the record it came from.
    external_id: page.external_id || null,
    locked: Boolean(page.is_locked),
    archived: Boolean(page.archived_at),
    updated_at: page.updated_at,
  };
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
  /**
   * Set by the A2A executor when the human already approved this exact action
   * through the A2A task's own auth_required flow. Without it the approval is
   * requested twice for one action — once by the protocol handler before the
   * task runs, then again here when the approved task executes — and if the
   * second request expires the task fails with "waiting for approval" after
   * the human has already approved.
   */
  approvalAlreadyGranted = false,
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

  // One approval decision for both paths: destructive actions always, and ANY
  // write by an external peer. See requiresHumanApproval in skill-registry.
  const needsApproval = requiresHumanApproval(name, args, auth.clientId);

  if (config.dharahilEnabled && !approvalAlreadyGranted && needsApproval) {
    const who = isExternalPeer(auth.clientId) ? `peer ${auth.clientId}` : "owner session";
    const decision = await runApprovalLoop({
      toolName: name,
      toolArgs: args,
      userId: auth.userId,
      taskId: `mcp_${Date.now()}`,
      contextSummary: `${who}: ${name} with args ${JSON.stringify(args)}`,
    });

    // Every approval outcome is recorded. Previously the MCP path wrote no
    // a2a_approvals row and no audit entry, so a destructive write approved or
    // denied here left no trace at all.
    await logAuditEvent({
      userId: auth.userId,
      clientId: auth.clientId,
      ipAddress: "",
      operation: decision.shouldProceed ? "approval.approved" : "approval.denied",
      skill: name,
      success: decision.shouldProceed,
      errorMessage: decision.shouldProceed ? undefined : decision.reason,
    });

    if (!decision.shouldProceed) {
      if (decision.reason?.includes("expired")) {
        throw new Error(`Waiting for human approval on Telegram/Slack. The action has NOT been executed yet. Please try again in a minute — the human may still approve.`);
      }
      throw new Error(`Human approval denied for ${name}: ${decision.reason || "Rejected"}. The action was NOT executed.`);
    }
  }

  // Get or create API token for this user from the shared database
  const apiToken = await getOrCreateApiToken(auth.userId, auth.workspaceSlug);
  const client = new TaskPilotClient(auth.workspaceSlug, apiToken);

  // The MCP path had no audit trail whatsoever — logAuditEvent was called from
  // eleven places, all of them on the A2A path. A tool call arriving over MCP
  // was invisible after the fact.
  try {
    const result = await handler(args, client, auth.workspaceSlug);
    if (WRITE_TOOLS.has(name)) {
      await logAuditEvent({
        userId: auth.userId,
        clientId: auth.clientId,
        ipAddress: "",
        operation: "tool.executed",
        skill: name,
        success: true,
        metadata: { approved: needsApproval },
      });
    }
    return result;
  } catch (err: any) {
    if (WRITE_TOOLS.has(name)) {
      await logAuditEvent({
        userId: auth.userId,
        clientId: auth.clientId,
        ipAddress: "",
        operation: "tool.failed",
        skill: name,
        success: false,
        errorMessage: err?.message?.slice(0, 300),
      });
    }
    throw err;
  }
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
        force_create: {
          type: "boolean",
          description: "Create even if a near-duplicate exists. Default false.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "move_task",
    description: "Move a task to a different state (e.g., In Progress, Done, Cancelled). Moving to Cancelled requires human approval. There is NO delete — use Cancelled state instead.",
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
  {
    name: "bulk_cancel_tasks",
    description:
      "Cancel multiple tasks at once by moving them to Cancelled state. " +
      "Requires human approval via DharaHIL. Use this instead of calling move_task repeatedly. " +
      "There is NO delete operation in TaskPilot — cancellation is the way to remove tasks.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name or identifier. Required — specify which project to cancel tasks in.",
        },
        identifiers: {
          type: "array",
          items: { type: "string" },
          description: "List of task identifiers to cancel (e.g., ['PROJ-1', 'PROJ-2']). If omitted, cancels ALL non-cancelled tasks in the project.",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "page_list",
    description: "List pages (documents) in a project, or across all projects. Pages are documents, not tasks.",
    inputSchema: {
      type: "object",
      properties: {
        project_hint: { type: "string", description: "Project name or identifier to limit to (optional)" },
        cursor: {
          type: "string",
          description: "next_cursor from a previous call, to page further. Requires project_hint, since a cursor is per-project.",
        },
      },
    },
  },
  {
    name: "page_search",
    description: "Find pages by what they are about, using semantic search. Use this instead of page_list when looking for a page by topic rather than paging through them.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the page is about" },
        limit: { type: "number", description: "Maximum matches to return (default 10, max 25)" },
      },
      required: ["query"],
    },
  },
  {
    name: "page_get",
    description: "Get one page including its content.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        page_id: { type: "string", description: "Page UUID" },
      },
      required: ["project_id", "page_id"],
    },
  },
  {
    name: "page_create",
    description: "Create a page (document). Automatically routes to the right project, or specify project_hint.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Page title" },
        content: { type: "string", description: "Page content as HTML (optional)" },
        project_hint: { type: "string", description: "Project name or identifier to route to (optional)" },
      },
      required: ["title"],
    },
  },
  {
    name: "page_update",
    description: "Replace a page's content. Refuses pages synced from an external system (like MeetEcho) unless forced.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        page_id: { type: "string", description: "Page UUID" },
        content: { type: "string", description: "New page content as HTML" },
        force: { type: "boolean", description: "Edit an externally-synced page anyway. Default false." },
      },
      required: ["project_id", "page_id", "content"],
    },
  },
  {
    name: "page_archive",
    description: "Archive a page, removing it from view. Requires human approval.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        page_id: { type: "string", description: "Page UUID" },
        force: {
          type: "boolean",
          description: "Archive even if the page is synced from an external system. Default false.",
        },
      },
      required: ["project_id", "page_id"],
    },
  },
  {
    name: "intake_list",
    description: "List work items sitting in a project's Intake queue — items the router couldn't confidently place, waiting for a human or agent to triage.",
    inputSchema: {
      type: "object",
      properties: {
        include_triaged: {
          type: "boolean",
          description: "Also return items already accepted or rejected. Default false.",
        },
        project: { type: "string", description: "Project name or identifier (optional — defaults to the workspace's configured intake project)" },
      },
    },
  },
  {
    name: "intake_triage",
    description: "Accept or reject a queued intake item. Accepting moves the task out of Triage into the project's default state; rejecting marks it Rejected.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        issue_id: { type: "string", description: "Issue UUID, from intake_list" },
        decision: { type: "string", enum: ["accept", "reject"], description: "Triage decision" },
      },
      required: ["project_id", "issue_id", "decision"],
    },
  },
  {
    name: "relation_list",
    description: "List a task's relations (blocking, duplicate, relates_to, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Task identifier like FOR-AI-42" },
      },
      required: ["identifier"],
    },
  },
  {
    name: "relation_add",
    description:
      "Link two tasks with a relation, e.g. to mark one a duplicate of another instead of refusing to create it. " +
      `Valid relation_type values: ${RELATION_TYPES.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Source task identifier like FOR-AI-42" },
        target_identifier: { type: "string", description: "Task identifier to relate to, e.g. FOR-AI-17" },
        relation_type: { type: "string", enum: [...RELATION_TYPES], description: "Relation type" },
      },
      required: ["identifier", "target_identifier", "relation_type"],
    },
  },
  {
    name: "callnote_upsert",
    description:
      "Create or append a call note for a phone number. Workspace-scoped, no project — " +
      "one work item is kept per (category, phone); calling again for the same number appends " +
      `a new dated block instead of creating a duplicate. category must be one of: ${CALL_NOTE_CATEGORIES.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Caller's phone number (any format; at least 10 digits)" },
        category: { type: "string", enum: [...CALL_NOTE_CATEGORIES], description: "Which business this call belongs to" },
        details_html: { type: "string", description: "HTML content for this call's note block" },
        caller_name: { type: "string", description: "Caller's name (optional, only used when creating a new note)" },
      },
      required: ["phone", "category", "details_html"],
    },
  },
  {
    name: "callnote_lookup",
    description:
      "Look up open call-note matters for a phone number across all categories. " +
      "Returns a compact summary and greeting; each matter's identifier can be passed to get_task for full detail.",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Caller's phone number (any format; at least 10 digits)" },
        direction: { type: "string", enum: ["inbound", "outbound"], description: "Call direction (optional, default inbound)" },
        caller_name: { type: "string", description: "Dialer-supplied caller name, used only when no existing matter is found (optional)" },
      },
      required: ["phone"],
    },
  },
];

// --- Handler Implementations ---

/** Resolve the configured intake project for a workspace, or null. */
export function resolveIntakeProject(
  workspace: string,
  projects: { id: string; identifier: string }[],
  configured: Map<string, string>,
): string | null {
  const identifier = configured.get(workspace);
  if (!identifier) return null;

  const project = projects.find(
    (candidate) => candidate.identifier.toLowerCase() === identifier.toLowerCase(),
  );
  return project ? project.id : null;
}

async function handleCreateTask(args: any, client: TaskPilotClient, workspace: string) {
  const decision = await routeWorkItem(
    {
      workspace,
      title: args.title,
      description: args.description,
      projectHint: args.project_hint,
    },
    client,
  );

  const data: any = { name: args.title };
  if (args.description) data.description_html = `<p>${args.description}</p>`;
  if (args.priority) data.priority = args.priority;

  if (decision.projectId) {
    const project = decision.candidates.find((candidate) => candidate.id === decision.projectId);

    // Reuse the router's embedding: it was computed from this exact text, and
    // the CPU embedder is the slowest step in creating an item.
    const duplicate = await findDuplicate(
      buildIndexText({ name: args.title, description_stripped: args.description ?? null }),
      { projectIds: [decision.projectId], vector: decision.vector },
    );

    if (duplicate && !args.force_create) {
      return {
        status: "possible_duplicate",
        duplicate_of: duplicate.identifier,
        score: duplicate.score,
        hint: "Comment on the existing item, or pass force_create: true to file anyway.",
      };
    }

    const issue = await client.createIssue(decision.projectId, data);

    return {
      identifier: `${project?.identifier || "?"}-${issue.sequence_id || "?"}`,
      id: issue.id,
      project: project?.name || "",
      title: issue.name,
      routing: {
        confidence: decision.confidence,
        reason: decision.reason,
        source: decision.source,
      },
    };
  }

  // Not confident. File into Intake if one is configured for this workspace.
  const intakeProjectId = resolveIntakeProject(
    workspace,
    decision.candidates,
    config.intakeProjects,
  );

  if (intakeProjectId) {
    const intake = await client.createIntakeIssue(intakeProjectId, {
      name: args.title,
      description_html: data.description_html,
      priority: args.priority,
    });

    return {
      status: "filed_to_intake",
      id: intake?.issue?.id || intake?.id,
      reason: decision.reason,
      candidates: decision.candidates.map((candidate) => candidate.identifier),
    };
  }

  // Nothing configured and not confident: write nothing, and say why.
  return {
    status: "undecided",
    reason: decision.reason,
    candidates: decision.candidates.map((candidate) => candidate.identifier),
    hint: "Pass project_hint, or set A2A_INTAKE_PROJECTS so uncertain items have a home.",
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
  // count describes what is in `tasks`; the pre-slice total went out as a
  // count of items the caller never received.
  const returned = results.slice(0, 20);
  return { tasks: returned, count: returned.length, truncated: results.length > returned.length };
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

async function handleBulkCancelTasks(args: any, client: TaskPilotClient, _workspace: string) {
  // Resolve project
  const projects = await client.listProjects();
  const project = projects.find(
    (p: any) =>
      p.name?.toLowerCase() === args.project?.toLowerCase() ||
      p.identifier?.toLowerCase() === args.project?.toLowerCase(),
  );
  if (!project) {
    return { error: `Project '${args.project}' not found. Available: ${projects.map((p: any) => p.name).join(", ")}` };
  }
  const projectId = String(project.id);

  // Find the Cancelled state
  const states = await client.listStates(projectId);
  const cancelledState = states.find((s: any) => s.group === "cancelled");
  if (!cancelledState) {
    return { error: "No 'Cancelled' state found in this project" };
  }

  // Get all issues
  const allIssues = await client.listIssues(projectId);

  // Filter: specific identifiers or all non-cancelled
  let toCancel: any[];
  if (args.identifiers && args.identifiers.length > 0) {
    const ids = new Set(args.identifiers.map((id: string) => id.toUpperCase()));
    toCancel = allIssues.filter((issue: any) => {
      const identifier = `${project.identifier}-${issue.sequence_id}`.toUpperCase();
      return ids.has(identifier);
    });
  } else {
    // Cancel all non-cancelled tasks
    toCancel = allIssues.filter((issue: any) => String(issue.state) !== String(cancelledState.id));
  }

  if (toCancel.length === 0) {
    return { cancelled: 0, message: "No tasks to cancel" };
  }

  // Cancel each task
  const cancelled: string[] = [];
  const errors: string[] = [];
  for (const issue of toCancel) {
    try {
      await client.updateIssue(projectId, String(issue.id), { state: cancelledState.id });
      cancelled.push(`${project.identifier}-${issue.sequence_id}`);
    } catch (err: any) {
      errors.push(`${project.identifier}-${issue.sequence_id}: ${err.message}`);
    }
  }

  return {
    cancelled: cancelled.length,
    failed: errors.length,
    cancelled_tasks: cancelled,
    errors: errors.length > 0 ? errors : undefined,
    project: project.name,
  };
}

async function handleListPages(args: any, client: TaskPilotClient, _workspace: string) {
  const projects = await client.listProjects();
  const project = args.project_hint
    ? projects.find(
        (p: any) =>
          p.identifier?.toLowerCase() === args.project_hint.toLowerCase() ||
          p.name?.toLowerCase() === args.project_hint.toLowerCase(),
      )
    : null;

  if (args.project_hint && !project) {
    return { error: `No project matching '${args.project_hint}'. Available: ${projects.map((p: any) => p.identifier).join(", ")}` };
  }

  const targets = project ? [project] : projects;
  const pages: any[] = [];
  // A cursor only means anything against one project's sequence.
  let nextCursor: string | null = null;
  // The API's own total, not a count of what we fetched — those differ by three
  // orders of magnitude on a project like PKM Sources.
  let totalAcrossProjects = 0;
  for (const target of targets) {
    // Bounded per project, and the cursor is carried back out so pages past
    // the first are reachable — without it the other 4,700 were not.
    const page = await client.listPagesPage(String(target.id), {
      per_page: "50",
      ...(args.cursor && targets.length === 1 ? { cursor: args.cursor } : {}),
    });
    const found = page.results;
    if (page.total !== null) totalAcrossProjects += page.total;
    if (targets.length === 1) {
      nextCursor = page.hasMore ? page.nextCursor : null;
    }
    for (const page of found.slice(0, 50)) {
      pages.push({ ...formatPageSummary(page), project: target.identifier });
    }
  }

  const returned = pages.slice(0, 100);
  // count describes what is in `pages`. Reporting the pre-slice total here read
  // as "there are 250" while handing back 100.
  return {
    pages: returned,
    count: returned.length,
    // How many exist, as opposed to how many are in this response.
    total_available: totalAcrossProjects,
    truncated: totalAcrossProjects > returned.length,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

async function handleSearchPages(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.query) return { error: "query is required" };

  const projects = await client.listProjects();
  const matches = await searchPages(args.query, {
    projectIds: projects.map((p: any) => String(p.id)),
    limit: Math.min(Number(args.limit) || 10, 25),
  });

  const byId = new Map(projects.map((p: any) => [String(p.id), p]));
  return {
    pages: matches.map((m) => ({
      id: m.page_id,
      name: m.name,
      source: m.source,
      project: (byId.get(m.project_id) as any)?.identifier || "",
      project_id: m.project_id,
      score: Number(m.score.toFixed(3)),
    })),
    count: matches.length,
  };
}

async function handleGetPage(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.page_id || !args.project_id) {
    return { error: "Both project_id and page_id are required" };
  }
  const page = await client.getPage(args.project_id, args.page_id);
  return {
    ...formatPageSummary(page),
    description_html: page.description_html || "",
  };
}

/**
 * Whether the agent may write to a page. Two different refusals: a locked page
 * is an explicit human decision and is never overridable, while an
 * externally-synced page is refusable-but-forceable, since the owning system
 * would overwrite our edit on its next sync.
 */
export function canAgentEditPage(page: any, force: boolean): { allowed: boolean; reason?: string } {
  if (page.is_locked) {
    return { allowed: false, reason: "Page is locked. Unlock it in TaskPilot first." };
  }
  if (page.external_source && !force) {
    return {
      allowed: false,
      reason: `Page is synced from ${page.external_source} and edits would be overwritten on its next sync. Pass force: true to edit anyway.`,
    };
  }
  return { allowed: true };
}

async function handleCreatePage(args: any, client: TaskPilotClient, workspace: string) {
  if (!args.title) return { error: "title is required" };

  const decision = await routeWorkItem(
    { workspace, title: args.title, description: args.content, projectHint: args.project_hint },
    client,
  );

  if (!decision.projectId) {
    return {
      status: "undecided",
      reason: decision.reason,
      candidates: decision.candidates.map((c) => c.identifier),
      hint: "Pass project_hint to say where this page belongs.",
    };
  }

  const project = decision.candidates.find((c) => c.id === decision.projectId);
  const page = await client.createPage(decision.projectId, {
    name: args.title,
    // Pass content through as given, matching page_update. Wrapping it in <p>
    // here meant an agent sending "<h1>T</h1><p>body</p>" got invalid nesting
    // on create but the exact string on update, so a get -> edit -> update
    // round trip could not reproduce what create produced.
    ...(args.content ? { description_html: args.content } : {}),
  });

  return {
    id: page.id,
    name: page.name,
    project: project?.identifier || "",
    routing: { confidence: decision.confidence, reason: decision.reason, source: decision.source },
  };
}

async function handleUpdatePage(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.project_id || !args.page_id || !args.content) {
    return { error: "project_id, page_id and content are required" };
  }

  const page = await client.getPage(args.project_id, args.page_id);
  const verdict = canAgentEditPage(page, Boolean(args.force));
  if (!verdict.allowed) return { error: verdict.reason };

  await client.updatePageDescription(args.project_id, args.page_id, args.content);
  return { id: args.page_id, name: page.name, status: "updated" };
}

async function handleArchivePage(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.project_id || !args.page_id) {
    return { error: "project_id and page_id are required" };
  }

  // Archive is the MOST destructive page operation, not the least: the API
  // archives the page and every descendant under it, and — unlike the page and
  // description PATCH endpoints — performs no is_locked check of its own. So
  // this path needs the guard more than update does, not less.
  const page = await client.getPage(args.project_id, args.page_id);
  const verdict = canAgentEditPage(page, Boolean(args.force));
  if (!verdict.allowed) return { error: verdict.reason };

  await client.archivePage(args.project_id, args.page_id);

  // Name and provenance go in the result so the human approval prompt shows
  // WHAT is being archived, not just two opaque UUIDs.
  return {
    id: args.page_id,
    name: page.name || "",
    source: page.external_source || "local",
    status: "archived",
  };
}

async function handleListIntake(args: any, client: TaskPilotClient, workspace: string) {
  const projects = await client.listProjects();
  let projectId: string | null = null;

  if (args.project) {
    const match = projects.find(
      (p: any) =>
        p.name?.toLowerCase() === args.project.toLowerCase() ||
        p.identifier?.toLowerCase() === args.project.toLowerCase(),
    );
    if (!match) return { error: `Project '${args.project}' not found` };
    projectId = String(match.id);
  } else {
    projectId = resolveIntakeProject(workspace, projects, config.intakeProjects);
  }

  if (!projectId) {
    return { error: "No project specified and no intake project configured for this workspace. Pass project, or set A2A_INTAKE_PROJECTS." };
  }

  const items = await client.listIntakeIssues(projectId);

  // The API's list filters only on snoozed_till, so accepted and rejected rows
  // come back alongside pending ones — contradicting what this tool promises.
  // include_triaged is there for auditing what was already decided.
  const pending = args.include_triaged
    ? items
    : items.filter((item: any) => Number(item.status) === INTAKE_PENDING);

  return {
    items: pending.map((item: any) => ({
      issue_id: item.issue,
      title: item.issue_detail?.name || "",
      status: intakeStatusName(item.status),
      priority: item.issue_detail?.priority || "",
      created_at: item.created_at,
    })),
    count: pending.length,
  };
}

const INTAKE_DECISION_STATUS: Record<string, number> = { accept: 1, reject: -1 };

async function handleTriageIntake(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.project_id || !args.issue_id || !args.decision) {
    return { error: "project_id, issue_id and decision are required" };
  }
  const status = INTAKE_DECISION_STATUS[args.decision];
  if (status === undefined) {
    return { error: `decision must be 'accept' or 'reject', got '${args.decision}'` };
  }
  // The API applies the status change only for roles above MEMBER, and
  // otherwise returns 200 with the row unchanged. Reporting success on that
  // would tell the caller the queue was cleared when it was not.
  const updated = await client.updateIntakeIssue(args.project_id, args.issue_id, { status });
  const applied = updated?.status;

  if (applied !== undefined && Number(applied) !== status) {
    return {
      error: `Triage did not apply — the item is still '${intakeStatusName(Number(applied))}'. This usually means the account lacks the project role required to triage.`,
      issue_id: args.issue_id,
    };
  }

  return { issue_id: args.issue_id, status: intakeStatusName(status) };
}

async function handleListRelations(args: any, client: TaskPilotClient, _workspace: string) {
  const issue = await client.getIssueByIdentifier(args.identifier);
  const relations = await client.listRelations(String(issue.project), String(issue.id));
  return { identifier: args.identifier, relations };
}

/**
 * Relations are project-scoped on the *source* item's project — the POST path
 * carries it. When the two items live in different projects (as TaskPilot's
 * known triplicate does, spanning two), we still resolve each independently
 * and never assume they share a project; only the source's project goes in
 * the URL, and the target's id goes in the body.
 */
async function handleAddRelation(args: any, client: TaskPilotClient, _workspace: string) {
  if (!isValidRelationType(args.relation_type)) {
    return {
      error: `relation_type must be one of: ${RELATION_TYPES.join(", ")}`,
      valid_types: RELATION_TYPES,
    };
  }
  if (!args.identifier || !args.target_identifier) {
    return { error: "identifier and target_identifier are required" };
  }

  const source = await client.getIssueByIdentifier(args.identifier);
  const target = await client.getIssueByIdentifier(args.target_identifier);
  const created = await client.createRelation(
    String(source.project),
    String(source.id),
    args.relation_type,
    [String(target.id)],
  );

  // The API filters the requested ids by workspace and bulk-creates whatever
  // survives, returning 201 with an empty list when nothing did. Reporting
  // "linked" on that would claim a link that does not exist.
  const linked = Array.isArray(created) ? created : created?.results;
  if (Array.isArray(linked) && linked.length === 0) {
    return { error: `No relation was created — ${args.target_identifier} did not resolve in this workspace.` };
  }

  return {
    identifier: args.identifier,
    target: args.target_identifier,
    relation_type: args.relation_type,
    status: "linked",
  };
}

async function handleUpsertCallNote(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.phone || !args.category || !args.details_html) {
    return { error: "phone, category and details_html are required" };
  }
  if (!isValidCallNoteCategory(args.category)) {
    return { error: `category must be one of ${CALL_NOTE_CATEGORIES.join(", ")}` };
  }
  return client.upsertCallNote({
    phone: args.phone,
    category: args.category,
    details_html: args.details_html,
    ...(args.caller_name ? { caller_name: args.caller_name } : {}),
  });
}

async function handleLookupCallNote(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.phone) return { error: "phone is required" };
  return client.lookupCallNote({
    phone: args.phone,
    ...(args.direction === "outbound" ? { direction: "outbound" as const } : {}),
    ...(args.caller_name ? { caller_name: args.caller_name } : {}),
  });
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
  bulk_cancel_tasks: handleBulkCancelTasks,
  page_list: handleListPages,
  page_search: handleSearchPages,
  page_get: handleGetPage,
  page_create: handleCreatePage,
  page_update: handleUpdatePage,
  page_archive: handleArchivePage,
  intake_list: handleListIntake,
  intake_triage: handleTriageIntake,
  relation_list: handleListRelations,
  relation_add: handleAddRelation,
  callnote_upsert: handleUpsertCallNote,
  callnote_lookup: handleLookupCallNote,
};
