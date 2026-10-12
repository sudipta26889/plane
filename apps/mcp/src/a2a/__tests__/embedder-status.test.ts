import { describe, it, expect, vi } from "vitest";

/**
 * Regression 2026-09-30: the embedding proxy's /health answered 200 for a week
 * while every real embed failed (it could not start the model container), so
 * /health said embeddings "ok". The keepalive does a real embed; its outcome is
 * what /health must report.
 */
const { embedMock } = vi.hoisted(() => ({ embedMock: vi.fn() }));

vi.mock("../../config.js", () => ({ config: { embeddingModel: "test-embedder" } }));
vi.mock("../../db.js", () => ({ db: { query: async () => ({ rows: [] }) } }));
vi.mock("../../agent/loop.js", () => ({ runAgent: vi.fn() }));
vi.mock("../../agent/state.js", () => ({ clearRunState: vi.fn(), loadRunState: vi.fn(), saveRunState: vi.fn() }));
vi.mock("../audit-log.js", () => ({ logAuditEvent: async () => {} }));
vi.mock("../webhooks.js", () => ({ queueWebhookDeliveries: async () => {}, deliverWebhook: async () => ({ success: true }) }));
vi.mock("../sse.js", () => ({ sseManager: { notify: () => {} } }));
vi.mock("../dharahil.js", () => ({ interpretDecision: vi.fn(), applyRevisionInstructions: vi.fn() }));
vi.mock("../task-executor.js", () => ({ transitionState: vi.fn(), executeA2aTask: vi.fn(), settleAgentRun: vi.fn() }));
vi.mock("../../knowledge/index-sync.js", () => ({ syncWorkItems: vi.fn(), syncPages: vi.fn() }));
vi.mock("../../knowledge/embeddings.js", () => ({ embed: embedMock }));

import { keepEmbedderWarm, getEmbedderStatus } from "../background.js";

describe("getEmbedderStatus", () => {
  it("reports a failing real embed, then recovers on the next success", async () => {
    expect(getEmbedderStatus()).toEqual({ ok: true, detail: "starting" });

    embedMock.mockRejectedValueOnce(new Error("Embedding request failed (503): Failed to start bge-visualized-m3"));
    await keepEmbedderWarm();
    const failed = getEmbedderStatus();
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("Failed to start bge-visualized-m3");

    embedMock.mockResolvedValueOnce([0.1]);
    await keepEmbedderWarm();
    expect(getEmbedderStatus()).toEqual({ ok: true, detail: "last embed ok" });
  });
});
