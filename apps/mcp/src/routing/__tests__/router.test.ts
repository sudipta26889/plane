import { describe, it, expect } from "vitest";
import {
  scoreNeighbours,
  matchHint,
  decideFromNeighbours,
  countHitsByProject,
} from "../router.js";

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

describe("decideFromNeighbours", () => {
  const THRESHOLD = 0.7;

  it("returns null when the winner has only one hit, even if another project also has one", () => {
    // Corroboration is per-project: the winner having one hit is not fixed
    // by some *other* project also having a hit.
    const scores = new Map([
      ["p1", 0.95],
      ["p2", 0.05],
    ]);
    const hitsByProject = new Map([
      ["p1", 1],
      ["p2", 1],
    ]);
    expect(decideFromNeighbours(scores, THRESHOLD, hitsByProject)).toBeNull();
  });

  it("returns the project with a dominant share when the winner has two hits", () => {
    const scores = new Map([
      ["p1", 1.2],
      ["p2", 0.3],
    ]);
    const hitsByProject = new Map([
      ["p1", 2],
      ["p2", 1],
    ]);
    // share = 1.2 / 1.5 = 0.8
    const decision = decideFromNeighbours(scores, THRESHOLD, hitsByProject);
    expect(decision?.projectId).toBe("p1");
    expect(decision?.confidence).toBeCloseTo(0.8);
  });

  it("caps confidence at 1 when a negative score would otherwise inflate the share", () => {
    // Cosine similarity ranges over [-1, 1]. A negative score is evidence
    // against p2, not weak evidence for it, so it must not shrink the
    // denominator: naively summing raw scores gives total = 0.7 and
    // share = 1.2 / 0.7 ≈ 1.71, which must never be returned.
    const scores = new Map([
      ["p1", 1.2],
      ["p2", -0.5],
    ]);
    const hitsByProject = new Map([
      ["p1", 2],
      ["p2", 1],
    ]);
    const decision = decideFromNeighbours(scores, THRESHOLD, hitsByProject);
    expect(decision?.projectId).toBe("p1");
    expect(decision?.confidence).toBeLessThanOrEqual(1);
    expect(decision?.confidence).toBeCloseTo(1);
  });

  it("returns null when the winner clears the floor but not the dominance threshold", () => {
    // The only case that actually reaches the share gate: corroborated (2 hits)
    // and above the similarity floor (1.2/2 = 0.6), but 1.2/2.1 = 0.571 is not
    // dominant enough. The evenly-split test below is stopped by the floor gate
    // first, so without this case the share check has no regression cover.
    const scores = new Map([
      ["p1", 1.2],
      ["p2", 0.9],
    ]);
    const hitsByProject = new Map([
      ["p1", 2],
      ["p2", 1],
    ]);
    expect(decideFromNeighbours(scores, THRESHOLD, hitsByProject)).toBeNull();
  });

  it("returns null when the evidence is split evenly below threshold", () => {
    const scores = new Map([
      ["p1", 0.5],
      ["p2", 0.5],
    ]);
    const hitsByProject = new Map([
      ["p1", 2],
      ["p2", 2],
    ]);
    expect(decideFromNeighbours(scores, THRESHOLD, hitsByProject)).toBeNull();
  });

  it("returns null for a zero total score instead of NaN", () => {
    const scores = new Map([
      ["p1", 0],
      ["p2", 0],
    ]);
    const hitsByProject = new Map([
      ["p1", 2],
      ["p2", 2],
    ]);
    expect(decideFromNeighbours(scores, THRESHOLD, hitsByProject)).toBeNull();
  });

  it("returns null for an empty map", () => {
    expect(decideFromNeighbours(new Map(), THRESHOLD, new Map())).toBeNull();
  });

  it("returns null for uncontested but weak evidence (two hits at cosine 0.05, no rival project)", () => {
    // The finding this guards against: with no other project to dilute it,
    // share alone would come out to 1.0 for what is effectively noise.
    const scores = new Map([["p1", 0.1]]);
    const hitsByProject = new Map([["p1", 2]]);
    expect(decideFromNeighbours(scores, THRESHOLD, hitsByProject)).toBeNull();
  });

  it("returns the project when the winner's average score per hit clears the similarity floor", () => {
    const scores = new Map([["p1", 1.4]]);
    const hitsByProject = new Map([["p1", 2]]);
    // avg = 1.4 / 2 = 0.7, above the 0.55 floor; share = 1.4 / 1.4 = 1.
    const decision = decideFromNeighbours(scores, THRESHOLD, hitsByProject);
    expect(decision?.projectId).toBe("p1");
    expect(decision?.confidence).toBeCloseTo(1);
  });

  it("returns null when the winner's average score per hit sits just below the similarity floor", () => {
    const scores = new Map([["p1", 1.0]]);
    const hitsByProject = new Map([["p1", 2]]);
    // avg = 1.0 / 2 = 0.5, below the 0.55 floor.
    expect(decideFromNeighbours(scores, THRESHOLD, hitsByProject)).toBeNull();
  });

  it("accepts a share exactly equal to the threshold, since the code checks '<' not '<='", () => {
    const scores = new Map([
      ["p1", 1.4],
      ["p2", 0.6],
    ]);
    const hitsByProject = new Map([
      ["p1", 2],
      ["p2", 1],
    ]);
    // avg = 1.4 / 2 = 0.7, clears the floor; share = 1.4 / 2.0 = 0.7 == THRESHOLD.
    const decision = decideFromNeighbours(scores, THRESHOLD, hitsByProject);
    expect(decision?.projectId).toBe("p1");
    expect(decision?.confidence).toBeCloseTo(0.7);
  });

  it("returns null for all-negative scores via the zero-total guard, with no NaN", () => {
    const scores = new Map([
      ["p1", -0.5],
      ["p2", -0.3],
    ]);
    const hitsByProject = new Map([
      ["p1", 2],
      ["p2", 2],
    ]);
    expect(decideFromNeighbours(scores, THRESHOLD, hitsByProject)).toBeNull();
  });

  it("reaches share = 1 when a single project holds all the similarity mass", () => {
    const scores = new Map([["p1", 1.2]]);
    const hitsByProject = new Map([["p1", 2]]);
    // avg = 1.2 / 2 = 0.6, clears the floor; share = 1.2 / 1.2 = 1.
    const decision = decideFromNeighbours(scores, THRESHOLD, hitsByProject);
    expect(decision?.projectId).toBe("p1");
    expect(decision?.confidence).toBeCloseTo(1);
  });
});

describe("countHitsByProject", () => {
  it("counts hits per project", () => {
    const counts = countHitsByProject([
      { id: "a", score: 0.9, payload: { project_id: "p1" } },
      { id: "b", score: 0.8, payload: { project_id: "p1" } },
      { id: "c", score: 0.5, payload: { project_id: "p2" } },
    ]);

    expect(counts.get("p1")).toBe(2);
    expect(counts.get("p2")).toBe(1);
  });

  it("ignores hits with no project payload", () => {
    const counts = countHitsByProject([{ id: "a", score: 0.9, payload: {} }]);
    expect(counts.size).toBe(0);
  });

  it("returns an empty map for no hits", () => {
    expect(countHitsByProject([]).size).toBe(0);
  });
});
