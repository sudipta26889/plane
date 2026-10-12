import { describe, it, expect, vi, beforeEach } from "vitest";

const { searchMock, createMock } = vi.hoisted(() => ({ searchMock: vi.fn(), createMock: vi.fn() }));

vi.mock("../../config.js", () => ({ config: { routeConfidenceThreshold: 0.7, decisionModel: "", decisionModelLive: [] } }));
vi.mock("../../db.js", () => ({ db: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../../knowledge/embeddings.js", () => ({ embed: async () => [0.1, 0.2] }));
vi.mock("../../knowledge/qdrant.js", () => ({ search: searchMock }));
vi.mock("../../knowledge/context.js", () => ({
  getWorkspaceContext: async () => ({
    projects: [
      { id: "p-fin", identifier: "FIN", name: "Finance", description: "" },
      { id: "p-ops", identifier: "OPS", name: "Ops", description: "" },
    ],
  }),
  formatProjectsForPrompt: () => "",
}));
vi.mock("../../tools/smart-router.js", () => ({
  getLlmConfig: async () => ({ apiKey: "k", baseUrl: "http://llm.test", model: "m" }),
  defuseMessages: (messages: any[]) => messages,
}));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: createMock } }; } }));

import { routeWorkItem } from "../router.js";

const hit = (project: string, score: number) => ({ id: `${project}-${score}`, score, payload: { issue_id: `${project}-${score}`, project_id: project } });

beforeEach(() => {
  searchMock.mockReset();
  createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: '{"project_id": "p-ops", "confidence": 0.9, "reason": "r"}' } }] });
});

describe("routeWorkItem", () => {
  it("lets confident neighbours decide without asking any model", async () => {
    searchMock.mockResolvedValue([hit("p-fin", 0.9), hit("p-fin", 0.88), hit("p-fin", 0.86)]);
    const decision = await routeWorkItem({ workspace: "w", title: "GSTR-1 Oct-Dec" }, {} as any);
    expect(decision).toMatchObject({ projectId: "p-fin", source: "neighbours" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("asks the model when the evidence is split", async () => {
    searchMock.mockResolvedValue([hit("p-fin", 0.85), hit("p-fin", 0.84), hit("p-ops", 0.85), hit("p-ops", 0.84)]);
    const decision = await routeWorkItem({ workspace: "w", title: "something in between" }, {} as any);
    expect(decision).toMatchObject({ projectId: "p-ops", source: "llm" });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("keeps cancelled items and excluded ids out of the evidence", async () => {
    searchMock.mockResolvedValue([]);
    await routeWorkItem({ workspace: "w", title: "x", excludeIds: ["self"] }, {} as any);
    const { filter } = searchMock.mock.calls[0]![1];
    expect(filter.must_not).toEqual(expect.arrayContaining([{ key: "state_group", match: { value: "cancelled" } }, { has_id: ["self"] }]));
  });
});
