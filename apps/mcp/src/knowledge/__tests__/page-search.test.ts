import { describe, it, expect } from "vitest";
import { toPageMatches } from "../page-search.js";

const hit = (score: number, payload: Record<string, any>) => ({ id: "x", score, payload });

describe("toPageMatches", () => {
  it("shapes hits into actionable matches", () => {
    const matches = toPageMatches(
      [hit(0.82, { page_id: "p1", project_id: "proj1", name: "Siddhartha", source: "meetecho" })],
      10,
    );
    expect(matches).toEqual([
      { page_id: "p1", project_id: "proj1", name: "Siddhartha", source: "meetecho", score: 0.82 },
    ]);
  });

  it("drops a hit with no page_id, since nothing can be done with it", () => {
    expect(toPageMatches([hit(0.99, { name: "orphan" })], 10)).toEqual([]);
  });

  it("respects the limit", () => {
    const hits = Array.from({ length: 20 }, (_, i) => hit(0.9 - i / 100, { page_id: `p${i}` }));
    expect(toPageMatches(hits, 5).length).toBe(5);
  });

  it("defaults a missing source to local rather than undefined", () => {
    expect(toPageMatches([hit(0.7, { page_id: "p1" })], 10)[0]!.source).toBe("local");
  });
});
