import { describe, it, expect } from "vitest";
import { formatProjectsForPrompt, TASKPILOT_RULES } from "../context.js";

describe("formatProjectsForPrompt", () => {
  it("includes the identifier, name and full description of each project", () => {
    const text = formatProjectsForPrompt([
      {
        id: "p1",
        name: "Finance and Bills",
        identifier: "SUDIPTASCF",
        description: "all task related to finance will go here",
      },
    ]);

    expect(text).toContain("SUDIPTASCF");
    expect(text).toContain("Finance and Bills");
    // The description is the routing rule — it must reach the model intact.
    expect(text).toContain("all task related to finance will go here");
  });

  it("marks projects that have no description", () => {
    const text = formatProjectsForPrompt([
      { id: "p2", name: "RevatiCraft", identifier: "REVATICRAF", description: "" },
    ]);
    expect(text).toContain("(no description)");
  });
});

describe("TASKPILOT_RULES", () => {
  it("states the facts the agent gets wrong without them", () => {
    expect(TASKPILOT_RULES).toContain("no delete");
    expect(TASKPILOT_RULES).toContain("Intake");
    expect(TASKPILOT_RULES).not.toContain("Linear");
  });
});
