import { describe, it, expect, vi, afterEach } from "vitest";
import { pickDuplicate, findDuplicate } from "../dedupe.js";

const hit = (score: number, id = "i1") => ({
  id,
  score,
  payload: { issue_id: id, identifier: "SUDIPTASCF-1" },
});

describe("pickDuplicate", () => {
  it("returns the top hit when it clears the threshold", () => {
    expect(pickDuplicate([hit(0.93)], 0.85)).toEqual({
      issueId: "i1",
      identifier: "SUDIPTASCF-1",
      score: 0.93,
    });
  });

  it("returns null when the best hit is below the threshold", () => {
    // Similar is not the same. Below threshold we file a new item.
    expect(pickDuplicate([hit(0.84)], 0.85)).toBeNull();
  });

  it("returns null for no hits", () => {
    expect(pickDuplicate([], 0.85)).toBeNull();
  });

  it("ignores hits whose payload has no issue_id", () => {
    expect(pickDuplicate([{ id: "x", score: 0.99, payload: {} }], 0.85)).toBeNull();
  });
});

// findDuplicate hits the network through embed() and search(), so we stub
// fetch directly rather than mocking those modules — same convention as
// embeddings.test.ts and qdrant.test.ts.
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(responses: any[]) {
  const spy = vi.fn();
  for (const body of responses) {
    const status = body.__status ?? (body.__ok === false ? 404 : 200);
    spy.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("findDuplicate", () => {
  it("scopes the Qdrant search to the caller's candidate project ids", async () => {
    // taskpilot_vector_db is one collection shared by every workspace, so a
    // missing or empty scope must never fall through to a workspace-wide (or
    // instance-wide) search.
    const spy = stubFetch([
      { embedding: new Array(1024).fill(0.1) },
      {
        result: [
          { id: "i1", score: 0.93, payload: { issue_id: "i1", identifier: "SUDIPTASCF-1" } },
        ],
      },
    ]);

    const result = await findDuplicate("fix the login bug", { projectIds: ["p1", "p2"] });

    expect(result).toEqual({ issueId: "i1", identifier: "SUDIPTASCF-1", score: 0.93 });

    const [, searchInit] = spy.mock.calls[1];
    const body = JSON.parse(searchInit.body);
    expect(body.filter.must).toContainEqual({
      key: "project_id",
      match: { any: ["p1", "p2"] },
    });
    expect(body.filter.must).toContainEqual({
      key: "entity_type",
      match: { value: "work_item" },
    });
  });

  it("returns null without calling the network when no candidate project ids are given", async () => {
    // No means of scoping the search safely -> skip the check rather than
    // risk matching a work item in someone else's workspace.
    const spy = stubFetch([]);
    expect(await findDuplicate("fix the login bug", { projectIds: [] })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when the embedding service is down", async () => {
    const spy = stubFetch([{ __status: 500, error: "down" }]);
    expect(await findDuplicate("fix the login bug", { projectIds: ["p1"] })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
