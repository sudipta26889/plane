"""LLM-powered project routing — determines which project a task belongs to."""

import json
import logging
from typing import Optional

from openai import AsyncOpenAI

from app.config import settings
from app.router.cache import get_cached_project, set_cached_project
from app.taskpilot.client import TaskPilotClient

logger = logging.getLogger(__name__)

ROUTING_SYSTEM_PROMPT = """You are a task router for a project management system. Given a list of projects and a task title, determine which project the task belongs to.

Rules:
- Return ONLY the project ID (UUID), nothing else.
- If no project clearly matches, return the one that is the best fit.
- Consider project names and descriptions for context.
"""


async def route_task(
    workspace: str,
    title: str,
    project_hint: Optional[str] = None,
    client: Optional[TaskPilotClient] = None,
) -> str:
    """Determine the best project for a task. Returns project_id."""
    if client is None:
        client = TaskPilotClient(workspace)

    projects = await client.list_projects()
    if not projects:
        raise ValueError("No projects found in workspace")

    # If hint provided, try exact/fuzzy match first
    if project_hint:
        for p in projects:
            if project_hint.lower() in p.get("name", "").lower() or project_hint.lower() in p.get("identifier", "").lower():
                return str(p["id"])

    # Single project — no routing needed
    if len(projects) == 1:
        return str(projects[0]["id"])

    # Check cache
    cached = await get_cached_project(workspace, title)
    if cached:
        logger.info(f"Cache hit for '{title}' -> {cached}")
        return cached

    # Call LLM
    project_list = [
        {
            "id": str(p["id"]),
            "name": p.get("name", ""),
            "description": p.get("description", ""),
        }
        for p in projects
    ]

    llm_client = AsyncOpenAI(
        base_url=settings.llm_api_base_url, api_key=settings.llm_api_key
    )
    response = await llm_client.chat.completions.create(
        model=settings.llm_model,
        messages=[
            {"role": "system", "content": ROUTING_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"Projects:\n{json.dumps(project_list, indent=2)}\n\nTask: {title}",
            },
        ],
        temperature=0,
        max_tokens=100,
    )

    project_id = response.choices[0].message.content.strip().strip('"')

    # Validate the returned ID exists
    valid_ids = {str(p["id"]) for p in projects}
    if project_id not in valid_ids:
        logger.warning(
            f"LLM returned invalid project_id '{project_id}', falling back to first project"
        )
        project_id = str(projects[0]["id"])

    # Cache the result
    await set_cached_project(workspace, title, project_id)
    logger.info(f"Routed '{title}' -> {project_id} (LLM)")

    return project_id
