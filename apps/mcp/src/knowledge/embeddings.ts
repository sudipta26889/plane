import { config } from "../config.js";

// The embedding server lazily unloads after 300s idle and takes ~10.5s to
// reload; a single warm call is ~0.11s. Allow for a cold start.
const EMBED_TIMEOUT_MS = 60_000;

function assertDims(vector: number[]): number[] {
  if (vector.length !== config.embeddingDims) {
    throw new Error(
      `Embedding server returned ${vector.length} dimensions, expected ${config.embeddingDims}. ` +
        `The model has changed — stored vectors are no longer comparable.`,
    );
  }
  return vector;
}

async function post(path: string, body: unknown): Promise<any> {
  if (!config.embeddingUrl) {
    throw new Error("EMBEDDING_DIRECT_URL is not configured");
  }

  const url = path ? `${config.embeddingUrl.replace(/\/$/, "")}${path}` : config.embeddingUrl;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Embedding request failed (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.json();
}

export async function embed(text: string): Promise<number[]> {
  const data = await post("", { text });
  return assertDims(data.embedding || []);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const data = await post("/batch", { inputs: texts.map((text) => ({ text })) });
  const embeddings: number[][] = data.embeddings || [];
  return embeddings.map(assertDims);
}
