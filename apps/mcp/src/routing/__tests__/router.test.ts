import { describe, it, expect } from "vitest";
import { scoreNeighbours, matchHint } from "../router.js";

const PROJECTS = [
  { id: "p1", name: "Finance and Bills", identifier: "SUDIPTASCF", description: "finance" },
  { id: "p2", name: "ProDevs", identifier: "PRODEVS", description: "developer platform" },
];

describe("matchHint", () => {
  it("matches on the exact identifier, case-insensitively", () => {
    expect(matchHint("sudiptascf", PROJECTS)?.id).toBe("p1");
  });

  it("matches on the project name", () => {
    expect(matchHint("ProDevs", PROJECTS)?.id).toBe("p2");
  });

  it("returns null when nothing matches, rather than a near-miss", () => {
    // A wrong hint must not silently route somewhere plausible.
    expect(matchHint("Marketing", PROJECTS)).toBeNull();
  });
});

describe("scoreNeighbours", () => {
  it("weights each project by the summed similarity of its neighbours", () => {
    const scores = scoreNeighbours([
      { id: "a", score: 0.9, payload: { project_id: "p1" } },
      { id: "b", score: 0.8, payload: { project_id: "p1" } },
      { id: "c", score: 0.5, payload: { project_id: "p2" } },
    ]);

    expect(scores.get("p1")).toBeCloseTo(1.7);
    expect(scores.get("p2")).toBeCloseTo(0.5);
  });

  it("ignores hits with no project payload", () => {
    const scores = scoreNeighbours([{ id: "a", score: 0.9, payload: {} }]);
    expect(scores.size).toBe(0);
  });

  it("returns an empty map for no hits", () => {
    expect(scoreNeighbours([]).size).toBe(0);
  });
});
