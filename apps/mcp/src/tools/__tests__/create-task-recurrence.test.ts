import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression: one ongoing outage became 96 tickets. The monitor's agent got
 * "possible_duplicate ... pass force_create: true to file anyway", and did.
 * A repeat of an open item must be recorded on it, not refused or re-filed.
 */
const { routeMock, dupMock, queryMock } = vi.hoisted(() => ({ routeMock: vi.fn(), dupMock: vi.fn(), queryMock: vi.fn() }));

vi.mock("../../routing/router.js", () => ({ routeWorkItem: routeMock }));
vi.mock("../../routing/dedupe.js", () => ({ findDuplicate: dupMock }));
vi.mock("../../db.js", () => ({ db: { query: queryMock } }));
vi.mock("../../agent/mqtt.js", () => ({ publish: vi.fn(), TOPIC: { taskCreated: "t" } }));

import { handleCreateTask } from "../handlers.js";

const client = () => ({
  createIssue: vi.fn(async (_p: string, data: any) => ({ id: "new", sequence_id: 7, name: data.name, ...data })),
  addComment: vi.fn(async () => ({})),
  createRelation: vi.fn(async () => ({})),
});
const routed = { projectId: "p1", confidence: 1, reason: "", source: "hint", candidates: [{ id: "p1", identifier: "OPS", name: "Ops" }] };
const match = (stateGroup: string, probability?: number) => ({ match: { issueId: "old", identifier: "OPS-3", score: 0.97, stateGroup, probability } });

beforeEach(() => {
  routeMock.mockReset().mockResolvedValue(routed);
  dupMock.mockReset().mockResolvedValue({ match: null });
  queryMock.mockReset().mockResolvedValue({ rows: [] });
});

describe("create_task with a repeat report", () => {
  it("records a judged repeat of an open item on it instead of filing again", async () => {
    dupMock.mockResolvedValue(match("backlog", 0.93));
    const c = client();
    const out = await handleCreateTask({ title: "Health check blocked at 2026-10-12T15:44Z" }, c as any, "w");
    expect(out).toMatchObject({ status: "recorded_on_existing", identifier: "OPS-3", matched_by: "same_work" });
    expect(c.addComment).toHaveBeenCalledWith("p1", "old", expect.stringContaining("Health check blocked"));
    expect(c.createIssue).not.toHaveBeenCalled();
  });

  it("escapes the reporter's text in the comment", async () => {
    dupMock.mockResolvedValue(match("started", 0.9));
    const c = client();
    await handleCreateTask({ title: "<img src=x onerror=alert(1)>" }, c as any, "w");
    expect((c.addComment.mock.calls[0] as any)[2]).not.toContain("<img");
  });

  it("still asks, rather than absorbs, when only the similarity fallback matched", async () => {
    dupMock.mockResolvedValue(match("backlog"));
    const c = client();
    expect(await handleCreateTask({ title: "x" }, c as any, "w")).toMatchObject({ status: "possible_duplicate" });
    expect(c.addComment).not.toHaveBeenCalled();
  });

  it("files a recurrence of completed work as a new item linked to the old one", async () => {
    dupMock.mockResolvedValue(match("completed", 0.95));
    const c = client();
    const out = await handleCreateTask({ title: "x" }, c as any, "w");
    expect(out).toMatchObject({ identifier: "OPS-7", recurrence_of: "OPS-3" });
    expect(c.createRelation).toHaveBeenCalledWith("p1", "new", "relates_to", ["old"]);
  });

  it("uses dedup_key ahead of everything, and force_create cannot split an open incident", async () => {
    queryMock.mockResolvedValue({ rows: [{ id: "old", project_id: "p1", identifier: "OPS-3", state_group: "started" }] });
    const c = client();
    const out = await handleCreateTask({ title: "x", dedup_key: "paperclip:egress", force_create: true }, c as any, "w");
    expect(out).toMatchObject({ status: "recorded_on_existing", matched_by: "dedup_key" });
    expect(routeMock).not.toHaveBeenCalled();
    expect(c.createIssue).not.toHaveBeenCalled();
  });

  it("stores dedup_key on a new item, with a dated suffix when the old one is closed", async () => {
    const c = client();
    await handleCreateTask({ title: "x", dedup_key: "k" }, c as any, "w");
    expect((c.createIssue.mock.calls[0] as any)[1]).toMatchObject({ external_source: "taskpilot-dedup", external_id: "k" });

    queryMock.mockResolvedValue({ rows: [{ id: "old", project_id: "p1", identifier: "OPS-3", state_group: "completed" }] });
    const c2 = client();
    const out = await handleCreateTask({ title: "x", dedup_key: "k" }, c2 as any, "w");
    expect((c2.createIssue.mock.calls[0] as any)[1].external_id).toMatch(/^k@\d{4}-/);
    expect(out).toMatchObject({ recurrence_of: "OPS-3" });
  });

  it("tells the caller when the duplicate check could not run", async () => {
    dupMock.mockResolvedValue({ match: null, skipped: "Embedding request failed (503)" });
    const out = await handleCreateTask({ title: "x" }, client() as any, "w");
    expect(out).toMatchObject({ duplicate_check: expect.stringContaining("skipped") });
  });
});
