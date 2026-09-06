import { describe, it, expect } from "vitest";
import { buildIntentMenu, parseIntentResponse } from "../intent.js";
import { getAllSkills } from "../skill-registry.js";

const VALID = new Set(getAllSkills().map((skill) => skill.name));

describe("buildIntentMenu", () => {
  it("lists every registered skill", () => {
    const menu = buildIntentMenu();
    for (const skill of getAllSkills()) {
      expect(menu).toContain(skill.name);
    }
  });

  it("carries each skill's input schema so the model can fill required fields", () => {
    const menu = buildIntentMenu();
    // Without the schema the model cannot know task.create needs a title.
    expect(menu).toContain("input schema:");
    expect(menu).toContain("\"title\"");
  });
});

describe("parseIntentResponse", () => {
  it("parses a well-formed reply", () => {
    const intent = parseIntentResponse(
      '{"skill":"task.create","input":{"title":"Renew domain"},"confidence":0.9,"reason":"asks to add work"}',
      VALID,
    );
    expect(intent).toEqual({
      skill: "task.create",
      input: { title: "Renew domain" },
      confidence: 0.9,
      reason: "asks to add work",
    });
  });

  it("tolerates a fenced code block", () => {
    const intent = parseIntentResponse(
      '```json\n{"skill":"task.find","input":{"query":"invoices"},"confidence":0.8,"reason":"a question"}\n```',
      VALID,
    );
    expect(intent?.skill).toBe("task.find");
  });

  it("rejects a skill that is not registered", () => {
    // A hallucinated skill would dispatch to nothing; refuse instead.
    expect(
      parseIntentResponse('{"skill":"task.delete","input":{},"confidence":0.99}', VALID),
    ).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseIntentResponse("I think you want to create a task", VALID)).toBeNull();
  });

  it("rejects a non-object input", () => {
    expect(
      parseIntentResponse('{"skill":"task.create","input":"a title","confidence":0.9}', VALID),
    ).toBeNull();
  });

  it("defaults a missing input to an empty object and a missing confidence to zero", () => {
    const intent = parseIntentResponse('{"skill":"project.list"}', VALID);
    expect(intent?.input).toEqual({});
    // Zero confidence is below any threshold, so this refuses downstream.
    expect(intent?.confidence).toBe(0);
  });
});
