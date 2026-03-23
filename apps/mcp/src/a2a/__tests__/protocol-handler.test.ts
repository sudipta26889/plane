import { describe, it, expect } from "vitest";
import { validateJsonRpcRequest, A2A_METHODS } from "../protocol-handler.js";

describe("Protocol Handler", () => {
  it("validates a correct JSON-RPC request", () => {
    const result = validateJsonRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects missing jsonrpc field", () => {
    const result = validateJsonRpcRequest({ id: 1, method: "initialize" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("jsonrpc");
  });

  it("rejects wrong jsonrpc version", () => {
    const result = validateJsonRpcRequest({ jsonrpc: "1.0", id: 1, method: "test" });
    expect(result.valid).toBe(false);
  });

  it("rejects missing method", () => {
    const result = validateJsonRpcRequest({ jsonrpc: "2.0", id: 1 });
    expect(result.valid).toBe(false);
  });

  it("defines all A2A methods", () => {
    expect(A2A_METHODS).toContain("initialize");
    expect(A2A_METHODS).toContain("message.send");
    expect(A2A_METHODS).toContain("task.get");
    expect(A2A_METHODS).toContain("task.list");
    expect(A2A_METHODS).toContain("task.cancel");
    expect(A2A_METHODS).toContain("context.get");
  });
});
