"""OAuth 2.1 authorization, token, registration, consent, and revocation endpoints."""

import base64
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Form, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database.connection import get_db
from app.database.models import (
    OAuthAccessToken,
    OAuthClient,
    OAuthConsent,
    OAuthRefreshToken,
)
from app.oauth.security import (
    generate_access_token,
    generate_auth_code,
    generate_refresh_token,
    hash_token,
    validate_redirect_uri,
    verify_pkce_challenge,
    verify_secret,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/oauth")

_redis: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


# ---------------------------------------------------------------------------
# Authorize
# ---------------------------------------------------------------------------


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
    """Authorization endpoint — redirects to consent page or auto-approves."""
    if response_type != "code":
        raise HTTPException(400, "Only response_type=code is supported")
    if code_challenge_method != "S256":
        raise HTTPException(400, "Only S256 code_challenge_method is supported")
    if not validate_redirect_uri(redirect_uri):
        raise HTTPException(400, "Invalid redirect_uri: HTTPS required")

    # Look up the client
    result = await db.execute(
        select(OAuthClient).where(
            OAuthClient.client_id == client_id, OAuthClient.is_active == True
        )
    )
    client = result.scalar_one_or_none()

    # Dynamic client registration: auto-register unknown clients
    if not client and settings.mcp_dynamic_registration:
        client = OAuthClient(
            client_id=client_id,
            client_name=f"auto-registered-{client_id[:16]}",
            redirect_uris=[redirect_uri],
            grant_types=["authorization_code"],
            response_types=["code"],
            token_endpoint_auth_method="none",
            scope="taskpilot:read taskpilot:write",
            is_active=True,
        )
        db.add(client)
        await db.commit()
        await db.refresh(client)
        logger.info("Dynamic registration: auto-registered client %s", client_id)
    elif not client:
        raise HTTPException(400, "Unknown client_id")

    if redirect_uri not in (client.redirect_uris or []):
        raise HTTPException(400, "redirect_uri not registered for this client")

    # Check for existing consent — if found, auto-approve
    if client.owner_id:
        consent_result = await db.execute(
            select(OAuthConsent).where(
                OAuthConsent.user_id == client.owner_id,
                OAuthConsent.client_id == client_id,
            )
        )
        existing_consent = consent_result.scalar_one_or_none()
        if existing_consent:
            code = generate_auth_code()
            r = await get_redis()
            await r.setex(
                f"oauth:code:{code}",
                settings.mcp_auth_code_ttl,
                json.dumps(
                    {
                        "client_id": client_id,
                        "user_id": str(client.owner_id),
                        "redirect_uri": redirect_uri,
                        "scope": scope,
                        "code_challenge": code_challenge,
                        "code_challenge_method": code_challenge_method,
                        "workspace_slug": existing_consent.workspace_slug,
                    }
                ),
            )
            params = f"code={code}"
            if state:
                params += f"&state={state}"
            return RedirectResponse(
                f"{redirect_uri}?{params}", status_code=302
            )

    # No existing consent — redirect to frontend consent page
    oauth_params = {
        "response_type": response_type,
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method,
        "scope": scope,
        "state": state or "",
        "client_name": client.client_name or client_id,
    }
    oauth_state = base64.urlsafe_b64encode(
        json.dumps(oauth_params).encode()
    ).decode()

    consent_url = (
        f"{settings.frontend_url}/oauth/consent?oauth_state={oauth_state}"
    )
    return RedirectResponse(consent_url, status_code=302)


# ---------------------------------------------------------------------------
# Dynamic Client Registration (RFC 7591)
# ---------------------------------------------------------------------------


class ClientRegistrationRequest(BaseModel):
    client_name: Optional[str] = None
    redirect_uris: list[str] = []
    grant_types: list[str] = ["authorization_code"]
    response_types: list[str] = ["code"]
    token_endpoint_auth_method: str = "none"
    scope: Optional[str] = None


class ClientRegistrationResponse(BaseModel):
    client_id: str
    client_name: str
    redirect_uris: list[str]
    grant_types: list[str]
    response_types: list[str]
    token_endpoint_auth_method: str


@router.post("/register")
async def register_client(
    body: ClientRegistrationRequest,
    db: AsyncSession = Depends(get_db),
):
    """RFC 7591 dynamic client registration."""
    import time
    from urllib.parse import urlparse

    if not settings.mcp_dynamic_registration:
        raise HTTPException(403, "Dynamic client registration is disabled")

    import secrets as _secrets
    from sqlalchemy import cast
    from sqlalchemy.dialects.postgresql import JSONB

    # Check if client with same redirect_uris already exists (idempotent registration)
    existing = None
    if body.redirect_uris:
        result = await db.execute(
            select(OAuthClient).where(OAuthClient.is_active == True)
        )
        all_clients = result.scalars().all()
        for c in all_clients:
            if c.redirect_uris == body.redirect_uris:
                existing = c
                break

    # Generate client_id only for new registrations
    client_id = f"mcp_{_secrets.token_urlsafe(16)}"
    if existing:
        # Return existing registration
        response_data = {
            "client_id": existing.client_id,
            "client_id_issued_at": int(existing.created_at.timestamp()) if existing.created_at else int(time.time()),
            "redirect_uris": existing.redirect_uris or [],
            "grant_types": existing.grant_types or ["authorization_code", "refresh_token"],
            "response_types": existing.response_types or ["code"],
            "token_endpoint_auth_method": existing.token_endpoint_auth_method or "none",
        }
        if existing.client_name:
            response_data["client_name"] = existing.client_name
        return response_data

    grant_types = body.grant_types or ["authorization_code", "refresh_token"]
    response_types = body.response_types or ["code"]
    auth_method = body.token_endpoint_auth_method or "none"

    client = OAuthClient(
        client_id=client_id,
        client_name=body.client_name,
        redirect_uris=body.redirect_uris,
        grant_types=grant_types,
        response_types=response_types,
        token_endpoint_auth_method=auth_method,
        scope="taskpilot:read taskpilot:write",
        is_active=True,
    )
    db.add(client)
    await db.commit()

    # Build response — exclude None values (mcp-remote expects string, not null)
    response_data = {
        "client_id": client_id,
        "client_id_issued_at": int(time.time()),
        "redirect_uris": body.redirect_uris or [],
        "grant_types": grant_types,
        "response_types": response_types,
        "token_endpoint_auth_method": auth_method,
    }
    if body.client_name is not None:
        response_data["client_name"] = body.client_name

    return response_data


# ---------------------------------------------------------------------------
# Consent Approval (called by the frontend consent page)
# ---------------------------------------------------------------------------


class ApproveRequest(BaseModel):
    oauth_state: str
    workspace_slug: str
    scopes: list[str]
    user_token: Optional[str] = ""


class ApproveResponse(BaseModel):
    redirect_uri: str
    code: str
    state: str


@router.post("/approve")
async def approve(
    body: ApproveRequest,
    db: AsyncSession = Depends(get_db),
):
    """Consent approval endpoint — validates user, generates auth code."""
    # Validate user_token against TaskPilot API
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{settings.taskpilot_api_url}/api/users/me/",
                cookies={"sessionid": body.user_token},
                headers={"Authorization": f"Bearer {body.user_token}"},
                timeout=10.0,
            )
    except httpx.RequestError as exc:
        logger.error("Failed to validate user token: %s", exc)
        raise HTTPException(502, "Failed to validate user with TaskPilot API")

    if resp.status_code != 200:
        raise HTTPException(401, "Invalid user token — authentication failed")

    user_data = resp.json()
    user_id = str(user_data.get("id", ""))
    if not user_id:
        raise HTTPException(401, "Could not determine user identity")

    # Decode oauth_state
    try:
        oauth_params = json.loads(
            base64.urlsafe_b64decode(body.oauth_state).decode()
        )
    except Exception:
        raise HTTPException(400, "Invalid oauth_state")

    client_id = oauth_params.get("client_id", "")
    redirect_uri = oauth_params.get("redirect_uri", "")
    code_challenge = oauth_params.get("code_challenge", "")
    code_challenge_method = oauth_params.get("code_challenge_method", "S256")
    original_state = oauth_params.get("state", "")
    scope = " ".join(body.scopes) if body.scopes else oauth_params.get("scope", "")

    # Verify client exists
    result = await db.execute(
        select(OAuthClient).where(
            OAuthClient.client_id == client_id, OAuthClient.is_active == True
        )
    )
    oauth_client = result.scalar_one_or_none()
    if not oauth_client:
        raise HTTPException(400, "Unknown client_id in oauth_state")

    # Generate auth code and store in Redis
    code = generate_auth_code()
    r = await get_redis()
    await r.setex(
        f"oauth:code:{code}",
        settings.mcp_auth_code_ttl,
        json.dumps(
            {
                "client_id": client_id,
                "user_id": user_id,
                "redirect_uri": redirect_uri,
                "scope": scope,
                "code_challenge": code_challenge,
                "code_challenge_method": code_challenge_method,
                "workspace_slug": body.workspace_slug,
            }
        ),
    )

    # Record consent in DB (upsert)
    now = datetime.now(timezone.utc)
    consent_result = await db.execute(
        select(OAuthConsent).where(
            OAuthConsent.user_id == user_id,
            OAuthConsent.client_id == client_id,
        )
    )
    existing_consent = consent_result.scalar_one_or_none()
    if existing_consent:
        existing_consent.scope = scope
        existing_consent.workspace_slug = body.workspace_slug
        existing_consent.granted_at = now
    else:
        consent = OAuthConsent(
            user_id=user_id,
            client_id=client_id,
            scope=scope,
            workspace_slug=body.workspace_slug,
            granted_at=now,
        )
        db.add(consent)
    await db.commit()

    return ApproveResponse(
        redirect_uri=redirect_uri,
        code=code,
        state=original_state,
    )


