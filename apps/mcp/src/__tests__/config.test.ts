import { describe, it, expect } from "vitest";
import { parseIntakeProjects } from "../config.js";

describe("parseIntakeProjects", () => {
  it("parses workspace:identifier pairs", () => {
    const map = parseIntakeProjects("for-ai:SUDIPTASCF,sss-global-apex:REVATICRAF");
    expect(map.get("for-ai")).toBe("SUDIPTASCF");
    expect(map.get("sss-global-apex")).toBe("REVATICRAF");
  });

  it("returns an empty map for empty or malformed input", () => {
    expect(parseIntakeProjects("").size).toBe(0);
    expect(parseIntakeProjects(undefined).size).toBe(0);
    // A pair with no colon is skipped rather than throwing — a bad env var
    // must not stop the server from booting.
    expect(parseIntakeProjects("garbage,for-ai:SUDIPTASCF").size).toBe(1);
  });

  it("trims whitespace around pairs", () => {
    const map = parseIntakeProjects(" for-ai : SUDIPTASCF ");
    expect(map.get("for-ai")).toBe("SUDIPTASCF");
  });
});
