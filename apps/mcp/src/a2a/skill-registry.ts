export interface SkillDefinition {
  name: string;
  mcpTool: string;
  scope: "taskpilot:read" | "taskpilot:write";
  approval: boolean | "conditional";
  description: string;
}

const SKILL_REGISTRY: Record<string, SkillDefinition> = {
  "task.create":          { name: "task.create",          mcpTool: "create_task",      scope: "taskpilot:write", approval: false, description: "Create a new task with smart project routing" },
  "task.update":          { name: "task.update",          mcpTool: "update_task",      scope: "taskpilot:write", approval: false, description: "Update task fields" },
  "task.find":            { name: "task.find",            mcpTool: "find_tasks",       scope: "taskpilot:read",  approval: false, description: "Search tasks by query" },
  "task.get":             { name: "task.get",             mcpTool: "get_task",         scope: "taskpilot:read",  approval: false, description: "Get task details by identifier" },
  "task.move":            { name: "task.move",            mcpTool: "move_task",        scope: "taskpilot:write", approval: "conditional", description: "Change task state" },
  "task.summarize":       { name: "task.summarize",       mcpTool: "get_task_summary", scope: "taskpilot:read",  approval: false, description: "Get project summary with 3-state status" },
  "task.assign":          { name: "task.assign",          mcpTool: "assign_task",      scope: "taskpilot:write", approval: false, description: "Assign a user to a task" },
  "task.unassign":        { name: "task.unassign",        mcpTool: "unassign_task",    scope: "taskpilot:write", approval: false, description: "Remove user assignment" },
  "label.add":            { name: "label.add",            mcpTool: "add_label",        scope: "taskpilot:write", approval: false, description: "Add a label to a task" },
  "label.remove":         { name: "label.remove",         mcpTool: "remove_label",     scope: "taskpilot:write", approval: false, description: "Remove a label from a task" },
  "comment.add":          { name: "comment.add",          mcpTool: "add_comment",      scope: "taskpilot:write", approval: false, description: "Add a comment to a task" },
  "cycle.assign":         { name: "cycle.assign",         mcpTool: "assign_to_cycle",  scope: "taskpilot:write", approval: false, description: "Add task to a sprint/cycle" },
  "project.list":         { name: "project.list",         mcpTool: "list_projects",    scope: "taskpilot:read",  approval: false, description: "List all projects" },
  "project.list_states":  { name: "project.list_states",  mcpTool: "list_states",      scope: "taskpilot:read",  approval: false, description: "List workflow states" },
  "project.list_members": { name: "project.list_members", mcpTool: "list_members",     scope: "taskpilot:read",  approval: false, description: "List project members" },
  "project.list_labels":  { name: "project.list_labels",  mcpTool: "list_labels",      scope: "taskpilot:read",  approval: false, description: "List available labels" },
  "project.list_cycles":  { name: "project.list_cycles",  mcpTool: "list_cycles",      scope: "taskpilot:read",  approval: false, description: "List sprints/cycles" },
  "project.list_tasks":   { name: "project.list_tasks",   mcpTool: "list_tasks",       scope: "taskpilot:read",  approval: false, description: "List tasks with filters" },
  "task.bulk_cancel":     { name: "task.bulk_cancel",     mcpTool: "bulk_cancel_tasks", scope: "taskpilot:write", approval: true,  description: "Cancel multiple tasks at once (requires human approval). No delete exists — use this instead." },
  "page.list":            { name: "page.list",            mcpTool: "page_list",        scope: "taskpilot:read",  approval: false, description: "List pages (documents) in a project or across projects" },
  "page.get":             { name: "page.get",             mcpTool: "page_get",         scope: "taskpilot:read",  approval: false, description: "Get one page including its content" },
  "page.create":          { name: "page.create",          mcpTool: "page_create",      scope: "taskpilot:write", approval: false, description: "Create a page, routed to the right project" },
  "page.update":          { name: "page.update",          mcpTool: "page_update",      scope: "taskpilot:write", approval: false, description: "Replace a page's content. Refuses externally-synced pages unless forced" },
  "page.archive":         { name: "page.archive",         mcpTool: "page_archive",     scope: "taskpilot:write", approval: true,  description: "Archive a page (requires human approval)" },
  "intake.list":          { name: "intake.list",          mcpTool: "intake_list",      scope: "taskpilot:read",  approval: false, description: "List work items in a project's intake (triage) queue" },
  "intake.triage":        { name: "intake.triage",        mcpTool: "intake_triage",    scope: "taskpilot:write", approval: "conditional", description: "Accept or reject a queued intake item" },
  "relation.list":        { name: "relation.list",        mcpTool: "relation_list",    scope: "taskpilot:read",  approval: false, description: "List a task's relations (blocking, duplicate, relates_to, etc.)" },
  "relation.add":         { name: "relation.add",         mcpTool: "relation_add",     scope: "taskpilot:write", approval: false, description: "Link two tasks with a relation, e.g. mark one a duplicate of another" },
  "callnote.upsert":      { name: "callnote.upsert",      mcpTool: "callnote_upsert",  scope: "taskpilot:write", approval: false, description: "Create or append a call note for a phone number under a business category" },
  "callnote.lookup":      { name: "callnote.lookup",      mcpTool: "callnote_lookup",  scope: "taskpilot:read",  approval: false, description: "Look up open call-note matters for a phone number" },
};

