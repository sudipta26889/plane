import { describe, it, expect } from "vitest";
import { summarize } from "../health.js";

describe("summarize", () => {
  it("is ok only when every dependency is ok", () => {
    expect(
      summarize({
        database: { ok: true, detail: "reachable" },
        llm: { ok: true, detail: "reachable" },
      }),
    ).toBe("ok");
  });

  it("degrades on a single failure", () => {
    // The whole point: a working database must not mask a dead LLM, which is
    // how the stale endpoint went unnoticed.
    expect(
      summarize({
        database: { ok: true, detail: "reachable" },
        llm: { ok: false, detail: "fetch failed" },
      }),
    ).toBe("degraded");
  });

  it("treats an empty set as ok", () => {
    expect(summarize({})).toBe("ok");
  });
});
