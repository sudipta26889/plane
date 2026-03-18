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
        "revocation_endpoint": f"{base}/oauth/revoke",
        "response_types_supported": ["code"],
        "grant_types_supported": [
            "authorization_code",
            "refresh_token",
            "client_credentials",
        ],
        "token_endpoint_auth_methods_supported": [
            "none",
            "client_secret_post",
            "client_secret_basic",
        ],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": ["taskpilot:read", "taskpilot:write"],
    }
