"""OAuth consent tracking — remembers user approvals."""

from sqlalchemy import Column, DateTime, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.database.models.base import BaseModel


class OAuthConsent(BaseModel):
    __tablename__ = "mcp_oauth_consent"

    user_id = Column(UUID(as_uuid=True), nullable=False)
    client_id = Column(String(255), nullable=False)
    scope = Column(String(512), nullable=False)
    granted_at = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "client_id", name="uq_mcp_consent_user_client"),
    )
