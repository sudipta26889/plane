import { describe, it, expect, vi, afterEach } from "vitest";
import { ensureCollection, upsertPoints, search, deletePoints, retrievePayloads } from "../qdrant.js";

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

describe("ensureCollection", () => {
  it("does nothing when the collection already exists", async () => {
    const spy = stubFetch([{ result: { points_count: 5 } }]);
    await ensureCollection();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("creates the collection at the configured dimension when missing", async () => {
    const spy = stubFetch([{ __ok: false }, { result: true }]);
    await ensureCollection();

    expect(spy).toHaveBeenCalledTimes(2);
    const [url, init] = spy.mock.calls[1];
    expect(url).toContain("/collections/");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body).vectors).toEqual({ size: 1024, distance: "Cosine" });
  });

  it("throws on 500 error and does not attempt to create", async () => {
    const spy = stubFetch([{ __status: 500, error: "Internal Server Error" }]);
    await expect(ensureCollection()).rejects.toThrow(/failed \(500\)/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws on 403 error and does not attempt to create", async () => {
    const spy = stubFetch([{ __status: 403, error: "Forbidden" }]);
    await expect(ensureCollection()).rejects.toThrow(/failed \(403\)/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("search", () => {
  it("returns hits with id, score and payload", async () => {
    stubFetch([
      { result: [{ id: "abc", score: 0.91, payload: { issue_id: "i1", project_id: "p1" } }] },
    ]);

    const hits = await search(new Array(1024).fill(0.1), { limit: 5 });
    expect(hits).toEqual([
      { id: "abc", score: 0.91, payload: { issue_id: "i1", project_id: "p1" } },
    ]);
  });

  it("passes the filter through and can target another collection", async () => {
    const spy = stubFetch([{ result: [] }]);
    await search(new Array(1024).fill(0.1), {
      limit: 3,
      filter: { must: [{ key: "project_id", match: { value: "p1" } }] },
      collection: "meetecho_vector_db_pkm",
    });

    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("/collections/meetecho_vector_db_pkm/points/search");
    const body = JSON.parse(init.body);
    expect(body.limit).toBe(3);
    expect(body.filter.must[0].key).toBe("project_id");
  });
});

describe("upsertPoints", () => {
  it("does not call the server for an empty batch", async () => {
    const spy = stubFetch([{ result: true }]);
    await upsertPoints([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends points in Qdrant's wire shape", async () => {
    const spy = stubFetch([{ result: true }]);
    await upsertPoints([{ id: "p1", vector: [0.1], payload: { issue_id: "i1" } }]);

    const [, init] = spy.mock.calls[0];
    expect(JSON.parse(init.body).points[0]).toEqual({
      id: "p1",
      vector: [0.1],
      payload: { issue_id: "i1" },
    });
  });
});

describe("deletePoints", () => {
  it("does not call the server for an empty list", async () => {
    const spy = stubFetch([{ result: true }]);
    await deletePoints([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends point ids in the correct request shape", async () => {
    const spy = stubFetch([{ result: true }]);
    await deletePoints(["p1", "p2"]);

    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("/collections/");
    expect(url).toContain("/points/delete");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).points).toEqual(["p1", "p2"]);
  });
});

describe("retrievePayloads", () => {
  it("maps point ids to their stored payloads", async () => {
    stubFetch([{ result: [{ id: "i1", payload: { content_hash: "abc" } }] }]);
    const map = await retrievePayloads(["i1", "i2"]);

    expect(map.get("i1")).toEqual({ content_hash: "abc" });
    // An id Qdrant does not know about is simply absent, not an error.
    expect(map.has("i2")).toBe(false);
  });

  it("does not call the server for an empty list", async () => {
    const spy = stubFetch([{ result: [] }]);
    expect((await retrievePayloads([])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends point ids in the correct request shape", async () => {
    const spy = stubFetch([{ result: [] }]);
    await retrievePayloads(["p1", "p2"]);

    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("/collections/");
    expect(url).toContain("/points");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.ids).toEqual(["p1", "p2"]);
    expect(body.with_payload).toBe(true);
  });
});
