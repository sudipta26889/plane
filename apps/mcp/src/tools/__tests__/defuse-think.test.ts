import { describe, it, expect, vi } from "vitest";

vi.mock("../../db.js", () => ({ db: { query: vi.fn() } }));

import { defuseThinkToggles, defuseMessages } from "../smart-router.js";

describe("defuseThinkToggles", () => {
  it("makes /think and /no_think inert anywhere, including inside words and URLs", () => {
    // Ollama's nemotron renderer would read these as reasoning switches and
    // silently delete them from the prompt.
    const out = defuseThinkToggles("see https://x.dev/thinking-tools then /no_think and /THINK");
    expect(out).not.toMatch(/\/(no_)?think/i);
    expect(out.replace(/​/g, "")).toBe("see https://x.dev/thinking-tools then /no_think and /THINK");
  });

  it("copies messages and leaves non-string content alone", () => {
    const original = [{ role: "user", content: "/think" }, { role: "assistant", content: null }];
    const out = defuseMessages(original);
    expect(out[0]!.content).toBe("/​think");
    expect(out[1]!.content).toBeNull();
    expect(original[0]!.content).toBe("/think");
  });
});