# ---------------------------------------------------------------------------
# Token
# ---------------------------------------------------------------------------


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
    db: AsyncSession = Depends(get_db),
):
    if grant_type == "authorization_code":
        return await _handle_auth_code(
            code, redirect_uri, client_id, code_verifier, db
        )
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

    await r.delete(f"oauth:code:{code}")
    code_data = json.loads(code_data_raw)

    if code_data["client_id"] != client_id:
        raise HTTPException(400, "client_id mismatch")
    if code_data["redirect_uri"] != redirect_uri:
        raise HTTPException(400, "redirect_uri mismatch")
    if not verify_pkce_challenge(
        code_verifier, code_data["code_challenge"], code_data["code_challenge_method"]
    ):
        raise HTTPException(400, "PKCE verification failed")

    workspace_slug = code_data.get("workspace_slug")

    return await _create_token_pair(
        code_data["user_id"], client_id, code_data["scope"], db,
        workspace_slug=workspace_slug,
    )


async def _handle_refresh(raw_refresh_token, client_id, db):
    if not raw_refresh_token:
        raise HTTPException(400, "Missing refresh_token")

    token_hash = hash_token(raw_refresh_token)
    result = await db.execute(
        select(OAuthRefreshToken).where(OAuthRefreshToken.token_hash == token_hash)
    )
    rt = result.scalar_one_or_none()

    if not rt or not rt.is_valid:
        raise HTTPException(400, "Invalid or expired refresh token")
    if client_id and rt.client_id != client_id:
        raise HTTPException(400, "client_id mismatch")

    rt.revoked_at = datetime.now(timezone.utc)
    old_at_result = await db.execute(
        select(OAuthAccessToken).where(OAuthAccessToken.id == rt.access_token_id)
    )
    old_access = old_at_result.scalar_one_or_none()
    workspace_slug = None
    if old_access:
        old_access.revoked_at = datetime.now(timezone.utc)
        workspace_slug = old_access.workspace_slug

    await db.commit()

    scope = old_access.scope if old_access else "taskpilot:read taskpilot:write"
    return await _create_token_pair(
        str(rt.user_id), rt.client_id, scope, db,
        workspace_slug=workspace_slug,
    )


