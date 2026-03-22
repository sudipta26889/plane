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
