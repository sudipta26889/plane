"""OAuth 2.1 client registration model."""

from sqlalchemy import Boolean, Column, JSON, String
from sqlalchemy.dialects.postgresql import UUID

from app.database.models.base import BaseModel


class OAuthClient(BaseModel):
    __tablename__ = "mcp_oauth_client"

    client_id = Column(String(255), unique=True, index=True, nullable=False)
    client_secret_hash = Column(String(255), nullable=True)
    client_name = Column(String(255), nullable=True, default="unknown")
    redirect_uris = Column(JSON, default=list)
    grant_types = Column(JSON, default=lambda: ["authorization_code"])
    response_types = Column(JSON, default=lambda: ["code"])
    token_endpoint_auth_method = Column(String(50), default="none")
    scope = Column(String(512), default="taskpilot:read taskpilot:write")
    owner_id = Column(UUID(as_uuid=True), nullable=True)
    is_active = Column(Boolean, default=True)