async def _handle_client_credentials(client_id, client_secret, scope, db):
    if not all([client_id, client_secret]):
        raise HTTPException(400, "Missing client_id or client_secret")

    result = await db.execute(
        select(OAuthClient).where(
            OAuthClient.client_id == client_id, OAuthClient.is_active == True
        )
    )
    client = result.scalar_one_or_none()

    if not client or not client.client_secret_hash:
        raise HTTPException(401, "Invalid client credentials")
    if not verify_secret(client_secret, client.client_secret_hash):
        raise HTTPException(401, "Invalid client credentials")
    if not client.owner_id:
        raise HTTPException(400, "Client has no owner")

    use_scope = scope or client.scope or "taskpilot:read taskpilot:write"

    raw_at, at_hash = generate_access_token()
    access_token = OAuthAccessToken(
        token_hash=at_hash,
        user_id=client.owner_id,
        client_id=client_id,
        scope=use_scope,
        expires_at=datetime.now(timezone.utc)
        + timedelta(seconds=settings.mcp_access_token_ttl),
    )
    db.add(access_token)
    await db.commit()

    return TokenResponse(
        access_token=raw_at,
        expires_in=settings.mcp_access_token_ttl,
        scope=use_scope,
    )


async def _create_token_pair(
    user_id: str,
    client_id: str,
    scope: str,
    db: AsyncSession,
    workspace_slug: Optional[str] = None,
) -> TokenResponse:
    raw_at, at_hash = generate_access_token()
    raw_rt, rt_hash = generate_refresh_token()
    now = datetime.now(timezone.utc)

    access_token = OAuthAccessToken(
        token_hash=at_hash,
        user_id=user_id,
        client_id=client_id,
        scope=scope,
        workspace_slug=workspace_slug,
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


# ---------------------------------------------------------------------------
# Revoke
# ---------------------------------------------------------------------------


@router.post("/revoke")
async def revoke(
    token: str = Form(...),
    token_type_hint: Optional[str] = Form(default=None),
    db: AsyncSession = Depends(get_db),
):
    """RFC 7009 token revocation."""
    token_hash = hash_token(token)
    now = datetime.now(timezone.utc)

    result = await db.execute(
        select(OAuthAccessToken).where(OAuthAccessToken.token_hash == token_hash)
    )
    at = result.scalar_one_or_none()
    if at:
        at.revoked_at = now
        await db.commit()
        return {"status": "revoked"}

    result = await db.execute(
        select(OAuthRefreshToken).where(OAuthRefreshToken.token_hash == token_hash)
    )
    rt = result.scalar_one_or_none()
    if rt:
        rt.revoked_at = now
        await db.commit()
        return {"status": "revoked"}

    return {"status": "revoked"}
