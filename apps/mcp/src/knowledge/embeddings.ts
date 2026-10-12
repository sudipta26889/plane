import { config } from "../config.js";
import { getLlmConfig } from "../tools/smart-router.js";

// The server lazily unloads after 300s idle. Warm throughput on real work-item
// text is ~1750 chars/sec, so a full batch runs tens of seconds; a cold start
// adds a model load on top. 60s covered neither together and aborted the first
// batch of every sync.
const EMBED_TIMEOUT_MS = 180_000;

function assertDims(vector: number[]): number[] {
  if (vector.length !== config.embeddingDims) {
    throw new Error(
      `Embedding server returned ${vector.length} dimensions, expected ${config.embeddingDims}. ` +
        `The model has changed — stored vectors are no longer comparable.`,
    );
  }
  return vector;
}

async function post(input: string[]): Promise<number[][]> {
  if (!config.embeddingModel) {
    throw new Error("EMBEDDING_MODEL is not configured");
  }

  // Same gateway and key as the chat model, so there is one credential to rotate.
  const llm = await getLlmConfig();
  const response = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({ model: config.embeddingModel, input }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Embedding request failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data: any = await response.json();
  // OpenAI-style: one entry per input, each carrying its input position.
  return [...(data.data || [])].sort((a: any, b: any) => a.index - b.index).map((item: any) => item.embedding || []);
}

export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text]);
  return vector!;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  // The server answers an empty input with a 400 that names no offender, and
  // one such row is enough to fail an entire batch. Refuse here so the caller
  // sees which position was wrong instead of an opaque HTTP error.
  const emptyAt = texts.findIndex((text) => !text.trim());
  if (emptyAt !== -1) {
    throw new Error(`embedBatch received an empty string at index ${emptyAt}; callers must skip rows with no text`);
  }

  const embeddings = await post(texts);

  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embedding server returned ${embeddings.length} vectors for ${texts.length} inputs. ` +
        `Malformed or truncated response.`,
    );
  }

  return embeddings.map(assertDims);
}
