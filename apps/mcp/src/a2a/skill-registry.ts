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
  "intake.triage":        { name: "intake.triage",        mcpTool: "intake_triage",    scope: "taskpilot:write", approval: false, description: "Accept or reject a queued intake item" },
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
  return false;
}

export function requiresApproval(skillName: string, input: Record<string, any>): boolean {
  const skill = SKILL_REGISTRY[skillName];
  if (!skill) return false;
  if (skill.approval === true) return true;
  if (skill.approval === "conditional") {
    return isCriticalAction(skill.mcpTool, input);
  }
  return false;
}
