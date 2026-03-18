"""OAuth 2.1 access and refresh token models."""

from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID

from app.database.models.base import BaseModel


class OAuthAccessToken(BaseModel):
    __tablename__ = "mcp_oauth_access_token"

    token_hash = Column(String(255), unique=True, index=True, nullable=False)
    user_id = Column(UUID(as_uuid=True), nullable=False)
    client_id = Column(String(255), nullable=False)
    scope = Column(String(512), default="taskpilot:read taskpilot:write")
    expires_at = Column(DateTime(timezone=True), nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    @property
    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.expires_at

    @property
    def is_revoked(self) -> bool:
        return self.revoked_at is not None

    @property
    def is_valid(self) -> bool:
        return not self.is_expired and not self.is_revoked


class OAuthRefreshToken(BaseModel):
    __tablename__ = "mcp_oauth_refresh_token"

    token_hash = Column(String(255), unique=True, index=True, nullable=False)
    access_token_id = Column(
        UUID(as_uuid=True), ForeignKey("mcp_oauth_access_token.id"), nullable=False
    )
    user_id = Column(UUID(as_uuid=True), nullable=False)
    client_id = Column(String(255), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    @property
    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.expires_at

    @property
    def is_revoked(self) -> bool:
        return self.revoked_at is not None

    @property
    def is_valid(self) -> bool:
        return not self.is_expired and not self.is_revoked
