import { describe, it, expect } from "vitest";
import {
  getSkillDefinition,
  getAllSkills,
  getWriteTools,
  isExternalPeer,
  requiresHumanApproval,
  isCriticalAction,
  requiresApproval,
} from "../skill-registry.js";

describe("Skill Registry", () => {
  it("maps all 30 A2A skills to MCP tools", () => {
    const skills = getAllSkills();
    expect(skills.length).toBe(30);
  });

  it("resolves task.create to create_task", () => {
    const skill = getSkillDefinition("task.create");
    expect(skill).toBeDefined();
    expect(skill!.mcpTool).toBe("create_task");
    expect(skill!.scope).toBe("taskpilot:write");
    expect(skill!.approval).toBe(false);
  });

  it("resolves project.list to list_projects", () => {
    const skill = getSkillDefinition("project.list");
    expect(skill).toBeDefined();
    expect(skill!.mcpTool).toBe("list_projects");
    expect(skill!.scope).toBe("taskpilot:read");
  });

  it("returns undefined for unknown skills", () => {
    expect(getSkillDefinition("nonexistent")).toBeUndefined();
  });

  it("resolves callnote.upsert to callnote_upsert as a write skill", () => {
    const skill = getSkillDefinition("callnote.upsert");
    expect(skill).toBeDefined();
    expect(skill!.mcpTool).toBe("callnote_upsert");
    expect(skill!.scope).toBe("taskpilot:write");
  });

  it("resolves callnote.lookup to callnote_lookup as a read skill", () => {
    const skill = getSkillDefinition("callnote.lookup");
    expect(skill).toBeDefined();
    expect(skill!.mcpTool).toBe("callnote_lookup");
    expect(skill!.scope).toBe("taskpilot:read");
  });

  it("identifies task.move to Cancelled as critical", () => {
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "Cancelled" })).toBe(true);
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "cancelled" })).toBe(true);
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "In Progress" })).toBe(false);
    expect(isCriticalAction("create_task", { title: "test" })).toBe(false);
  });

  it("requiresApproval detects conditional skills", () => {
    expect(requiresApproval("task.move", { identifier: "X-1", state: "Cancelled" })).toBe(true);
    expect(requiresApproval("task.move", { identifier: "X-1", state: "Done" })).toBe(false);
    expect(requiresApproval("task.create", { title: "test" })).toBe(false);
    expect(requiresApproval("nonexistent", {})).toBe(false);
  });
});

describe("isCriticalAction covers destructive page operations", () => {
  it("treats archiving a page as critical", () => {
    // page.archive is approval:true for A2A, but MCP clients call the tool
    // directly and only isCriticalAction gates that path.
    expect(isCriticalAction("page_archive", {})).toBe(true);
  });

  it("leaves non-destructive page tools alone", () => {
    expect(isCriticalAction("page_update", {})).toBe(false);
    expect(isCriticalAction("page_create", {})).toBe(false);
  });
});

describe("intake rejection is gated, acceptance is not", () => {
  it("treats rejecting an intake item as critical", () => {
    // Rejecting discards work that was captured because the router could not
    // place it; accepting merely files it where it already sits.
    expect(isCriticalAction("intake_triage", { decision: "reject" })).toBe(true);
  });

  it("leaves acceptance ungated", () => {
    expect(isCriticalAction("intake_triage", { decision: "accept" })).toBe(false);
  });

  it("requires approval only for the reject decision", () => {
    expect(requiresApproval("intake.triage", { decision: "reject" })).toBe(true);
    expect(requiresApproval("intake.triage", { decision: "accept" })).toBe(false);
  });
});

