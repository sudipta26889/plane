# TaskPilot MCP Server Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone FastAPI MCP server that exposes TaskPilot workspace operations as MCP tools with OAuth 2.1 authentication and LLM-powered smart task routing.

**Architecture:** Separate FastAPI service (`apps/mcp/`) communicating with TaskPilot's existing REST API via `X-Api-Key` auth. OAuth 2.1 with PKCE for MCP client auth. Redis for routing cache and auth codes. LiteLLM for intelligent project routing.

**Tech Stack:** Python 3.12, FastAPI, uvicorn, SQLAlchemy (async), Redis (aioredis), OpenAI SDK (for LiteLLM), httpx (TaskPilot API client)

**Spec:** `docs/superpowers/specs/2026-03-18-taskpilot-mcp-server-design.md`

**Reference implementations:**
- MeetEcho: `/Users/sudipta/Workspace/personal/MeetEcho/app/mcp/`
- MegaSearch: `/Users/sudipta/Workspace/personal/MegaSearch/backend/app/core/oauth_security.py`

---

## File Structure

```
apps/mcp/
├── Dockerfile
├── Dockerfile.dev
├── requirements.txt
├── alembic.ini
├── alembic/
│   └── versions/          # DB migrations
├── tests/
│   ├── conftest.py
│   ├── test_oauth.py
│   ├── test_tools.py
│   ├── test_smart_router.py
│   └── test_jsonrpc.py
└── app/
    ├── __init__.py
    ├── main.py             # FastAPI app entry, /mcp endpoint, /mcp/sse, health
    ├── config.py            # Pydantic Settings from env
    ├── database/
    │   ├── __init__.py
    │   ├── connection.py    # SQLAlchemy async engine + session
    │   └── models/
    │       ├── __init__.py
    │       ├── base.py      # Base model with id, created_at, updated_at
    │       ├── oauth_client.py
    │       ├── oauth_token.py
    │       ├── oauth_consent.py
    │       └── mcp_static_token.py
    ├── oauth/
    │   ├── __init__.py
    │   ├── security.py      # PKCE, token generation, hashing (from MegaSearch pattern)
    │   ├── endpoints.py     # /oauth/authorize, /oauth/token, /oauth/revoke
    │   ├── discovery.py     # .well-known endpoints
    │   └── auth.py          # get_current_user dependency (from MeetEcho pattern)
    ├── mcp/
    │   ├── __init__.py
    │   ├── jsonrpc.py       # JSON-RPC 2.0 models (from MeetEcho)
    │   ├── server.py        # Request router: initialize, tools/list, tools/call
    │   ├── tools.py         # Tool definitions (JSON schema)
    │   └── handlers.py      # Tool execution logic
    ├── router/
    │   ├── __init__.py
    │   ├── smart_router.py  # LLM-based project routing
    │   └── cache.py         # Redis routing cache
    └── taskpilot/
        ├── __init__.py
        └── client.py        # httpx client for TaskPilot API
```

---

## Chunk 1: Project Scaffold + Config + Database

### Task 1: Project scaffold and dependencies

**Files:**
- Create: `apps/mcp/requirements.txt`
- Create: `apps/mcp/app/__init__.py`
- Create: `apps/mcp/app/config.py`

- [ ] **Step 1: Create requirements.txt**

```
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
sqlalchemy[asyncio]>=2.0.0
asyncpg>=0.29.0
alembic>=1.13.0
redis>=5.0.0
httpx>=0.27.0
openai>=1.30.0
pydantic-settings>=2.0.0
sse-starlette>=2.0.0
python-multipart>=0.0.9
```

- [ ] **Step 2: Create config.py**

```python
"""MCP server configuration from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Server
    mcp_port: int = 4650
    mcp_issuer_url: str = "http://localhost:4650"
    mcp_resource_url: str = "http://localhost:4650/mcp"

    # TaskPilot API
    taskpilot_api_url: str = "http://api:4647"
    taskpilot_api_key: str = ""
    taskpilot_workspace_slug: str = ""

    # Database
    database_url: str = ""

    # Redis
    redis_url: str = "redis://localhost:6379/7"

    # LLM (smart routing)
    llm_api_base_url: str = "http://192.168.11.118:4000"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"

    # OAuth TTLs
    mcp_access_token_ttl: int = 3600
    mcp_refresh_token_ttl: int = 2592000
    mcp_auth_code_ttl: int = 600

    # Frontend (for OAuth consent redirect)
    frontend_url: str = "https://taskpilot.sudiptadhara.in"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
```

- [ ] **Step 3: Create `__init__.py` files**

Create empty `__init__.py` in: `app/`, `app/database/`, `app/database/models/`, `app/oauth/`, `app/mcp/`, `app/router/`, `app/taskpilot/`

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/
git commit -m "feat(mcp): scaffold project with config and dependencies"
```

### Task 2: Database models

**Files:**
- Create: `apps/mcp/app/database/connection.py`
- Create: `apps/mcp/app/database/models/base.py`
- Create: `apps/mcp/app/database/models/oauth_client.py`
- Create: `apps/mcp/app/database/models/oauth_token.py`
- Create: `apps/mcp/app/database/models/oauth_consent.py`
- Create: `apps/mcp/app/database/models/mcp_static_token.py`

- [ ] **Step 1: Create connection.py**

```python
"""Async SQLAlchemy engine and session factory."""

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from app.config import settings

engine = create_async_engine(
    settings.database_url.replace("postgresql://", "postgresql+asyncpg://"),
    echo=False,
    pool_size=5,
    max_overflow=10,
)

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncSession:
    async with async_session() as session:
        yield session
