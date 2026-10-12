import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Two-stage dedupe with Jev live: similarity recalls candidates, Jev judges.
 * The cases are the real failures that motivated it — next quarter's GST
 * filing scored 0.971 against this quarter's and was blocked as a duplicate.
 */
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../config.js", () => ({
  config: {
    qdrantUrl: "http://qdrant.test",
    qdrantApiKey: "k",
    qdrantCollection: "c",
    embeddingModel: "test-embedder",
    embeddingDims: 3,
    dedupeSimilarityThreshold: 0.945,
    decisionModel: "typesafe/jev-latest",
    decisionModelLive: ["dedupe"],
  },
}));
vi.mock("../../db.js", () => ({ db: { query: queryMock } }));
vi.mock("../../tools/smart-router.js", () => ({
  getLlmConfig: async () => ({ apiKey: "k", baseUrl: "http://litellm.test", model: "m" }),
}));

import { findDuplicate } from "../dedupe.js";

const hit = (id: string, score: number) => ({ id, score, payload: { issue_id: id, identifier: `FIN-${id}` } });

function stubNetwork(hits: unknown[], jev: Record<string, number> | "fail") {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    calls.push(url);
    const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body, text: async () => "" });
    if (url.endsWith("/points/search")) return json({ result: hits });
    if (url.endsWith("/systemone")) {
      if (jev === "fail") return json({}, false);
      const asked = Object.keys(JSON.parse(init.body).questions);
      return json({ model: "jev-1.13.0", answers: Object.fromEntries(asked.map((id) => [id, { type: "noul", noul: jev[id] ?? 0 }])) });
    }
    throw new Error(`unexpected ${url}`);
  }));
  return calls;
}

beforeEach(() => {
  queryMock.mockReset().mockImplementation(async (sql: string, params: any[]) =>
    sql.startsWith("SELECT id::text, name")
      ? { rows: params[0].map((id: string) => ({ id, name: `item ${id}`, description_stripped: "" })) }
      : { rows: [] });
});
afterEach(() => vi.unstubAllGlobals());

const opts = { projectIds: ["p1"], vector: [0.1, 0.2, 0.3] };

describe("findDuplicate with Jev judging", () => {
  it("does not block a look-alike Jev says is different work, however similar", async () => {
    stubNetwork([hit("q2", 0.971)], { duplicate_0: 0.08 });
    expect(await findDuplicate("GSTR-1 Jul-Sep 2026", opts)).toBeNull();
  });

  it("returns the candidate Jev judges the same work, with its probability", async () => {
    stubNetwork([hit("a", 0.95), hit("b", 0.93)], { duplicate_0: 0.2, duplicate_1: 0.81 });
    expect(await findDuplicate("restore prod", opts)).toEqual({ issueId: "b", identifier: "FIN-b", score: 0.93, probability: 0.81 });
  });

  it("never asks Jev when nothing clears the recall floor", async () => {
    const calls = stubNetwork([hit("a", 0.89)], {});
    expect(await findDuplicate("something new", opts)).toBeNull();
    expect(calls.some((url) => url.endsWith("/systemone"))).toBe(false);
  });

  it("falls back to the similarity threshold when Jev fails", async () => {
    stubNetwork([hit("a", 0.96)], "fail");
    expect(await findDuplicate("restore prod", opts)).toEqual({ issueId: "a", identifier: "FIN-a", score: 0.96 });
  });

  it("excludes cancelled items from the candidates", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/points/search")) body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ result: [] }), text: async () => "" };
    }));
    await findDuplicate("x", opts);
    expect(body.filter.must_not).toContainEqual({ key: "state_group", match: { value: "cancelled" } });
  });
});