describe("the two approval gates cannot disagree", () => {
  it("every skill isCriticalAction gates is also gated on the A2A path", () => {
    // executeToolCall now trusts the A2A path's own approval and skips its own.
    // That is only safe while requiresApproval (A2A) fires wherever
    // isCriticalAction (MCP) does. If a future tool is added to
    // isCriticalAction without an approval flag in the registry, the A2A path
    // would execute it with no human gate at all — this test fails first.
    const probes = [
      { skill: "task.move", args: { state: "Cancelled" } },
      { skill: "task.bulk_cancel", args: {} },
      { skill: "page.archive", args: {} },
      { skill: "intake.triage", args: { decision: "reject" } },
    ];

    for (const probe of probes) {
      const definition = getSkillDefinition(probe.skill)!;
      expect(definition, `${probe.skill} is not registered`).toBeDefined();
      expect(
        isCriticalAction(definition.mcpTool, probe.args),
        `${definition.mcpTool} is critical on the MCP path`,
      ).toBe(true);
      expect(
        requiresApproval(probe.skill, probe.args),
        `${probe.skill} must also be gated on the A2A path`,
      ).toBe(true);
    }
  });

  it("every registry skill marked for approval is critical on the MCP path too", () => {
    for (const skill of getAllSkills()) {
      if (skill.approval !== true) continue;
      expect(
        isCriticalAction(skill.mcpTool, {}),
        `${skill.mcpTool} is approval:true but isCriticalAction ignores it, so MCP clients bypass the human gate`,
      ).toBe(true);
    }
  });
});

describe("write-safety policy", () => {
  const OWNER = "mcp_Xuj887b3OxafyM9stKhQSA";
  const PEER = "peer_mitra";

  it("derives the write set from the registry, so a new write skill cannot ship ungated", () => {
    const derived = getWriteTools();
    const declared = getAllSkills().filter((s) => s.scope === "taskpilot:write");
    expect(derived.size).toBe(declared.length);
    for (const skill of declared) {
      expect(derived.has(skill.mcpTool), `${skill.mcpTool} missing from the write set`).toBe(true);
    }
    // And nothing read-scoped leaked in.
    for (const skill of getAllSkills().filter((s) => s.scope === "taskpilot:read")) {
      expect(derived.has(skill.mcpTool), `${skill.mcpTool} is read-only but in the write set`).toBe(false);
    }
  });

  it("recognises a peer credential and does not mistake an owner session for one", () => {
    expect(isExternalPeer(PEER)).toBe(true);
    expect(isExternalPeer("peer_mitra-meetecho")).toBe(true);
    expect(isExternalPeer(OWNER)).toBe(false);
    expect(isExternalPeer("")).toBe(false);
  });

  it("gates every write by an external peer, including harmless ones", () => {
    // A peer holding a token is not the account owner.
    expect(requiresHumanApproval("create_task", { title: "x" }, PEER)).toBe(true);
    expect(requiresHumanApproval("add_comment", {}, PEER)).toBe(true);
    expect(requiresHumanApproval("page_create", {}, PEER)).toBe(true);
  });

  it("leaves the owner's ordinary writes ungated, so routine filing stays frictionless", () => {
    expect(requiresHumanApproval("create_task", { title: "x" }, OWNER)).toBe(false);
    expect(requiresHumanApproval("add_comment", {}, OWNER)).toBe(false);
  });

  it("gates destructive actions for the owner too", () => {
    expect(requiresHumanApproval("bulk_cancel_tasks", {}, OWNER)).toBe(true);
    expect(requiresHumanApproval("page_archive", {}, OWNER)).toBe(true);
    expect(requiresHumanApproval("move_task", { state: "Cancelled" }, OWNER)).toBe(true);
    expect(requiresHumanApproval("intake_triage", { decision: "reject" }, OWNER)).toBe(true);
  });

  it("never gates a read, for either caller", () => {
    for (const id of [OWNER, PEER]) {
      expect(requiresHumanApproval("list_projects", {}, id)).toBe(false);
      expect(requiresHumanApproval("page_list", {}, id)).toBe(false);
      expect(requiresHumanApproval("find_tasks", {}, id)).toBe(false);
    }
  });

  it("routes a peer's write through the A2A approval gate as well", () => {
    // Both paths must agree; the MCP path is covered above.
    expect(requiresApproval("task.create", { title: "x" }, PEER)).toBe(true);
    expect(requiresApproval("task.create", { title: "x" }, OWNER)).toBe(false);
  });
});
