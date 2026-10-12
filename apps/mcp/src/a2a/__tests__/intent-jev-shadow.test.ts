import { describe, it, expect, vi, beforeEach } from "vitest";

const { cfg, createMock, queryMock } = vi.hoisted(() => ({
  cfg: { decisionModel: "typesafe/jev-latest", decisionModelLive: [] as string[], routeConfidenceThreshold: 0.7 },
  createMock: vi.fn(),
  queryMock: vi.fn(async () => ({ rows: [] })),
}));

vi.mock("../../config.js", () => ({ config: cfg }));
vi.mock("../../db.js", () => ({ db: { query: queryMock } }));
vi.mock("../../tools/smart-router.js", () => ({
  getLlmConfig: async () => ({ apiKey: "k", baseUrl: "http://llm.test", model: "m" }),
  defuseMessages: (messages: any[]) => messages,
}));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: createMock } }; } }));

import { resolveIntent } from "../intent.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  queryMock.mockClear();
  createMock.mockReset().mockResolvedValue({
    choices: [{ message: { content: '{"skill":"task.create","input":{"title":"Renew domain"},"confidence":0.9,"reason":"r"}' } }],
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ model: "jev-1.13.0", answers: { skill: { type: "choice", choice: "task.find", confidence: 0.95, probabilities: {} } } }) })));
});

describe("resolveIntent with Jev in shadow", () => {
  it("acts on the LLM's skill and input, and only logs Jev's pick beside it", async () => {
    const intent = await resolveIntent("add a task to renew the domain");
    expect(intent).toMatchObject({ skill: "task.create", input: { title: "Renew domain" } });
    await flush();
    const [, params] = queryMock.mock.calls.find((call: any) => String(call[0]).includes("decision_model_runs")) as any;
    expect(params[0]).toBe("intent");
    expect(params[4]).toBe("disagree");
  });

  it("never lets Jev act alone, even if intent is listed live: it cannot write arguments", async () => {
    cfg.decisionModelLive = ["intent"];
    try {
      expect(await resolveIntent("add a task to renew the domain")).toMatchObject({ skill: "task.create", input: { title: "Renew domain" } });
    } finally {
      cfg.decisionModelLive = [];
    }
  });
});
