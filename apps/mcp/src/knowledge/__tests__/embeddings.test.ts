import { describe, it, expect, vi, afterEach } from "vitest";
import { embed, embedBatch } from "../embeddings.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: any, ok = true) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("embed", () => {
  it("posts { text } and returns the vector", async () => {
    const spy = stubFetch({ embedding: new Array(1024).fill(0.1), dimensions: 1024 });
    const vector = await embed("fix the login bug");

    expect(vector.length).toBe(1024);
    const [, init] = spy.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ text: "fix the login bug" });
  });

  it("throws when the server errors", async () => {
    stubFetch({ detail: "boom" }, false);
    await expect(embed("anything")).rejects.toThrow(/embedding/i);
  });

  it("throws when the dimension is not what the collection expects", async () => {
    // A model swap would silently poison the index; fail loudly instead.
    stubFetch({ embedding: new Array(768).fill(0.1), dimensions: 768 });
    await expect(embed("anything")).rejects.toThrow(/1024/);
  });
});

describe("embedBatch", () => {
  it("posts { inputs: [{ text }] } and returns vectors in order", async () => {
    const spy = stubFetch({
      embeddings: [new Array(1024).fill(0.1), new Array(1024).fill(0.2)],
      dimensions: 1024,
    });
    const vectors = await embedBatch(["one", "two"]);

    expect(vectors.length).toBe(2);
    const [, init] = spy.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ inputs: [{ text: "one" }, { text: "two" }] });
  });

  it("returns an empty array without calling the server for empty input", async () => {
    const spy = stubFetch({});
    expect(await embedBatch([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws when the response has fewer embeddings than inputs", async () => {
    // Simulate a truncated or malformed response
    stubFetch({
      embeddings: [new Array(1024).fill(0.1)],
      dimensions: 1024,
    });
    await expect(embedBatch(["one", "two", "three"])).rejects.toThrow(/1 vectors for 3 inputs/);
  });
});
