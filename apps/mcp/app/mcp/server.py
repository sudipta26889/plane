"""MCP JSON-RPC request handler."""

import logging
from typing import Any

from app.mcp.handlers import execute_tool
from app.mcp.jsonrpc import (
    JSONRPCRequest,
    JSONRPCResponse,
    internal_error,
    invalid_params,
    method_not_found,
    success_response,
)
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
            return success_response(
                request.id,
                {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": SERVER_INFO,
                    "capabilities": CAPABILITIES,
                },
            )
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
