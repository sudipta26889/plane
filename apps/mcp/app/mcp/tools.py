"""MCP tool definitions — what AI agents can call."""

TOOLS = [
    {
        "name": "create_task",
        "description": "Create a task. Automatically routes to the right project, or specify project_hint.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Task title"},
                "description": {"type": "string", "description": "Detailed description (optional)"},
                "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"], "description": "Priority level"},
                "project_hint": {"type": "string", "description": "Project name or identifier to route to (optional)"},
            },
            "required": ["title"],
        },
    },
    {
        "name": "move_task",
        "description": "Move a task to a different state (e.g., In Progress, Done).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
                "state": {"type": "string", "description": "Target state name (e.g., 'In Progress', 'Done')"},
            },
            "required": ["identifier", "state"],
        },
    },
    {
        "name": "find_tasks",
        "description": "Search for tasks across the workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search text"},
                "state": {"type": "string", "description": "Filter by state name"},
                "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"]},
                "project_hint": {"type": "string", "description": "Filter by project name"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "list_projects",
        "description": "List all projects in the workspace.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_tasks",
        "description": "List tasks with optional filters.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or ID"},
                "state": {"type": "string", "description": "State name filter"},
                "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"]},
                "limit": {"type": "integer", "description": "Max results (default 20)", "default": 20},
            },
        },
    },
    {
        "name": "get_task",
        "description": "Get full details of a task by identifier.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
            },
            "required": ["identifier"],
        },
    },
    {
        "name": "update_task",
        "description": "Update task fields (title, description, priority, dates).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"]},
                "start_date": {"type": "string", "description": "YYYY-MM-DD"},
                "target_date": {"type": "string", "description": "YYYY-MM-DD"},
            },
            "required": ["identifier"],
        },
    },
    {
        "name": "add_comment",
        "description": "Add a comment to a task.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
                "comment": {"type": "string", "description": "Comment text"},
            },
            "required": ["identifier", "comment"],
        },
    },
    {
        "name": "list_states",
        "description": "List workflow states for a project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or ID (optional)"},
            },
        },
    },
    {
        "name": "list_cycles",
        "description": "List sprints/cycles for a project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or ID"},
            },
            "required": ["project"],
        },
    },
    {
        "name": "assign_to_cycle",
        "description": "Add a task to a sprint/cycle.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
                "cycle_id": {"type": "string", "description": "Cycle UUID"},
            },
            "required": ["identifier", "cycle_id"],
        },
    },
]


def get_tool_definitions() -> list[dict]:
    return TOOLS


def get_tool_by_name(name: str) -> dict | None:
    return next((t for t in TOOLS if t["name"] == name), None)
