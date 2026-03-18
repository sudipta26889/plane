"""TaskPilot MCP Server — FastAPI entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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
