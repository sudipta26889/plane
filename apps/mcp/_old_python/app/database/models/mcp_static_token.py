"""MCP static token for direct MCP client auth (no OAuth flow)."""

from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, String
from sqlalchemy.dialects.postgresql import UUID

from app.database.models.base import BaseModel


class MCPStaticToken(BaseModel):
    __tablename__ = "mcp_static_token"

    token_hash = Column(String(255), unique=True, index=True, nullable=False)
    name = Column(String(255), nullable=False)
    user_id = Column(UUID(as_uuid=True), nullable=False)
    workspace_slug = Column(String(255), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=True)  # None = permanent
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    @property
    def is_expired(self) -> bool:
        if self.expires_at is None:
            return False
        return datetime.now(timezone.utc) > self.expires_at

    @property
    def is_valid(self) -> bool:
        return not self.is_expired and self.revoked_at is None
