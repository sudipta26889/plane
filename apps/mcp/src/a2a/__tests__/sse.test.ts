import { describe, it, expect } from "vitest";
import { formatSseEvent, SSE_MAX_CONNECTION_MS, SSE_PING_INTERVAL_MS } from "../sse.js";

describe("SSE", () => {
  it("formats SSE event correctly", () => {
    const result = formatSseEvent("task.completed", { taskId: "t-1", state: "completed" });
    expect(result).toBe('event: task.completed\ndata: {"taskId":"t-1","state":"completed"}\n\n');
  });

  it("formats ping event", () => {
    const result = formatSseEvent("ping", { timestamp: "2026-01-01T00:00:00Z" });
    expect(result).toContain("event: ping");
    expect(result).toContain("2026-01-01T00:00:00Z");
  });

  it("has 5-minute max connection", () => {
    expect(SSE_MAX_CONNECTION_MS).toBe(5 * 60 * 1000);
  });

  it("has 15-second ping interval", () => {
    expect(SSE_PING_INTERVAL_MS).toBe(15 * 1000);
  });
});
