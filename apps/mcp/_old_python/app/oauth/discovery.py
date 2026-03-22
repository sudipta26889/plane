"""OAuth 2.0 metadata discovery endpoints (RFC 9728, RFC 8414)."""

from fastapi import APIRouter

from app.config import settings

router = APIRouter()


@router.get("/.well-known/oauth-protected-resource")
async def protected_resource_metadata():
    """RFC 9728 — tells MCP clients where the authorization server is."""
    return {
        "resource": settings.mcp_resource_url,
        "authorization_servers": [settings.mcp_issuer_url],
        "bearer_methods_supported": ["header"],
        "resource_type": "mcp-server",
        "mcp_protocol_version": "2024-11-05",
        "scopes_supported": ["taskpilot:read", "taskpilot:write"],
        "token_types_supported": ["Bearer"],
    }


@router.get("/.well-known/oauth-protected-resource/{path:path}")
async def protected_resource_metadata_with_path(path: str):
    """RFC 9728 with path — handles /.well-known/oauth-protected-resource/mcp."""
    return {
        "resource": settings.mcp_resource_url,
        "authorization_servers": [settings.mcp_issuer_url],
        "scopes_supported": ["taskpilot:read", "taskpilot:write"],
        "bearer_methods_supported": ["header"],
    }


@router.get("/.well-known/oauth-authorization-server")
async def authorization_server_metadata():
    """RFC 8414 — full authorization server metadata."""
    base = settings.mcp_issuer_url
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/oauth/register",
        "revocation_endpoint": f"{base}/oauth/revoke",
        "scopes_supported": ["taskpilot:read", "taskpilot:write"],
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
        "code_challenge_methods_supported": ["S256"],
        "token_types_supported": ["Bearer"],
        "resource_indicators_supported": True,
        "require_pkce": True,
        "require_pushed_authorization_requests": False,
        "require_request_uri_registration": False,
        "ui_locales_supported": ["en"],
    }