export function getSkillDefinition(skillName: string): SkillDefinition | undefined {
  return SKILL_REGISTRY[skillName];
}

export function getAllSkills(): SkillDefinition[] {
  return Object.values(SKILL_REGISTRY);
}

export function isCriticalAction(mcpTool: string, args: Record<string, any>): boolean {
  if (mcpTool === "move_task" && typeof args.state === "string") {
    return args.state.toLowerCase() === "cancelled";
  }
  if (mcpTool === "bulk_cancel_tasks") {
    return true;
  }
  // Archiving removes a page from view — the page equivalent of cancelling a
  // work item. The A2A registry already marks page.archive approval:true, but
  // that only gates the A2A path; without this an MCP client calling
  // page_archive directly would skip the human approval entirely.
  if (mcpTool === "page_archive") {
    return true;
  }
  // Accepting an intake item just files it; rejecting discards work someone or
  // something asked for. Same shape as move_task -> Cancelled.
  if (mcpTool === "intake_triage" && typeof args.decision === "string") {
    return args.decision.toLowerCase() === "reject";
  }
  return false;
}

/**
 * Whether an A2A skill call needs a human.
 *
 * `clientId` is optional only so existing callers and tests keep compiling;
 * pass it. Without it a peer's ordinary write looks like the owner's and
 * skips the gate, which is the asymmetry this policy exists to remove.
 */
export function requiresApproval(
  skillName: string,
  input: Record<string, any>,
  clientId = "",
): boolean {
  const skill = SKILL_REGISTRY[skillName];
  if (!skill) return false;
  if (skill.approval === true) return true;
  if (skill.approval === "conditional" && isCriticalAction(skill.mcpTool, input)) return true;

  // Same rule the MCP path applies: any write by an external peer.
  return requiresHumanApproval(skill.mcpTool, input, clientId);
}

// --- Write-safety policy: one place, used by BOTH the MCP and A2A paths ---

/**
 * The write tools, DERIVED from the registry rather than hand-listed.
 *
 * A hand-maintained set is how a new tool ships ungated: whoever adds the skill
 * has to remember a second place. Deriving it means a skill declared
 * `taskpilot:write` is gated by construction.
 */
export function getWriteTools(): Set<string> {
  return new Set(
    getAllSkills()
      .filter((skill) => skill.scope === "taskpilot:write")
      .map((skill) => skill.mcpTool),
  );
}

/**
 * Whether a caller is an external peer rather than the account owner.
 *
 * Peer credentials are minted by scripts/mint-peer-token.ts, which is the only
 * thing that creates a `peer_` client id; OAuth dynamic registration produces
 * `mcp_` ids. A peer holding a token is not the owner — one bad write's blast
 * radius is the datastore, not the request — so peers are held to a stricter
 * bar than the owner's own session.
 */
export function isExternalPeer(clientId: string): boolean {
  return typeof clientId === "string" && clientId.startsWith("peer_");
}

/**
 * The single approval decision. Destructive actions always need a human. An
 * external peer needs one for ANY write, because a peer's judgement is not the
 * owner's.
 */
export function requiresHumanApproval(
  mcpTool: string,
  args: Record<string, any>,
  clientId: string,
): boolean {
  if (isCriticalAction(mcpTool, args)) return true;
  return isExternalPeer(clientId) && getWriteTools().has(mcpTool);
}
