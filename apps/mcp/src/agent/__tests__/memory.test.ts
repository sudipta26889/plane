import { describe, it, expect } from "vitest";
import {
  formatMemoryForPrompt,
  MAX_FACTS_IN_PROMPT,
  MAX_PROMPT_CHARS,
  type StoredFact,
} from "../memory.js";

function fact(overrides: Partial<StoredFact> = {}): StoredFact {
  return {
    id: 1,
    fact: "Prefers dark mode",
    source: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("formatMemoryForPrompt", () => {
  it("returns an empty string when there are no facts", () => {
    expect(formatMemoryForPrompt([])).toBe("");
  });

  it("renders each fact as its own line", () => {
    const facts = [
      fact({ id: 1, fact: "Likes concise replies" }),
      fact({ id: 2, fact: "Works in the design workspace" }),
    ];
    const result = formatMemoryForPrompt(facts);
    expect(result).toContain("Likes concise replies");
    expect(result).toContain("Works in the design workspace");
  });

  it("caps the number of rendered facts even when each is short", () => {
    const facts = Array.from({ length: MAX_FACTS_IN_PROMPT + 30 }, (_, i) =>
      fact({ id: i, fact: `f${i}` }),
    );
    const result = formatMemoryForPrompt(facts);
    const lines = result.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(MAX_FACTS_IN_PROMPT);
  });

  it("caps total rendered length even with few, long facts", () => {
    const longFact = "x".repeat(500);
    const facts = Array.from({ length: 10 }, () => fact({ fact: longFact }));
    const result = formatMemoryForPrompt(facts);
    expect(result.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("is pure: calling it twice with the same input gives the same output", () => {
    const facts = [fact({ fact: "Same input" })];
    expect(formatMemoryForPrompt(facts)).toBe(formatMemoryForPrompt(facts));
  });
});
