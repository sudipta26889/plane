"""MCP tool execution handlers."""

import json
import logging
from typing import Any

from app.mcp.tools import get_tool_by_name
from app.oauth.auth import MCPAuthContext
from app.router.smart_router import route_task
from app.taskpilot.client import TaskPilotClient

logger = logging.getLogger(__name__)

WRITE_TOOLS = {"create_task", "move_task", "update_task", "add_comment", "assign_to_cycle"}


async def execute_tool(name: str, arguments: dict[str, Any], auth: MCPAuthContext) -> str:
    """Execute an MCP tool and return JSON result string."""
    tool = get_tool_by_name(name)
    if not tool:
        raise ValueError(f"Unknown tool: {name}")

    if name in WRITE_TOOLS and not auth.has_scope("taskpilot:write"):
        raise PermissionError(f"Tool '{name}' requires 'taskpilot:write' scope")
    if not auth.has_scope("taskpilot:read"):
        raise PermissionError("Requires 'taskpilot:read' scope")

    workspace = auth.workspace_slug
    client = TaskPilotClient(workspace)

    try:
        handler = HANDLERS.get(name)
        if not handler:
            raise ValueError(f"No handler for tool: {name}")
        result = await handler(arguments, client, workspace)
        return json.dumps(result, default=str)
    finally:
        await client.close()


async def handle_create_task(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    project_id = await route_task(workspace, args["title"], args.get("project_hint"), client)
    data = {"name": args["title"]}
    if args.get("description"):
        data["description_html"] = f"<p>{args['description']}</p>"
    if args.get("priority"):
        data["priority"] = args["priority"]
    issue = await client.create_issue(project_id, data)
    proj_detail = issue.get("project_detail", {})
    return {
        "identifier": f"{proj_detail.get('identifier', '?')}-{issue.get('sequence_id', '?')}",
        "id": issue["id"],
        "project": proj_detail.get("name", ""),
        "title": issue["name"],
    }


async def handle_move_task(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    project_id = str(issue["project"])
    states = await client.list_states(project_id)
    target_state = next(
        (s for s in states if args["state"].lower() in s["name"].lower()), None
    )
    if not target_state:
        available = [s["name"] for s in states]
        return {"error": f"State '{args['state']}' not found. Available: {available}"}
    await client.update_issue(project_id, str(issue["id"]), {"state": target_state["id"]})
    return {"identifier": args["identifier"], "state": target_state["name"], "status": "moved"}


async def handle_find_tasks(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    projects = await client.list_projects()
    results = []
    for project in projects:
        if args.get("project_hint") and args["project_hint"].lower() not in project.get("name", "").lower():
            continue
        issues = await client.list_issues(str(project["id"]), params={"search": args["query"]})
        if isinstance(issues, dict) and "results" in issues:
            issues = issues["results"]
        for issue in (issues or [])[:10]:
            results.append({
                "identifier": f"{project.get('identifier', '?')}-{issue.get('sequence_id', '?')}",
                "title": issue.get("name", ""),
                "state": issue.get("state_detail", {}).get("name", ""),
                "priority": issue.get("priority", ""),
            })
    return {"tasks": results[:20], "count": len(results)}


async def handle_list_projects(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    projects = await client.list_projects()
    return {
        "projects": [
            {
                "id": p["id"],
                "name": p["name"],
                "identifier": p.get("identifier", ""),
                "description": p.get("description", ""),
            }
            for p in projects
        ]
    }


async def handle_list_tasks(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    projects = await client.list_projects()
    target_project = None
    if args.get("project"):
        target_project = next(
            (p for p in projects if args["project"].lower() in p.get("name", "").lower() or args["project"] == str(p["id"])),
            None,
        )
    if target_project:
        projects = [target_project]
    results = []
    limit = args.get("limit", 20)
    for project in projects:
        issues = await client.list_issues(str(project["id"]))
        if isinstance(issues, dict) and "results" in issues:
            issues = issues["results"]
        for issue in issues or []:
            results.append({
                "identifier": f"{project.get('identifier', '?')}-{issue.get('sequence_id', '?')}",
                "title": issue.get("name", ""),
                "state": issue.get("state_detail", {}).get("name", ""),
                "priority": issue.get("priority", ""),
            })
            if len(results) >= limit:
                break
        if len(results) >= limit:
            break
    return {"tasks": results, "count": len(results)}


async def handle_get_task(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    return {
        "id": issue["id"],
        "identifier": args["identifier"],
        "title": issue.get("name", ""),
        "description": issue.get("description_stripped", ""),
        "state": issue.get("state_detail", {}).get("name", ""),
        "priority": issue.get("priority", ""),
        "assignees": [a.get("display_name", "") for a in issue.get("assignee_detail", [])],
        "start_date": issue.get("start_date"),
        "target_date": issue.get("target_date"),
        "created_at": issue.get("created_at"),
    }


async def handle_update_task(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    data = {}
    if "title" in args:
        data["name"] = args["title"]
    if "description" in args:
        data["description_html"] = f"<p>{args['description']}</p>"
    if "priority" in args:
        data["priority"] = args["priority"]
    if "start_date" in args:
        data["start_date"] = args["start_date"]
    if "target_date" in args:
        data["target_date"] = args["target_date"]
    if not data:
        return {"error": "No fields to update"}
    await client.update_issue(str(issue["project"]), str(issue["id"]), data)
    return {"identifier": args["identifier"], "status": "updated", "fields": list(data.keys())}


async def handle_add_comment(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    comment = await client.add_comment(str(issue["project"]), str(issue["id"]), args["comment"])
    return {"identifier": args["identifier"], "comment_id": comment.get("id", ""), "status": "added"}


async def handle_list_states(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    project_id = None
    if args.get("project"):
        projects = await client.list_projects()
        p = next((p for p in projects if args["project"].lower() in p.get("name", "").lower()), None)
        if p:
            project_id = str(p["id"])
    states = await client.list_states(project_id)
    return {"states": [{"id": s["id"], "name": s["name"], "group": s.get("group", "")} for s in states]}


async def handle_list_cycles(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    projects = await client.list_projects()
    p = next((p for p in projects if args["project"].lower() in p.get("name", "").lower()), None)
    if not p:
        return {"error": f"Project '{args['project']}' not found"}
    cycles = await client.list_cycles(str(p["id"]))
    return {
        "cycles": [
            {"id": c["id"], "name": c["name"], "start_date": c.get("start_date"), "end_date": c.get("end_date")}
            for c in cycles
        ]
    }


async def handle_assign_to_cycle(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    await client.add_issue_to_cycle(str(issue["project"]), args["cycle_id"], [str(issue["id"])])
    return {"identifier": args["identifier"], "cycle_id": args["cycle_id"], "status": "assigned"}


HANDLERS = {
    "create_task": handle_create_task,
    "move_task": handle_move_task,
    "find_tasks": handle_find_tasks,
    "list_projects": handle_list_projects,
    "list_tasks": handle_list_tasks,
    "get_task": handle_get_task,
    "update_task": handle_update_task,
    "add_comment": handle_add_comment,
    "list_states": handle_list_states,
    "list_cycles": handle_list_cycles,
    "assign_to_cycle": handle_assign_to_cycle,
}
