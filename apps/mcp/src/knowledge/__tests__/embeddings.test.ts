import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../tools/smart-router.js", () => ({
  getLlmConfig: async () => ({ apiKey: "test-key", baseUrl: "http://litellm.test/v1", model: "test-llm" }),
}));

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

const vectors = (...fills: number[]) => ({
  data: fills.map((fill, index) => ({ index, embedding: new Array(768).fill(fill) })),
});

describe("embed", () => {
  it("posts an OpenAI-style request to the gateway and returns the vector", async () => {
    const spy = stubFetch(vectors(0.1));
    const vector = await embed("fix the login bug");

    expect(vector.length).toBe(768);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("http://litellm.test/v1/embeddings");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toEqual({ model: "test-embedder", input: ["fix the login bug"] });
  });

  it("throws when the server errors", async () => {
    stubFetch({ detail: "boom" }, false);
    await expect(embed("anything")).rejects.toThrow(/embedding/i);
  });

  it("throws when the dimension is not what the collection expects", async () => {
    // A model swap would silently poison the index; fail loudly instead.
    stubFetch({ data: [{ index: 0, embedding: new Array(1024).fill(0.1) }] });
    await expect(embed("anything")).rejects.toThrow(/768/);
  });
});

describe("embedBatch", () => {
  it("returns vectors in input order even when the response is not", async () => {
    stubFetch({
      data: [
        { index: 1, embedding: new Array(768).fill(0.2) },
        { index: 0, embedding: new Array(768).fill(0.1) },
      ],
    });
    const result = await embedBatch(["one", "two"]);

    expect(result.map((vector) => vector[0])).toEqual([0.1, 0.2]);
  });

  it("returns an empty array without calling the server for empty input", async () => {
    const spy = stubFetch({});
    expect(await embedBatch([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws when the response has fewer embeddings than inputs", async () => {
    stubFetch(vectors(0.1));
    await expect(embedBatch(["one", "two", "three"])).rejects.toThrow(/1 vectors for 3 inputs/);
  });
});

describe("empty inputs", () => {
  it("refuses an empty string and names the position, rather than sending a 400", async () => {
    // One page in the corpus had neither a name nor a description. The server
    // answered such an input with a 400 that failed the whole 32-item batch and
    // threw the entire sync — every cycle. The caller must skip these; this
    // makes it obvious which one was wrong if it ever slips through.
    const spy = stubFetch({ data: [] });
    await expect(embedBatch(["real text", "   "])).rejects.toThrow(/empty string at index 1/);
    expect(spy).not.toHaveBeenCalled();
  });
});
