import { describe, it, expect } from "vitest";
import { buildIndexText, contentHash } from "../index-sync.js";

describe("buildIndexText", () => {
  it("joins the title and description", () => {
    const text = buildIndexText({ name: "Fix login", description_stripped: "SSO is broken" });
    expect(text).toBe("Fix login\n\nSSO is broken");
  });

  it("tolerates a missing description", () => {
    // 5 of 439 work items have no description text.
    expect(buildIndexText({ name: "Fix login", description_stripped: null })).toBe("Fix login");
  });

  it("truncates very long descriptions to keep embedding latency bounded", () => {
    const text = buildIndexText({ name: "T", description_stripped: "x".repeat(10_000) });
    expect(text.length).toBeLessThanOrEqual(4096);
  });
});

describe("contentHash", () => {
  it("is stable for the same text", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("differs when the text changes", () => {
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});
