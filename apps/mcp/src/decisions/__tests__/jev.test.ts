import { describe, it, expect, vi, beforeEach } from "vitest";

const { queryMock, cfg } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  cfg: { decisionModel: "typesafe/jev-latest", decisionModelLive: [] as string[] },
}));

vi.mock("../../config.js", () => ({ config: cfg }));
vi.mock("../../db.js", () => ({ db: { query: queryMock } }));
vi.mock("../../tools/smart-router.js", () => ({
  getLlmConfig: async () => ({ apiKey: "k", baseUrl: "http://litellm.test/v1", model: "m" }),
}));

import { decide, askJev, JevUncertainError } from "../jev.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const recorded = () => queryMock.mock.calls.map((call) => call[1][4]);

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] });
  cfg.decisionModel = "typesafe/jev-latest";
  cfg.decisionModelLive = [];
  vi.unstubAllGlobals();
});

const same = (a: string, b: string) => a === b;

describe("decide", () => {
  it("never calls Jev when no decision model is configured", async () => {
    cfg.decisionModel = "";
    const jev = vi.fn();
    expect(await decide({ feature: "f", jev, fallback: async () => "llm", same })).toBe("llm");
    expect(jev).not.toHaveBeenCalled();
  });

  it("shadow: returns the existing decider's answer and records the disagreement", async () => {
    expect(await decide({ feature: "f", jev: async () => "jev", fallback: async () => "llm", same })).toBe("llm");
    await flush();
    expect(recorded()).toEqual(["disagree"]);
  });

  it("shadow: a failing Jev changes nothing", async () => {
    const result = await decide({ feature: "f", jev: async () => { throw new Error("down"); }, fallback: async () => "llm", same });
    expect(result).toBe("llm");
    await flush();
    expect(recorded()).toEqual(["error"]);
  });

  it("live: acts on a confident Jev answer", async () => {
    cfg.decisionModelLive = ["f"];
    const fallback = vi.fn(async () => "llm");
    expect(await decide({ feature: "f", jev: async () => "jev", fallback, same })).toBe("jev");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("live: hands an uncertain answer, or a failure, back to the existing decider", async () => {
    cfg.decisionModelLive = ["f"];
    const uncertain = async (): Promise<string> => { throw new JevUncertainError("spread"); };
    const broken = async (): Promise<string> => { throw new Error("500"); };
    expect(await decide({ feature: "f", jev: uncertain, fallback: async () => "llm", same })).toBe("llm");
    expect(await decide({ feature: "f", jev: broken, fallback: async () => "llm", same })).toBe("llm");
    await flush();
    expect(recorded()).toEqual(["escalated", "fallback"]);
  });
});

describe("askJev", () => {
  it("posts System One to LiteLLM's pass-through and fills a missing confidence", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { project: { type: "choice", choice: "p2", probabilities: { p1: 0.1, p2: 0.9 } } } }),
    });
    vi.stubGlobal("fetch", spy);

    const answers = await askJev({ work_item: "x", dropped: undefined }, {
      project: { type: "choice", instructions: "Which?", criteria: { p1: "One", p2: "Two" } },
    });

    expect(answers.project).toMatchObject({ choice: "p2", confidence: 0.9 });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("http://litellm.test/v1/systemone");
    expect(JSON.parse(init.body)).toEqual({
      model: "typesafe/jev-latest",
      state: { work_item: "x" },
      questions: { project: { type: "choice", instructions: "Which?", criteria: { p1: "One", p2: "Two" } } },
    });
  });
});
