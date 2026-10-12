import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { searchMock, createMock } = vi.hoisted(() => ({ searchMock: vi.fn(), createMock: vi.fn() }));

vi.mock("../../config.js", () => ({ config: { routeConfidenceThreshold: 0.7, decisionModel: "typesafe/jev-latest", decisionModelLive: ["route_project"], decisionMinConfidence: 0.9 } }));
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

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  searchMock.mockReset();
  createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: '{"project_id": "p-ops", "confidence": 0.9, "reason": "r"}' } }] });
});

const jev = (choice: string, confidence: number) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ model: "jev-1.13.0", answers: { project: { type: "choice", choice, confidence, probabilities: {} } } }) })));

const split = [hit("p-fin", 0.85), hit("p-fin", 0.84), hit("p-ops", 0.85), hit("p-ops", 0.84)];

describe("routeWorkItem with Jev live", () => {
  it("files where a confident Jev says, without asking the LLM", async () => {
    searchMock.mockResolvedValue(split);
    jev("FIN", 0.97);
    expect(await routeWorkItem({ workspace: "w", title: "x" }, {} as any)).toMatchObject({ projectId: "p-fin", source: "jev" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("sends an item Jev is unsure about to Intake, never to the LLM", async () => {
    searchMock.mockResolvedValue(split);
    jev("FIN", 0.6);
    expect(await routeWorkItem({ workspace: "w", title: "x" }, {} as any)).toMatchObject({ projectId: null, source: "undecided" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("treats Jev's 'unclear' as unsure", async () => {
    searchMock.mockResolvedValue(split);
    jev("unclear", 0.99);
    expect(await routeWorkItem({ workspace: "w", title: "x" }, {} as any)).toMatchObject({ projectId: null });
  });
});
