"""TaskPilot MCP Server — FastAPI entry point with Streamable HTTP + SSE transport."""

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from app.config import settings
from app.mcp.jsonrpc import JSONRPCRequest
from app.mcp.server import handle_request
from app.oauth.auth import MCPAuthContext, get_current_user
from app.oauth.discovery import router as discovery_router
from app.oauth.endpoints import router as oauth_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# SSE session store
_sse_sessions: dict[str, asyncio.Queue] = {}


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
    expose_headers=["WWW-Authenticate", "Content-Type", "Authorization"],
)


# Middleware to ALWAYS add Access-Control-Expose-Headers (even without Origin)
from starlette.middleware.base import BaseHTTPMiddleware

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add CORS and security headers to ALL responses unconditionally (matching MeetEcho pattern)."""
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Expose-Headers"] = "WWW-Authenticate"
        return response

app.add_middleware(SecurityHeadersMiddleware)

# OAuth routes (at /oauth/* prefix)
app.include_router(discovery_router)
app.include_router(oauth_router)

# CRITICAL: Claude.ai web connector constructs /authorize, /token, /register
# from server root, ignoring metadata endpoints (confirmed bug #82).
# Include OAuth endpoints ALSO at root level (no prefix).
from app.oauth.endpoints import (
    authorize as _authorize_handler,
    register_client as _register_handler,
    token as _token_handler,
    revoke as _revoke_handler,
)
app.get("/authorize")(_authorize_handler)
app.post("/register")(_register_handler)
app.post("/token")(_token_handler)
app.post("/revoke")(_revoke_handler)


@app.get("/health")
async def health():
    return {"status": "ok", "server": "taskpilot-mcp"}


# ---------------------------------------------------------------------------
# Streamable HTTP transport — POST /mcp (primary)
# ---------------------------------------------------------------------------

@app.post("/mcp")
async def mcp_endpoint(
    request: JSONRPCRequest,
    auth: MCPAuthContext = Depends(get_current_user),
):
    """MCP JSON-RPC endpoint (Streamable HTTP transport)."""
    response = await handle_request(request, auth)
    return response.model_dump(exclude_none=True)


@app.get("/mcp")
async def mcp_get():
    """GET /mcp — Method Not Allowed (MCP only accepts POST)."""
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=405, content={"detail": "Method Not Allowed"})


# ---------------------------------------------------------------------------
# Root endpoints — Claude POSTs to / for Streamable HTTP
# ---------------------------------------------------------------------------

@app.post("/")
async def root_mcp_endpoint(
    request: JSONRPCRequest,
    auth: MCPAuthContext = Depends(get_current_user),
):
    """MCP JSON-RPC at root — Claude posts here."""
    response = await handle_request(request, auth)
    return response.model_dump(exclude_none=True)


@app.get("/")
async def root_get():
    """GET / — some clients probe root before POSTing."""
    return {"name": "taskpilot-mcp", "version": "1.0.0", "status": "ok"}


# ---------------------------------------------------------------------------
# SSE Transport (legacy, for LM Studio and other SSE clients)
# ---------------------------------------------------------------------------

async def _sse_event_generator(
    session_id: str, messages_url: str
) -> AsyncGenerator[str, None]:
    queue = _sse_sessions.get(session_id)
    if not queue:
        return
    yield f"event: endpoint\ndata: {messages_url}\n\n"
    try:
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=30.0)
                if message is None:
                    break
                yield f"event: message\ndata: {json.dumps(message)}\n\n"
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
    finally:
        _sse_sessions.pop(session_id, None)


@app.get("/sse")
async def sse_endpoint(
    request: Request,
    auth: MCPAuthContext = Depends(get_current_user),
):
    """SSE transport endpoint."""
    session_id = str(uuid.uuid4())
    _sse_sessions[session_id] = asyncio.Queue()
    base_url = str(request.base_url).rstrip("/")
    messages_url = f"{base_url}/messages?session_id={session_id}"
    return StreamingResponse(
        _sse_event_generator(session_id, messages_url),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/mcp/sse")
async def mcp_sse_endpoint(
    request: Request,
    auth: MCPAuthContext = Depends(get_current_user),
):
    """SSE transport at /mcp/sse."""
    session_id = str(uuid.uuid4())
    _sse_sessions[session_id] = asyncio.Queue()
    base_url = str(request.base_url).rstrip("/")
    messages_url = f"{base_url}/mcp/messages?session_id={session_id}"
    return StreamingResponse(
        _sse_event_generator(session_id, messages_url),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.post("/messages")
async def messages_endpoint(
    request: JSONRPCRequest,
    session_id: str,
    auth: MCPAuthContext = Depends(get_current_user),
):
    """Messages endpoint for SSE transport."""
    queue = _sse_sessions.get(session_id)
    if not queue:
        return {"error": "Session not found or expired"}
    response = await handle_request(request, auth)
    await queue.put(response.model_dump(exclude_none=True))
    return {"status": "accepted"}


@app.post("/mcp/messages")
async def mcp_messages_endpoint(
    request: JSONRPCRequest,
    session_id: str,
    auth: MCPAuthContext = Depends(get_current_user),
):
    """Messages endpoint for SSE transport at /mcp path."""
    queue = _sse_sessions.get(session_id)
    if not queue:
        return {"error": "Session not found or expired"}
    response = await handle_request(request, auth)
    await queue.put(response.model_dump(exclude_none=True))
    return {"status": "accepted"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=settings.mcp_port, reload=True)
