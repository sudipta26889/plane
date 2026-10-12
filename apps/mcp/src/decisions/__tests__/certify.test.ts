import { describe, it, expect } from "vitest";
import { errorUpperBound } from "../certify.js";

describe("errorUpperBound", () => {
  it("matches the rule of three for zero errors", () => {
    // 0/59 is the smallest clean sample that certifies <= 5% at 95%.
    expect(errorUpperBound(0, 59)).toBeLessThan(0.05);
    expect(errorUpperBound(0, 58)).toBeGreaterThan(0.05);
  });

  it("is far above the point estimate on small samples", () => {
    // The hard routing slice: 1 wrong in 43 is not "2% error".
    expect(errorUpperBound(1, 43)).toBeCloseTo(0.107, 2);
  });

  it("is 1 with nothing audited", () => {
    expect(errorUpperBound(0, 0)).toBe(1);
  });
});
