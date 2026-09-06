import { describe, it, expect } from "vitest";
import { summarize, redactHealthReport } from "../health.js";

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

describe("redactHealthReport", () => {
  it("keeps the shape and the ok flags but drops the detail strings", () => {
    const redacted = redactHealthReport({
      status: "degraded",
      server: "taskpilot-mcp",
      dependencies: {
        llm: { ok: true, detail: "http://nuc.lan:4000 (gpt-oss-120b)" },
        qdrant: { ok: false, detail: "connect ECONNREFUSED 192.168.10.118:6333" },
      },
    });

    expect(redacted.status).toBe("degraded");
    expect(Object.keys(redacted.dependencies)).toEqual(["llm", "qdrant"]);
    expect(redacted.dependencies.llm).toEqual({ ok: true, detail: "ok" });
    expect(redacted.dependencies.qdrant).toEqual({ ok: false, detail: "unavailable" });
  });

  it("leaks no internal host, model or address", () => {
    const serialised = JSON.stringify(
      redactHealthReport({
        status: "degraded",
        server: "taskpilot-mcp",
        dependencies: { qdrant: { ok: false, detail: "ECONNREFUSED 192.168.10.118:6333" } },
      }),
    );
    expect(serialised).not.toContain("192.168");
    expect(serialised).not.toContain("nuc.lan");
  });
});
