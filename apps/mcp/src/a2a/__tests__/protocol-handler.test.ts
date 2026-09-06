import { describe, it, expect } from "vitest";
import {
  validateJsonRpcRequest,
  canonicalMethod,
  normalizeMessageParams,
  A2A_METHODS,
} from "../protocol-handler.js";

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

  it("accepts spec-form method names as aliases", () => {
    expect(canonicalMethod("message/send")).toBe("message.send");
    expect(canonicalMethod("tasks/get")).toBe("task.get");
    expect(canonicalMethod("tasks/list")).toBe("task.list");
    expect(canonicalMethod("tasks/cancel")).toBe("task.cancel");
    expect(canonicalMethod("context/get")).toBe("context.get");
  });

  it("leaves dot-form and unknown methods alone", () => {
    expect(canonicalMethod("message.send")).toBe("message.send");
    expect(canonicalMethod("initialize")).toBe("initialize");
    expect(canonicalMethod("message/stream")).toBe("message/stream");
  });

  it("canonicalises the method on the validated body", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "message/send" };
    expect(validateJsonRpcRequest(body).valid).toBe(true);
    // Routing, rate limiting and dispatch all compare against the dot form.
    expect(body.method).toBe("message.send");
  });

  it("reads skill and input out of spec-form Message params", () => {
    const normalized = normalizeMessageParams({
      message: {
        kind: "message",
        messageId: "msg-1",
        contextId: "ctx-1",
        parts: [
          { kind: "text", text: "please create a task" },
          { kind: "data", data: { skill: "task.create", input: { title: "Fix login" } } },
        ],
      },
    });
    expect(normalized.contextId).toBe("ctx-1");
    expect(normalized.skill).toBe("task.create");
    expect(normalized.input).toEqual({ title: "Fix login" });
    expect(normalized.idempotencyKey).toBe("msg-1");
  });

  it("passes flat params through untouched", () => {
    const flat = { contextId: "ctx-1", skill: "task.get", input: { identifier: "WEB-1" } };
    expect(normalizeMessageParams(flat)).toBe(flat);
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