```

- [ ] **Step 2: Create base.py**

```python
"""Base model with common fields."""

import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class BaseModel(Base):
    __abstract__ = True

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
```

- [ ] **Step 3: Create oauth_client.py** (follows MegaSearch pattern)

```python
"""OAuth 2.1 client registration model."""

from sqlalchemy import Column, String, Boolean, JSON
from sqlalchemy.dialects.postgresql import UUID
from app.database.models.base import BaseModel


class OAuthClient(BaseModel):
    __tablename__ = "mcp_oauth_client"

    client_id = Column(String(255), unique=True, index=True, nullable=False)
    client_secret_hash = Column(String(255), nullable=True)
    client_name = Column(String(255), nullable=False)
    redirect_uris = Column(JSON, default=list)
    grant_types = Column(JSON, default=lambda: ["authorization_code"])
    response_types = Column(JSON, default=lambda: ["code"])
    token_endpoint_auth_method = Column(String(50), default="none")
    scope = Column(String(512), default="taskpilot:read taskpilot:write")
    owner_id = Column(UUID(as_uuid=True), nullable=True)  # TaskPilot user UUID
    is_active = Column(Boolean, default=True)
```

- [ ] **Step 4: Create oauth_token.py** (follows MegaSearch hashed pattern)

```python
"""OAuth 2.1 access and refresh token models."""

from datetime import datetime, timezone
from sqlalchemy import Column, String, DateTime, ForeignKey, Boolean
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
    access_token_id = Column(UUID(as_uuid=True), ForeignKey("mcp_oauth_access_token.id"), nullable=False)
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
```

- [ ] **Step 5: Create mcp_static_token.py**

```python
"""MCP static token model for direct MCP client auth (no OAuth flow)."""

from datetime import datetime, timezone
from sqlalchemy import Column, String, DateTime
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
```

- [ ] **Step 6: Create oauth_consent.py**

```python
"""OAuth consent tracking — remembers user approvals."""

from sqlalchemy import Column, String, DateTime, UniqueConstraint
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
```

- [ ] **Step 7: Create models `__init__.py`**

```python
from app.database.models.base import Base, BaseModel
from app.database.models.oauth_client import OAuthClient
from app.database.models.oauth_token import OAuthAccessToken, OAuthRefreshToken
from app.database.models.oauth_consent import OAuthConsent
from app.database.models.mcp_static_token import MCPStaticToken

__all__ = ["Base", "BaseModel", "OAuthClient", "OAuthAccessToken", "OAuthRefreshToken", "OAuthConsent", "MCPStaticToken"]
```

- [ ] **Step 8: Commit**

```bash
git add apps/mcp/app/database/
git commit -m "feat(mcp): add OAuth 2.1 database models"
```

---

## Chunk 2: OAuth 2.1 Security + Endpoints

### Task 3: OAuth security utilities

**Files:**
- Create: `apps/mcp/app/oauth/security.py`

- [ ] **Step 1: Create security.py** (follows MegaSearch pattern with prefixed tokens)

```python
"""OAuth 2.1 security: PKCE, token generation, hashing."""

import hashlib
import secrets
import base64
import re
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


