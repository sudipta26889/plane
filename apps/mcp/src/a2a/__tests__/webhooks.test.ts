import { describe, it, expect } from "vitest";
import { signPayload, buildWebhookPayload, WEBHOOK_EVENTS, RETRY_BACKOFF } from "../webhooks.js";

describe("Webhooks", () => {
  it("signs payload with HMAC-SHA256", () => {
    const signature = signPayload('{"test":true}', "secret-key");
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("produces deterministic signatures", () => {
    const sig1 = signPayload('{"a":1}', "key");
    const sig2 = signPayload('{"a":1}', "key");
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different secrets", () => {
    const sig1 = signPayload('{"a":1}', "key1");
    const sig2 = signPayload('{"a":1}', "key2");
    expect(sig1).not.toBe(sig2);
  });

  it("builds webhook payload for task.completed event", () => {
    const payload = buildWebhookPayload("task.completed", {
      task_id: "t-1",
      context_id: "ctx-1",
      skill: "task.create",
      state: "completed",
      result: { id: "123" },
      created_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:00:00Z",
    });
    expect(payload.event).toBe("task.completed");
    expect(payload.task.id).toBe("t-1");
    expect(payload.task.state).toBe("completed");
    expect(payload.timestamp).toBeDefined();
  });

  it("defines all webhook events", () => {
    expect(WEBHOOK_EVENTS).toContain("task.created");
    expect(WEBHOOK_EVENTS).toContain("task.state_changed");
    expect(WEBHOOK_EVENTS).toContain("task.completed");
    expect(WEBHOOK_EVENTS).toContain("task.failed");
    expect(WEBHOOK_EVENTS).toContain("task.canceled");
    expect(WEBHOOK_EVENTS).toContain("task.rejected");
    expect(WEBHOOK_EVENTS).toContain("task.approval_required");
  });

  it("defines retry backoff intervals", () => {
    expect(RETRY_BACKOFF).toEqual([1000, 5000, 15000, 60000, 300000]);
  });
});
