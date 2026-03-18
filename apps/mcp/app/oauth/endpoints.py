"""OAuth 2.1 authorization, token, and revocation endpoints."""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Form, HTTPException, Query
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

    result = await db.execute(
        select(OAuthClient).where(
            OAuthClient.client_id == client_id, OAuthClient.is_active == True
        )
    )
    client = result.scalar_one_or_none()
    if not client:
        raise HTTPException(400, "Unknown client_id")
    if redirect_uri not in (client.redirect_uris or []):
        raise HTTPException(400, "redirect_uri not registered for this client")

    if not client.owner_id:
        raise HTTPException(400, "Client has no owner — cannot auto-approve")

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
            }
        ),
    )

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

    return await _create_token_pair(
        code_data["user_id"], client_id, code_data["scope"], db
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
    if old_access:
        old_access.revoked_at = datetime.now(timezone.utc)

    await db.commit()

    scope = old_access.scope if old_access else "taskpilot:read taskpilot:write"
    return await _create_token_pair(str(rt.user_id), rt.client_id, scope, db)


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
    user_id: str, client_id: str, scope: str, db: AsyncSession
) -> TokenResponse:
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
