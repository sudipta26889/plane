import { config } from "../config.js";

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantHit {
  id: string;
  score: number;
  payload: Record<string, any>;
}

const TIMEOUT_MS = 15_000;

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  if (!config.qdrantUrl) {
    throw new Error("QDRANT_URL is not configured");
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.qdrantApiKey) headers["api-key"] = config.qdrantApiKey;

  return fetch(`${config.qdrantUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function requestJson(method: string, path: string, body?: unknown): Promise<any> {
  const response = await request(method, path, body);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Qdrant ${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.json();
}

/** Create the collection if it does not exist. Safe to call on every boot. */
export async function ensureCollection(): Promise<void> {
  const existing = await request("GET", `/collections/${config.qdrantCollection}`);
  if (existing.ok) return;

  await requestJson("PUT", `/collections/${config.qdrantCollection}`, {
    vectors: { size: config.embeddingDims, distance: "Cosine" },
  });
  console.log(`[qdrant] Created collection ${config.qdrantCollection}`);
}

export async function upsertPoints(points: QdrantPoint[]): Promise<void> {
  if (points.length === 0) return;
  await requestJson("PUT", `/collections/${config.qdrantCollection}/points?wait=true`, { points });
}

export async function search(
  vector: number[],
  opts: { limit: number; filter?: Record<string, unknown>; collection?: string },
): Promise<QdrantHit[]> {
  const collection = opts.collection || config.qdrantCollection;
  const data = await requestJson("POST", `/collections/${collection}/points/search`, {
    vector,
    limit: opts.limit,
    with_payload: true,
    ...(opts.filter ? { filter: opts.filter } : {}),
  });

  return (data.result || []).map((hit: any) => ({
    id: String(hit.id),
    score: hit.score,
    payload: hit.payload || {},
  }));
}

export async function deletePoints(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await requestJson("POST", `/collections/${config.qdrantCollection}/points/delete?wait=true`, {
    points: ids,
  });
}

/**
 * Fetch stored payloads by point id. Missing ids are simply absent from the
 * map. Used to skip re-embedding rows whose content has not changed.
 */
export async function retrievePayloads(ids: string[]): Promise<Map<string, Record<string, any>>> {
  const map = new Map<string, Record<string, any>>();
  if (ids.length === 0) return map;

  const data = await requestJson("POST", `/collections/${config.qdrantCollection}/points`, {
    ids,
    with_payload: true,
  });

  for (const point of data.result || []) {
    map.set(String(point.id), point.payload || {});
  }
  return map;
}
