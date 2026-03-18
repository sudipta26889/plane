"""MCP request authentication — extracts and validates Bearer tokens."""

from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database.connection import get_db
from app.database.models import MCPStaticToken, OAuthAccessToken
from app.oauth.security import hash_token

security = HTTPBearer(auto_error=False)


@dataclass
class MCPAuthContext:
    user_id: str
    scopes: list[str]
    workspace_slug: str | None = None

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> MCPAuthContext:
    """Authenticate MCP requests using OAuth 2.1 access tokens or static tokens."""
    if not credentials:
        raise HTTPException(
            status_code=401,
            detail="Authorization required",
            headers={
                "WWW-Authenticate": (
                    f'Bearer resource_metadata="{settings.mcp_issuer_url}'
                    '/.well-known/oauth-protected-resource"'
                )
            },
        )

    raw_token = credentials.credentials
    token_hash = hash_token(raw_token)

    # Try static token first (mcp_st_ prefix)
    if raw_token.startswith("mcp_st_"):
        result = await db.execute(
            select(MCPStaticToken).where(MCPStaticToken.token_hash == token_hash)
        )
        st = result.scalar_one_or_none()
        if not st or not st.is_valid:
            raise HTTPException(401, "Invalid or expired static token")
        st.last_used_at = datetime.now(timezone.utc)
        await db.commit()
        return MCPAuthContext(
            user_id=str(st.user_id),
            scopes=["taskpilot:read", "taskpilot:write"],
            workspace_slug=st.workspace_slug,
        )

    # Try OAuth access token (mcp_at_ prefix)
    result = await db.execute(
        select(OAuthAccessToken).where(OAuthAccessToken.token_hash == token_hash)
    )
    at = result.scalar_one_or_none()
    if not at or not at.is_valid:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired access token",
            headers={
                "WWW-Authenticate": (
                    f'Bearer error="invalid_token", resource_metadata="{settings.mcp_issuer_url}'
                    '/.well-known/oauth-protected-resource"'
                )
            },
        )

    return MCPAuthContext(
        user_id=str(at.user_id),
        scopes=at.scope.split() if at.scope else [],
    )
