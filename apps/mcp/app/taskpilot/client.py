"""HTTP client for TaskPilot REST API."""

import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class TaskPilotClient:
    def __init__(self, workspace_slug: str | None = None):
        self.base_url = settings.taskpilot_api_url.rstrip("/")
        self.api_key = settings.taskpilot_api_key
        self.workspace = workspace_slug or settings.taskpilot_workspace_slug
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={
                    "X-Api-Key": self.api_key,
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
        return self._client

    async def _request(self, method: str, path: str, **kwargs) -> Any:
        client = await self._get_client()
        resp = await client.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp.json()

    # --- Projects ---
    async def list_projects(self) -> list[dict]:
        data = await self._request(
            "GET", f"/api/workspaces/{self.workspace}/projects/"
        )
        return data if isinstance(data, list) else data.get("results", data)

    async def get_project(self, project_id: str) -> dict:
        return await self._request(
            "GET", f"/api/workspaces/{self.workspace}/projects/{project_id}/"
        )

    # --- Issues ---
    async def list_issues(
        self, project_id: str, params: dict | None = None
    ) -> Any:
        return await self._request(
            "GET",
            f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/",
            params=params,
        )

    async def create_issue(self, project_id: str, data: dict) -> dict:
        return await self._request(
            "POST",
            f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/",
            json=data,
        )

    async def get_issue(self, project_id: str, issue_id: str) -> dict:
        return await self._request(
            "GET",
            f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/{issue_id}/",
        )

    async def update_issue(
        self, project_id: str, issue_id: str, data: dict
    ) -> dict:
        return await self._request(
            "PATCH",
            f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/{issue_id}/",
            json=data,
        )

    async def get_issue_by_identifier(self, identifier: str) -> dict:
        """Get issue by human-readable identifier like FOR-AI-42."""
        return await self._request(
            "GET",
            f"/api/workspaces/{self.workspace}/work-items/{identifier}/",
        )

    # --- States ---
    async def list_states(self, project_id: str | None = None) -> list[dict]:
        if project_id:
            return await self._request(
                "GET",
                f"/api/workspaces/{self.workspace}/projects/{project_id}/states/",
            )
        return await self._request(
            "GET", f"/api/workspaces/{self.workspace}/states/"
        )

    # --- Cycles ---
    async def list_cycles(self, project_id: str) -> list[dict]:
        return await self._request(
            "GET",
            f"/api/workspaces/{self.workspace}/projects/{project_id}/cycles/",
        )

    async def add_issue_to_cycle(
        self, project_id: str, cycle_id: str, issue_ids: list[str]
    ) -> Any:
        return await self._request(
            "POST",
            f"/api/workspaces/{self.workspace}/projects/{project_id}/cycles/{cycle_id}/cycle-issues/",
            json={"issues": issue_ids},
        )

    # --- Comments ---
    async def add_comment(
        self, project_id: str, issue_id: str, comment: str
    ) -> dict:
        return await self._request(
            "POST",
            f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/{issue_id}/comments/",
            json={"comment_html": f"<p>{comment}</p>"},
        )

    async def close(self):
        if self._client:
            await self._client.aclose()