# PKCE
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/oauth/security.py
git commit -m "feat(mcp): add OAuth 2.1 security utilities (PKCE, tokens, hashing)"
```

### Task 4: OAuth discovery endpoints

**Files:**
- Create: `apps/mcp/app/oauth/discovery.py`

- [ ] **Step 1: Create discovery.py** (follows MeetEcho pattern)

```python
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
        "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": ["taskpilot:read", "taskpilot:write"],
    }
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/oauth/discovery.py
git commit -m "feat(mcp): add OAuth 2.1 discovery endpoints"
```

### Task 5: OAuth token + authorize endpoints

**Files:**
- Create: `apps/mcp/app/oauth/endpoints.py`

- [ ] **Step 1: Create endpoints.py**

This is the largest file — handles `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`. Follows MeetEcho's authorize flow + MegaSearch's token handling with hashed storage and Redis auth codes.

```python
"""OAuth 2.1 authorization, token, and revocation endpoints."""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database.connection import get_db
from app.database.models import OAuthAccessToken, OAuthClient, OAuthRefreshToken
from app.oauth.security import (
    generate_access_token,
    generate_auth_code,
    generate_refresh_token,
    hash_token,
    validate_redirect_uri,
    verify_client_secret,
    verify_pkce_challenge,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/oauth")

_redis: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


# --- Authorize ---

@router.get("/authorize")
async def authorize(
    response_type: str = Query(...),
    client_id: str = Query(...),
    redirect_uri: str = Query(...),
    code_challenge: str = Query(...),
    code_challenge_method: str = Query("S256"),
    scope: str = Query(default="taskpilot:read taskpilot:write"),
    state: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Authorization endpoint — redirects to consent or issues code."""
    if response_type != "code":
        raise HTTPException(400, "Only response_type=code is supported")
    if code_challenge_method != "S256":
        raise HTTPException(400, "Only S256 code_challenge_method is supported")
    if not validate_redirect_uri(redirect_uri):
        raise HTTPException(400, "Invalid redirect_uri: HTTPS required")

    # Validate client
    result = await db.execute(select(OAuthClient).where(OAuthClient.client_id == client_id, OAuthClient.is_active == True))
    client = result.scalar_one_or_none()
    if not client:
        raise HTTPException(400, "Unknown client_id")
    if redirect_uri not in (client.redirect_uris or []):
        raise HTTPException(400, "redirect_uri not registered for this client")

    # For now: auto-approve using the client's owner (no interactive consent page)
    # In production, redirect to frontend consent page
    if not client.owner_id:
        raise HTTPException(400, "Client has no owner — cannot auto-approve")

    # Generate auth code, store in Redis
    code = generate_auth_code()
    r = await get_redis()
    await r.setex(
        f"oauth:code:{code}",
        settings.mcp_auth_code_ttl,
        json.dumps({
            "client_id": client_id,
            "user_id": str(client.owner_id),
            "redirect_uri": redirect_uri,
            "scope": scope,
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method,
        }),
    )

    # Redirect back with code
    params = f"code={code}"
    if state:
        params += f"&state={state}"
    return RedirectResponse(f"{redirect_uri}?{params}", status_code=302)


# --- Token ---

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    expires_in: int
    refresh_token: Optional[str] = None
    scope: str


@router.post("/token")
async def token(
    grant_type: str = Form(...),
    code: Optional[str] = Form(default=None),
    redirect_uri: Optional[str] = Form(default=None),
    client_id: Optional[str] = Form(default=None),
    client_secret: Optional[str] = Form(default=None),
    code_verifier: Optional[str] = Form(default=None),
    refresh_token: Optional[str] = Form(default=None),
    scope: Optional[str] = Form(default=None),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
):
    if grant_type == "authorization_code":
        return await _handle_auth_code(code, redirect_uri, client_id, code_verifier, db)
    elif grant_type == "refresh_token":
        return await _handle_refresh(refresh_token, client_id, db)
    elif grant_type == "client_credentials":
        return await _handle_client_credentials(client_id, client_secret, scope, db)
    else:
        raise HTTPException(400, f"Unsupported grant_type: {grant_type}")


async def _handle_auth_code(code, redirect_uri, client_id, code_verifier, db):
    if not all([code, redirect_uri, client_id, code_verifier]):
        raise HTTPException(400, "Missing required parameters")

    r = await get_redis()
    code_data_raw = await r.get(f"oauth:code:{code}")
    if not code_data_raw:
        raise HTTPException(400, "Invalid or expired authorization code")

    # Delete code (single-use)
    await r.delete(f"oauth:code:{code}")
    code_data = json.loads(code_data_raw)

    if code_data["client_id"] != client_id:
        raise HTTPException(400, "client_id mismatch")
    if code_data["redirect_uri"] != redirect_uri:
        raise HTTPException(400, "redirect_uri mismatch")
    if not verify_pkce_challenge(code_verifier, code_data["code_challenge"], code_data["code_challenge_method"]):
        raise HTTPException(400, "PKCE verification failed")

    return await _create_token_pair(code_data["user_id"], client_id, code_data["scope"], db)


async def _handle_refresh(raw_refresh_token, client_id, db):
    if not raw_refresh_token:
        raise HTTPException(400, "Missing refresh_token")

    token_hash = hash_token(raw_refresh_token)
    result = await db.execute(select(OAuthRefreshToken).where(OAuthRefreshToken.token_hash == token_hash))
    rt = result.scalar_one_or_none()

    if not rt or not rt.is_valid:
        raise HTTPException(400, "Invalid or expired refresh token")
    if client_id and rt.client_id != client_id:
        raise HTTPException(400, "client_id mismatch")

    # Revoke old tokens
    rt.revoked_at = datetime.now(timezone.utc)
    old_at = await db.execute(select(OAuthAccessToken).where(OAuthAccessToken.id == rt.access_token_id))
    old_access = old_at.scalar_one_or_none()
    if old_access:
        old_access.revoked_at = datetime.now(timezone.utc)

    await db.commit()

    # Get scope from old access token
    scope = old_access.scope if old_access else "taskpilot:read taskpilot:write"
    return await _create_token_pair(str(rt.user_id), rt.client_id, scope, db)


async def _handle_client_credentials(client_id, client_secret, scope, db):
    if not all([client_id, client_secret]):
        raise HTTPException(400, "Missing client_id or client_secret")

    result = await db.execute(select(OAuthClient).where(OAuthClient.client_id == client_id, OAuthClient.is_active == True))
    client = result.scalar_one_or_none()

    if not client or not client.client_secret_hash:
        raise HTTPException(401, "Invalid client credentials")
    if not verify_secret(client_secret, client.client_secret_hash):
        raise HTTPException(401, "Invalid client credentials")
    if not client.owner_id:
        raise HTTPException(400, "Client has no owner")

    use_scope = scope or client.scope or "taskpilot:read taskpilot:write"

    # No refresh token for client_credentials
    raw_at, at_hash = generate_access_token()
    access_token = OAuthAccessToken(
        token_hash=at_hash,
        user_id=client.owner_id,
        client_id=client_id,
        scope=use_scope,
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=settings.mcp_access_token_ttl),
    )
    db.add(access_token)
    await db.commit()

    return TokenResponse(
        access_token=raw_at,
        expires_in=settings.mcp_access_token_ttl,
        scope=use_scope,
    )


async def _create_token_pair(user_id: str, client_id: str, scope: str, db: AsyncSession) -> TokenResponse:
    raw_at, at_hash = generate_access_token()
    raw_rt, rt_hash = generate_refresh_token()
    now = datetime.now(timezone.utc)

    access_token = OAuthAccessToken(
        token_hash=at_hash,
        user_id=user_id,
        client_id=client_id,
        scope=scope,
        expires_at=now + timedelta(seconds=settings.mcp_access_token_ttl),
    )
    db.add(access_token)
    await db.flush()

    refresh_token = OAuthRefreshToken(
        token_hash=rt_hash,
        access_token_id=access_token.id,
        user_id=user_id,
        client_id=client_id,
        expires_at=now + timedelta(seconds=settings.mcp_refresh_token_ttl),
    )
    db.add(refresh_token)
    await db.commit()

    return TokenResponse(
        access_token=raw_at,
        refresh_token=raw_rt,
        expires_in=settings.mcp_access_token_ttl,
        scope=scope,
    )


# --- Revoke ---

@router.post("/revoke")
async def revoke(
    token: str = Form(...),
    token_type_hint: Optional[str] = Form(default=None),
    db: AsyncSession = Depends(get_db),
):
    """RFC 7009 token revocation."""
    token_hash = hash_token(token)
    now = datetime.now(timezone.utc)

    # Try access token first
    result = await db.execute(select(OAuthAccessToken).where(OAuthAccessToken.token_hash == token_hash))
    at = result.scalar_one_or_none()
    if at:
        at.revoked_at = now
        await db.commit()
        return {"status": "revoked"}

    # Try refresh token
    result = await db.execute(select(OAuthRefreshToken).where(OAuthRefreshToken.token_hash == token_hash))
    rt = result.scalar_one_or_none()
    if rt:
        rt.revoked_at = now
        await db.commit()
        return {"status": "revoked"}

    # Token not found — return 200 anyway per RFC 7009
    return {"status": "revoked"}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/oauth/endpoints.py
git commit -m "feat(mcp): add OAuth 2.1 authorize, token, and revoke endpoints"
```

### Task 6: Auth dependency (request authentication)

**Files:**
- Create: `apps/mcp/app/oauth/auth.py`

- [ ] **Step 1: Create auth.py** (follows MeetEcho pattern)

```python
"""MCP request authentication — extracts and validates Bearer tokens."""

from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request
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
            headers={"WWW-Authenticate": f'Bearer resource_metadata="{settings.mcp_issuer_url}/.well-known/oauth-protected-resource"'},
        )

    raw_token = credentials.credentials
    token_hash = hash_token(raw_token)

    # Try static token first (mcp_st_ prefix)
    if raw_token.startswith("mcp_st_"):
        result = await db.execute(select(MCPStaticToken).where(MCPStaticToken.token_hash == token_hash))
        st = result.scalar_one_or_none()
        if not st or not st.is_valid:
            raise HTTPException(401, "Invalid or expired static token")
        # Update last_used
        st.last_used_at = datetime.now(timezone.utc)
        await db.commit()
        return MCPAuthContext(
            user_id=str(st.user_id),
            scopes=["taskpilot:read", "taskpilot:write"],
            workspace_slug=st.workspace_slug,
        )

    # Try OAuth access token (mcp_at_ prefix)
    result = await db.execute(select(OAuthAccessToken).where(OAuthAccessToken.token_hash == token_hash))
    at = result.scalar_one_or_none()
    if not at or not at.is_valid:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": f'Bearer error="invalid_token", resource_metadata="{settings.mcp_issuer_url}/.well-known/oauth-protected-resource"'},
        )

    return MCPAuthContext(
        user_id=str(at.user_id),
        scopes=at.scope.split() if at.scope else [],
    )
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/oauth/auth.py
git commit -m "feat(mcp): add MCP auth dependency (Bearer token validation)"
```

---

## Chunk 3: TaskPilot API Client + Smart Router

### Task 7: TaskPilot API client

**Files:**
- Create: `apps/mcp/app/taskpilot/client.py`

- [ ] **Step 1: Create client.py**

```python
"""HTTP client for TaskPilot REST API."""

import logging
from typing import Any, Optional

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
                headers={"X-Api-Key": self.api_key, "Content-Type": "application/json"},
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
        return await self._request("GET", f"/api/workspaces/{self.workspace}/projects/")

    async def get_project(self, project_id: str) -> dict:
        return await self._request("GET", f"/api/workspaces/{self.workspace}/projects/{project_id}/")

    # --- Issues ---
    async def list_issues(self, project_id: str, params: dict | None = None) -> Any:
        return await self._request("GET", f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/", params=params)

    async def create_issue(self, project_id: str, data: dict) -> dict:
        return await self._request("POST", f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/", json=data)

    async def get_issue(self, project_id: str, issue_id: str) -> dict:
        return await self._request("GET", f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/{issue_id}/")

    async def update_issue(self, project_id: str, issue_id: str, data: dict) -> dict:
        return await self._request("PATCH", f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/{issue_id}/", json=data)

    async def get_issue_by_identifier(self, identifier: str) -> dict:
        """Get issue by human-readable identifier like FOR-AI-42."""
        return await self._request("GET", f"/api/workspaces/{self.workspace}/work-items/{identifier}/")

    # --- States ---
    async def list_states(self, project_id: str | None = None) -> list[dict]:
        if project_id:
            return await self._request("GET", f"/api/workspaces/{self.workspace}/projects/{project_id}/states/")
        return await self._request("GET", f"/api/workspaces/{self.workspace}/states/")

    # --- Cycles ---
    async def list_cycles(self, project_id: str) -> list[dict]:
        return await self._request("GET", f"/api/workspaces/{self.workspace}/projects/{project_id}/cycles/")

    async def add_issue_to_cycle(self, project_id: str, cycle_id: str, issue_ids: list[str]) -> Any:
        return await self._request("POST", f"/api/workspaces/{self.workspace}/projects/{project_id}/cycles/{cycle_id}/cycle-issues/", json={"issues": issue_ids})

    # --- Comments ---
    async def add_comment(self, project_id: str, issue_id: str, comment: str) -> dict:
        return await self._request("POST", f"/api/workspaces/{self.workspace}/projects/{project_id}/issues/{issue_id}/comments/", json={"comment_html": f"<p>{comment}</p>"})

    async def close(self):
        if self._client:
            await self._client.aclose()
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/taskpilot/client.py
git commit -m "feat(mcp): add TaskPilot REST API client"
```

### Task 8: Smart router (LLM + Redis cache)

**Files:**
- Create: `apps/mcp/app/router/cache.py`
- Create: `apps/mcp/app/router/smart_router.py`

- [ ] **Step 1: Create cache.py**

```python
"""Redis-based routing cache for project classification."""

import hashlib
from typing import Optional

import redis.asyncio as aioredis

from app.config import settings

_redis: Optional[aioredis.Redis] = None
CACHE_TTL = 7 * 24 * 3600  # 7 days


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


def _cache_key(workspace: str, title: str) -> str:
    normalized = title.strip().lower()
    title_hash = hashlib.sha256(normalized.encode()).hexdigest()[:16]
    return f"mcp:route:{workspace}:{title_hash}"


async def get_cached_project(workspace: str, title: str) -> Optional[str]:
    r = await get_redis()
    return await r.get(_cache_key(workspace, title))


async def set_cached_project(workspace: str, title: str, project_id: str):
    r = await get_redis()
    await r.setex(_cache_key(workspace, title), CACHE_TTL, project_id)


async def clear_workspace_cache(workspace: str):
    r = await get_redis()
    keys = []
    async for key in r.scan_iter(f"mcp:route:{workspace}:*"):
        keys.append(key)
    if keys:
        await r.delete(*keys)
```

- [ ] **Step 2: Create smart_router.py**

```python
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
        logger.info(f"Cache hit for '{title}' → {cached}")
        return cached

    # Call LLM
    project_list = [{"id": str(p["id"]), "name": p.get("name", ""), "description": p.get("description", "")} for p in projects]

    llm_client = AsyncOpenAI(base_url=settings.llm_api_base_url, api_key=settings.llm_api_key)
    response = await llm_client.chat.completions.create(
        model=settings.llm_model,
        messages=[
            {"role": "system", "content": ROUTING_SYSTEM_PROMPT},
            {"role": "user", "content": f"Projects:\n{json.dumps(project_list, indent=2)}\n\nTask: {title}"},
        ],
        temperature=0,
        max_tokens=100,
    )

    project_id = response.choices[0].message.content.strip().strip('"')

    # Validate the returned ID exists
    valid_ids = {str(p["id"]) for p in projects}
    if project_id not in valid_ids:
        logger.warning(f"LLM returned invalid project_id '{project_id}', falling back to first project")
        project_id = str(projects[0]["id"])

    # Cache the result
    await set_cached_project(workspace, title, project_id)
    logger.info(f"Routed '{title}' → {project_id} (LLM)")

    return project_id
```

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/app/router/
git commit -m "feat(mcp): add LLM-powered smart router with Redis cache"
```

---

## Chunk 4: MCP Protocol + Tools + Main App

### Task 9: JSON-RPC protocol

**Files:**
- Create: `apps/mcp/app/mcp/jsonrpc.py`

- [ ] **Step 1: Create jsonrpc.py** (from MeetEcho)

```python
"""JSON-RPC 2.0 protocol models for MCP."""

from typing import Any, Optional
from pydantic import BaseModel


class JSONRPCRequest(BaseModel):
    jsonrpc: str = "2.0"
    id: Optional[int | str] = None
    method: str
    params: Optional[dict[str, Any]] = None


class JSONRPCResponse(BaseModel):
    jsonrpc: str = "2.0"
    id: Optional[int | str] = None
    result: Optional[Any] = None
    error: Optional[dict[str, Any]] = None

    class Config:
        json_encoders = {type(None): lambda v: v}

    def model_dump(self, **kwargs):
        data = super().model_dump(**kwargs)
        return {k: v for k, v in data.items() if v is not None or k in ("jsonrpc", "id")}


# Error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


def success_response(req_id, result: Any) -> JSONRPCResponse:
    return JSONRPCResponse(id=req_id, result=result)


def error_response(req_id, code: int, message: str, data: Any = None) -> JSONRPCResponse:
    err = {"code": code, "message": message}
    if data:
        err["data"] = data
    return JSONRPCResponse(id=req_id, error=err)


def method_not_found(req_id, method: str) -> JSONRPCResponse:
    return error_response(req_id, METHOD_NOT_FOUND, f"Method not found: {method}")


def invalid_params(req_id, message: str) -> JSONRPCResponse:
    return error_response(req_id, INVALID_PARAMS, message)


def internal_error(req_id, message: str = "Internal error") -> JSONRPCResponse:
    return error_response(req_id, INTERNAL_ERROR, message)
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/mcp/jsonrpc.py
git commit -m "feat(mcp): add JSON-RPC 2.0 protocol models"
```

### Task 10: Tool definitions

**Files:**
- Create: `apps/mcp/app/mcp/tools.py`

- [ ] **Step 1: Create tools.py**

```python
"""MCP tool definitions — what AI agents can call."""

TOOLS = [
    {
        "name": "create_task",
        "description": "Create a task. Automatically routes to the right project, or specify project_hint.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Task title"},
                "description": {"type": "string", "description": "Detailed description (optional)"},
                "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"], "description": "Priority level"},
                "project_hint": {"type": "string", "description": "Project name or identifier to route to (optional)"},
            },
            "required": ["title"],
        },
    },
    {
        "name": "move_task",
        "description": "Move a task to a different state (e.g., In Progress, Done).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
                "state": {"type": "string", "description": "Target state name (e.g., 'In Progress', 'Done')"},
            },
            "required": ["identifier", "state"],
        },
    },
    {
        "name": "find_tasks",
        "description": "Search for tasks across the workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search text"},
                "state": {"type": "string", "description": "Filter by state name"},
                "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"]},
                "project_hint": {"type": "string", "description": "Filter by project name"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "list_projects",
        "description": "List all projects in the workspace.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_tasks",
        "description": "List tasks with optional filters.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or ID"},
                "state": {"type": "string", "description": "State name filter"},
                "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"]},
                "limit": {"type": "integer", "description": "Max results (default 20)", "default": 20},
            },
        },
    },
    {
        "name": "get_task",
        "description": "Get full details of a task by identifier.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
            },
            "required": ["identifier"],
        },
    },
    {
        "name": "update_task",
        "description": "Update task fields (title, description, priority, dates).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"]},
                "start_date": {"type": "string", "description": "YYYY-MM-DD"},
                "target_date": {"type": "string", "description": "YYYY-MM-DD"},
            },
            "required": ["identifier"],
        },
    },
    {
        "name": "add_comment",
        "description": "Add a comment to a task.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
                "comment": {"type": "string", "description": "Comment text"},
            },
            "required": ["identifier", "comment"],
        },
    },
    {
        "name": "list_states",
        "description": "List workflow states for a project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or ID (optional)"},
            },
        },
    },
    {
        "name": "list_cycles",
        "description": "List sprints/cycles for a project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or ID"},
            },
            "required": ["project"],
        },
    },
    {
        "name": "assign_to_cycle",
        "description": "Add a task to a sprint/cycle.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42"},
                "cycle_id": {"type": "string", "description": "Cycle UUID"},
            },
            "required": ["identifier", "cycle_id"],
        },
    },
]


def get_tool_definitions() -> list[dict]:
    return TOOLS


def get_tool_by_name(name: str) -> dict | None:
    return next((t for t in TOOLS if t["name"] == name), None)
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/mcp/tools.py
git commit -m "feat(mcp): add MCP tool definitions (11 tools)"
```

### Task 11: Tool handlers

**Files:**
- Create: `apps/mcp/app/mcp/handlers.py`

- [ ] **Step 1: Create handlers.py**

```python
"""MCP tool execution handlers."""

import json
import logging
from typing import Any

from app.mcp.tools import get_tool_by_name
from app.oauth.auth import MCPAuthContext
from app.router.smart_router import route_task
from app.taskpilot.client import TaskPilotClient

logger = logging.getLogger(__name__)

WRITE_TOOLS = {"create_task", "move_task", "update_task", "add_comment", "assign_to_cycle"}


async def execute_tool(name: str, arguments: dict[str, Any], auth: MCPAuthContext) -> str:
    """Execute an MCP tool and return JSON result string."""
    tool = get_tool_by_name(name)
    if not tool:
        raise ValueError(f"Unknown tool: {name}")

    # Scope check
    if name in WRITE_TOOLS and not auth.has_scope("taskpilot:write"):
        raise PermissionError(f"Tool '{name}' requires 'taskpilot:write' scope")
    if not auth.has_scope("taskpilot:read"):
        raise PermissionError("Requires 'taskpilot:read' scope")

    workspace = auth.workspace_slug
    client = TaskPilotClient(workspace)

    try:
        handler = HANDLERS.get(name)
        if not handler:
            raise ValueError(f"No handler for tool: {name}")
        result = await handler(arguments, client, workspace)
        return json.dumps(result, default=str)
    finally:
        await client.close()


async def handle_create_task(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    project_id = await route_task(workspace, args["title"], args.get("project_hint"), client)
    data = {"name": args["title"]}
    if args.get("description"):
        data["description_html"] = f"<p>{args['description']}</p>"
    if args.get("priority"):
        data["priority"] = args["priority"]
    issue = await client.create_issue(project_id, data)
    return {"identifier": f"{issue.get('project_detail', {}).get('identifier', '?')}-{issue.get('sequence_id', '?')}", "id": issue["id"], "project": issue.get("project_detail", {}).get("name", ""), "title": issue["name"]}


async def handle_move_task(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    project_id = str(issue["project"])
    states = await client.list_states(project_id)
    target_state = next((s for s in states if args["state"].lower() in s["name"].lower()), None)
    if not target_state:
        available = [s["name"] for s in states]
        return {"error": f"State '{args['state']}' not found. Available: {available}"}
    updated = await client.update_issue(project_id, str(issue["id"]), {"state": target_state["id"]})
    return {"identifier": args["identifier"], "state": target_state["name"], "status": "moved"}


async def handle_find_tasks(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    projects = await client.list_projects()
    results = []
    for project in projects:
        if args.get("project_hint") and args["project_hint"].lower() not in project.get("name", "").lower():
            continue
        issues = await client.list_issues(str(project["id"]), params={"search": args["query"]})
        if isinstance(issues, dict) and "results" in issues:
            issues = issues["results"]
        for issue in (issues or [])[:10]:
            results.append({"identifier": f"{project.get('identifier', '?')}-{issue.get('sequence_id', '?')}", "title": issue.get("name", ""), "state": issue.get("state_detail", {}).get("name", ""), "priority": issue.get("priority", "")})
    return {"tasks": results[:20], "count": len(results)}


async def handle_list_projects(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    projects = await client.list_projects()
    return {"projects": [{"id": p["id"], "name": p["name"], "identifier": p.get("identifier", ""), "description": p.get("description", "")} for p in projects]}


async def handle_list_tasks(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    projects = await client.list_projects()
    target_project = None
    if args.get("project"):
        target_project = next((p for p in projects if args["project"].lower() in p.get("name", "").lower() or args["project"] == str(p["id"])), None)
    if target_project:
        projects = [target_project]
    results = []
    limit = args.get("limit", 20)
    for project in projects:
        issues = await client.list_issues(str(project["id"]))
        if isinstance(issues, dict) and "results" in issues:
            issues = issues["results"]
        for issue in (issues or []):
            results.append({"identifier": f"{project.get('identifier', '?')}-{issue.get('sequence_id', '?')}", "title": issue.get("name", ""), "state": issue.get("state_detail", {}).get("name", ""), "priority": issue.get("priority", "")})
            if len(results) >= limit:
                break
        if len(results) >= limit:
            break
    return {"tasks": results, "count": len(results)}


async def handle_get_task(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    return {"id": issue["id"], "identifier": args["identifier"], "title": issue.get("name", ""), "description": issue.get("description_stripped", ""), "state": issue.get("state_detail", {}).get("name", ""), "priority": issue.get("priority", ""), "assignees": [a.get("display_name", "") for a in issue.get("assignee_detail", [])], "start_date": issue.get("start_date"), "target_date": issue.get("target_date"), "created_at": issue.get("created_at")}


async def handle_update_task(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    data = {}
    if "title" in args:
        data["name"] = args["title"]
    if "description" in args:
        data["description_html"] = f"<p>{args['description']}</p>"
    if "priority" in args:
        data["priority"] = args["priority"]
    if "start_date" in args:
        data["start_date"] = args["start_date"]
    if "target_date" in args:
        data["target_date"] = args["target_date"]
    if not data:
        return {"error": "No fields to update"}
    updated = await client.update_issue(str(issue["project"]), str(issue["id"]), data)
    return {"identifier": args["identifier"], "status": "updated", "fields": list(data.keys())}


async def handle_add_comment(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    comment = await client.add_comment(str(issue["project"]), str(issue["id"]), args["comment"])
    return {"identifier": args["identifier"], "comment_id": comment.get("id", ""), "status": "added"}


async def handle_list_states(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    project_id = None
    if args.get("project"):
        projects = await client.list_projects()
        p = next((p for p in projects if args["project"].lower() in p.get("name", "").lower()), None)
        if p:
            project_id = str(p["id"])
    states = await client.list_states(project_id)
    return {"states": [{"id": s["id"], "name": s["name"], "group": s.get("group", "")} for s in states]}


async def handle_list_cycles(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    projects = await client.list_projects()
    p = next((p for p in projects if args["project"].lower() in p.get("name", "").lower()), None)
    if not p:
        return {"error": f"Project '{args['project']}' not found"}
    cycles = await client.list_cycles(str(p["id"]))
    return {"cycles": [{"id": c["id"], "name": c["name"], "start_date": c.get("start_date"), "end_date": c.get("end_date")} for c in cycles]}


async def handle_assign_to_cycle(args: dict, client: TaskPilotClient, workspace: str) -> dict:
    issue = await client.get_issue_by_identifier(args["identifier"])
    await client.add_issue_to_cycle(str(issue["project"]), args["cycle_id"], [str(issue["id"])])
    return {"identifier": args["identifier"], "cycle_id": args["cycle_id"], "status": "assigned"}


HANDLERS = {
    "create_task": handle_create_task,
    "move_task": handle_move_task,
    "find_tasks": handle_find_tasks,
    "list_projects": handle_list_projects,
    "list_tasks": handle_list_tasks,
    "get_task": handle_get_task,
    "update_task": handle_update_task,
    "add_comment": handle_add_comment,
    "list_states": handle_list_states,
    "list_cycles": handle_list_cycles,
    "assign_to_cycle": handle_assign_to_cycle,
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/mcp/handlers.py
git commit -m "feat(mcp): add tool execution handlers (11 tools with smart routing)"
```

### Task 12: MCP server + JSON-RPC router

**Files:**
- Create: `apps/mcp/app/mcp/server.py`

- [ ] **Step 1: Create server.py** (from MeetEcho pattern)

```python
"""MCP JSON-RPC request handler."""

import logging
from typing import Any

from app.mcp.jsonrpc import (
    JSONRPCRequest, JSONRPCResponse,
    success_response, internal_error, invalid_params, method_not_found,
)
from app.mcp.handlers import execute_tool
from app.mcp.tools import get_tool_definitions
from app.oauth.auth import MCPAuthContext

logger = logging.getLogger(__name__)

SERVER_INFO = {"name": "taskpilot-mcp", "version": "1.0.0"}
CAPABILITIES = {"tools": {}}


async def handle_request(request: JSONRPCRequest, auth: MCPAuthContext) -> JSONRPCResponse:
    try:
        method = request.method
        params = request.params or {}

        if method == "initialize":
            return success_response(request.id, {"protocolVersion": "2024-11-05", "serverInfo": SERVER_INFO, "capabilities": CAPABILITIES})
        elif method == "tools/list":
            return success_response(request.id, {"tools": get_tool_definitions()})
        elif method == "tools/call":
            return await handle_tools_call(request.id, params, auth)
        elif method == "ping":
            return success_response(request.id, {})
        elif method == "notifications/initialized":
            return success_response(request.id, {})
        else:
            return method_not_found(request.id, method)
    except Exception as e:
        logger.exception(f"Error handling {request.method}")
        return internal_error(request.id, str(e))


async def handle_tools_call(req_id: Any, params: dict, auth: MCPAuthContext) -> JSONRPCResponse:
    tool_name = params.get("name")
    arguments = params.get("arguments", {})

    if not tool_name:
        return invalid_params(req_id, "Missing tool name")

    try:
        result = await execute_tool(tool_name, arguments, auth)
        return success_response(req_id, {"content": [{"type": "text", "text": result}]})
    except PermissionError as e:
        return invalid_params(req_id, str(e))
    except ValueError as e:
        return invalid_params(req_id, str(e))
    except Exception as e:
        logger.exception(f"Tool execution error: {tool_name}")
        return internal_error(req_id, f"Tool error: {str(e)}")
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/mcp/server.py
git commit -m "feat(mcp): add MCP JSON-RPC server (initialize, tools/list, tools/call)"
```

### Task 13: FastAPI main app

**Files:**
- Create: `apps/mcp/app/main.py`

- [ ] **Step 1: Create main.py**

```python
"""TaskPilot MCP Server — FastAPI entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.mcp.jsonrpc import JSONRPCRequest
from app.mcp.server import handle_request
from app.oauth.auth import MCPAuthContext, get_current_user
from app.oauth.discovery import router as discovery_router
from app.oauth.endpoints import router as oauth_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"TaskPilot MCP Server starting on port {settings.mcp_port}")
    yield
    logger.info("TaskPilot MCP Server shutting down")


app = FastAPI(title="TaskPilot MCP Server", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# OAuth routes
app.include_router(discovery_router)
app.include_router(oauth_router)


@app.get("/health")
async def health():
    return {"status": "ok", "server": "taskpilot-mcp"}


@app.post("/mcp")
async def mcp_endpoint(
    request: JSONRPCRequest,
    auth: MCPAuthContext = Depends(get_current_user),
):
    """Main MCP JSON-RPC endpoint."""
    response = await handle_request(request, auth)
    return JSONResponse(content=response.model_dump())


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=settings.mcp_port, reload=True)
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/app/main.py
git commit -m "feat(mcp): add FastAPI main app with MCP + OAuth endpoints"
```

---

## Chunk 5: Docker + Deploy

### Task 14: Dockerfile and docker-compose

**Files:**
- Create: `apps/mcp/Dockerfile`
- Modify: `docker-compose.yml` — add mcp service
- Modify: `docker-compose-local.yml` — add mcp service

- [ ] **Step 1: Create Dockerfile**

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/

EXPOSE 4650

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4650"]
```

- [ ] **Step 2: Add mcp service to docker-compose.yml**

Add after the `live` service:

```yaml
  mcp:
    container_name: taskpilot-mcp
    build:
      context: ./apps/mcp
      dockerfile: Dockerfile
    ports:
      - "4650:4650"
    env_file: .env
    depends_on:
      - api
    restart: always
```

- [ ] **Step 3: Add mcp service to docker-compose-local.yml**

```yaml
  mcp:
    container_name: taskpilot-mcp-dev
    build:
      context: ./apps/mcp
      dockerfile: Dockerfile
    ports:
      - "4650:4650"
    volumes:
      - ./apps/mcp:/app
    env_file: .env
    depends_on:
      - api
    restart: unless-stopped
    command: uvicorn app.main:app --host 0.0.0.0 --port 4650 --reload
    networks:
      - dev_env
```

- [ ] **Step 4: Add MCP env vars to .env**

Append to `.env`:
```
# MCP Server
MCP_PORT=4650
MCP_ISSUER_URL=https://taskpilot-mcp.sudiptadhara.in
MCP_RESOURCE_URL=https://taskpilot-mcp.sudiptadhara.in/mcp
MCP_ACCESS_TOKEN_TTL=3600
MCP_REFRESH_TOKEN_TTL=2592000
MCP_AUTH_CODE_TTL=600
TASKPILOT_WORKSPACE_SLUG=for-ai
```

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/Dockerfile docker-compose.yml docker-compose-local.yml
git commit -m "feat(mcp): add Docker config and compose services"
```

### Task 15: Database migration + build + deploy

- [ ] **Step 1: Create Alembic config**

```bash
cd apps/mcp && pip install alembic asyncpg sqlalchemy && alembic init alembic
```

Configure `alembic.ini` with `sqlalchemy.url` from env.

- [ ] **Step 2: Generate initial migration**

```bash
alembic revision --autogenerate -m "initial mcp tables"
alembic upgrade head
```

- [ ] **Step 3: Build and deploy**

```bash
docker compose build mcp
docker compose up -d mcp
```

- [ ] **Step 4: Verify**

```bash
curl http://localhost:4650/health
# Expected: {"status": "ok", "server": "taskpilot-mcp"}
```

- [ ] **Step 5: Set up NPM proxy**

Add to Nginx Proxy Manager:
- `taskpilot-mcp.sudiptadhara.in` → `http://192.168.11.150:4650`

- [ ] **Step 6: Create initial OAuth client for Claude Code**

```bash
docker compose exec mcp python -c "
import asyncio
from app.database.connection import async_session
from app.database.models import OAuthClient
from app.oauth.security import generate_client_id, generate_client_secret

async def create():
    async with async_session() as db:
        cid = generate_client_id()
        raw_secret, secret_hash = generate_client_secret()
        client = OAuthClient(
            client_id=cid,
            client_secret_hash=secret_hash,
            client_name='Claude Code',
            grant_types=['client_credentials'],
            scope='taskpilot:read taskpilot:write',
            owner_id='<YOUR_USER_UUID>',
            is_active=True,
        )
        db.add(client)
        await db.commit()
        print(f'Client ID: {cid}')
        print(f'Client Secret: {raw_secret}')
        print('Store these securely!')

asyncio.run(create())
"
```

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat(mcp): complete MCP server with OAuth 2.1, smart routing, 11 tools"
git push origin sudipta_main
```
