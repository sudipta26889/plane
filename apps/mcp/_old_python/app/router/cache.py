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
