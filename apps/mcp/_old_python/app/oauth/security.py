"""OAuth 2.1 security: PKCE, token generation, hashing."""

import base64
import hashlib
import re
import secrets
from typing import Optional

# Token prefixes
ACCESS_TOKEN_PREFIX = "mcp_at_"
REFRESH_TOKEN_PREFIX = "mcp_rt_"
STATIC_TOKEN_PREFIX = "mcp_st_"
CLIENT_ID_PREFIX = "mcp_"

# Scopes
MCP_SCOPES = {
    "taskpilot:read": "Read projects, tasks, cycles, modules, states",
    "taskpilot:write": "Create, update, delete tasks, comments, assignments",
}
DEFAULT_SCOPE = "taskpilot:read taskpilot:write"

# PKCE verifier pattern (RFC 7636)
CODE_VERIFIER_PATTERN = re.compile(r"^[A-Za-z0-9\-._~]{43,128}$")


def _generate_token(prefix: str, nbytes: int = 48) -> tuple[str, str]:
    """Generate a prefixed token and its SHA256 hash."""
    raw = prefix + secrets.token_urlsafe(nbytes)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    return raw, token_hash


def generate_client_id() -> str:
    return CLIENT_ID_PREFIX + secrets.token_urlsafe(24)


def generate_client_secret() -> tuple[str, str]:
    raw = secrets.token_urlsafe(48)
    secret_hash = hashlib.sha256(raw.encode()).hexdigest()
    return raw, secret_hash


def generate_access_token() -> tuple[str, str]:
    return _generate_token(ACCESS_TOKEN_PREFIX)


def generate_refresh_token() -> tuple[str, str]:
    return _generate_token(REFRESH_TOKEN_PREFIX)


def generate_static_token() -> tuple[str, str]:
    return _generate_token(STATIC_TOKEN_PREFIX)


def generate_auth_code() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def verify_secret(raw_secret: str, secret_hash: str) -> bool:
    computed = hashlib.sha256(raw_secret.encode()).hexdigest()
    return secrets.compare_digest(computed, secret_hash)


# PKCE (RFC 7636)
def compute_pkce_challenge(code_verifier: str, method: str = "S256") -> str:
    if method != "S256":
        raise ValueError("Only S256 is supported")
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def verify_pkce_challenge(verifier: str, challenge: str, method: str = "S256") -> bool:
    computed = compute_pkce_challenge(verifier, method)
    return secrets.compare_digest(computed, challenge)


def validate_code_verifier(verifier: str) -> bool:
    return bool(CODE_VERIFIER_PATTERN.match(verifier))


def validate_redirect_uri(uri: str) -> bool:
    if uri.startswith("http://localhost") or uri.startswith("http://127.0.0.1"):
        return True
    return uri.startswith("https://")


def validate_scope(scope: str, allowed: Optional[set[str]] = None) -> list[str]:
    scopes = scope.strip().split()
    if allowed:
        invalid = set(scopes) - allowed
        if invalid:
            raise ValueError(f"Invalid scopes: {invalid}")
    return scopes
