import { describe, it, expect } from "vitest";
import { buildAgentCard, buildLlmsTxt } from "../agent-card.js";
import { getAllSkills } from "../skill-registry.js";

describe("Agent Card", () => {
  it("builds valid agent card JSON", () => {
    const card = buildAgentCard("https://mcp.taskpilot.sudiptadhara.in");
    expect(card.name).toBe("TaskPilot");
    expect(card.protocol).toBe("a2a");
    expect(card.protocolVersion).toBe("0.3");
    expect(card.url).toBe("https://mcp.taskpilot.sudiptadhara.in/a2a");
    expect(card.skills.length).toBe(31);
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.webhooks).toBe(true);
    expect(card.capabilities.humanInTheLoop).toBe(true);
    expect(card.authentication.type).toBe("oauth2");
  });

  it("advertises the JSON-RPC endpoint the way current A2A clients read it", () => {
    const card = buildAgentCard("https://mcp.taskpilot.sudiptadhara.in");
    expect(card.preferredTransport).toBe("JSONRPC");
    const jsonRpc = card.supportedInterfaces.find((i) => i.protocolBinding === "JSONRPC");
    expect(jsonRpc).toBeDefined();
    expect(jsonRpc!.url).toBe("https://mcp.taskpilot.sudiptadhara.in/a2a");
    expect(card.defaultInputModes.length).toBeGreaterThan(0);
    expect(card.defaultOutputModes.length).toBeGreaterThan(0);
  });

  it("describes OAuth via securitySchemes as well as the legacy field", () => {
    const card = buildAgentCard("https://example.com");
    expect(card.securitySchemes.oauth2.type).toBe("oauth2");
    expect(card.securitySchemes.oauth2.flows.authorizationCode.tokenUrl).toBe("https://example.com/token");
    expect(card.security[0].oauth2).toContain("taskpilot:write");
    expect(card.authentication.type).toBe("oauth2");
  });

  it("gives every skill the spec-required id and tags", () => {
    const card = buildAgentCard("https://example.com");
    for (const skill of card.skills) {
      expect(skill.id).toBe(skill.name);
      expect(skill.tags.length).toBeGreaterThan(0);
    }
  });

  it("includes all skills with names and descriptions", () => {
    const card = buildAgentCard("https://example.com");
    for (const skill of card.skills) {
      expect(skill.name).toBeDefined();
      expect(typeof skill.name).toBe("string");
      expect(skill.description).toBeDefined();
      expect(typeof skill.description).toBe("string");
    }
  });

  it("includes requiresApproval for conditional skills", () => {
    const card = buildAgentCard("https://example.com");
    const moveSkill = card.skills.find((s: any) => s.name === "task.move");
    expect(moveSkill).toBeDefined();
    expect(moveSkill!.requiresApproval).toBe("conditional");
  });

  it("builds llms.txt with comprehensive documentation", () => {
    const txt = buildLlmsTxt("https://mcp.taskpilot.sudiptadhara.in");
    expect(txt).toContain("TaskPilot A2A Protocol");
    expect(txt).toContain("task.create");
    expect(txt).toContain("message.send");
    expect(txt).toContain("OAuth 2.0");
    expect(txt).toContain("/authorize");
    expect(txt).toContain("/token");
    // Verify comprehensive sections present (matching Inbox format)
    expect(txt).toContain("## Quick Start");
    expect(txt).toContain("## Task States");
    expect(txt).toContain("## Rate Limits");
    expect(txt).toContain("## Real-Time Updates (SSE)");
    expect(txt).toContain("## Webhook Notifications");
    expect(txt).toContain("## Human-in-the-Loop Approvals");
    expect(txt).toContain("## Response Format");
    expect(txt).toContain("## Security Features");
    expect(txt).toContain("## Production Endpoints");
    expect(txt).toContain("## Quick Integration Checklist");
    expect(txt).toContain("## Compliance & Audit");
    expect(txt).toContain("HMAC-SHA256");
    expect(txt).toContain("DharaHIL");
    expect(typeof txt).toBe("string");
  });

  it("documents every registered skill in llms.txt", () => {
    const txt = buildLlmsTxt("https://example.com");
    for (const skill of getAllSkills()) {
      expect(txt, `llms.txt is missing ${skill.name}`).toContain(skill.name);
    }
  });
});

describe("llms.txt tells a peer what it actually needs", () => {
  const txt = buildLlmsTxt("https://example.test");

  it("points agents at peer tokens, not the OAuth flow that expires on them", () => {
    // OAuth refresh failing while an unattended agent slept is the reason
    // peers moved to static tokens; the doc used to say OAuth was required.
    expect(txt).toMatch(/[Ll]ong-lived peer token/);
    expect(txt).toMatch(/recommended for agents/i);
  });

  it("states that an external peer needs approval for EVERY write", () => {
    // It previously said only cancellation was gated, which would let a peer
    // assume its other writes go through unattended.
    expect(txt).toMatch(/EVERY write/);
    expect(txt).toContain("peer_");
  });

  it("says contextId is required, the most common integration mistake", () => {
    expect(txt).toMatch(/contextId.*required/is);
  });

  it("documents the free-text path, so a peer that cannot name a skill still works", () => {
    expect(txt).toMatch(/do not have to name a skill/i);
  });

  it("documents the MQTT bus and refuses to promise an approve topic", () => {
    expect(txt).toContain("taskpilot/ingest/+");
    expect(txt).toMatch(/no MQTT topic that approves/i);
  });
});
