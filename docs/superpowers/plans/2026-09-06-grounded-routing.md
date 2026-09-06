# Grounded Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TaskPilot A2A router decide where work belongs using real instance data, and return `undecided` instead of guessing when it cannot tell.

**Architecture:** A Qdrant collection holds embeddings of the workspace's work items. Routing embeds the incoming title + description, retrieves similar existing items, and asks the LLM to choose a project given both the project descriptions and the neighbours' projects as evidence. Every decision carries a confidence score; below threshold the item goes to a configured Intake project, or nowhere at all if none is configured. The "use the first project" fallback is deleted.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express, `pg`, `ioredis`, `openai` SDK (already used for LLM calls), vitest. Qdrant and the embedding server are reached over plain `fetch` — no new npm dependencies.

**Spec:** [docs/superpowers/specs/2026-09-06-taskpilot-agent-grounding-design.md](../specs/2026-09-06-taskpilot-agent-grounding-design.md)

**Follow-up plan:** pages, intake triage, relations and call-note skills are a separate plan that depends on this one. That plan also carries the spec's "uncertain updates ask via DharaHIL" requirement: nothing in *this* plan ever modifies existing data — a detected duplicate is reported back to the caller rather than merged — so there is no uncertain write for DharaHIL to gate yet.

## Global Constraints

- Node ESM: every relative import ends in `.js`, even from `.ts` source. Match the existing files.
- No new npm dependencies. Qdrant and the embedding server are `fetch` calls.
- Embedding model is fixed: `BAAI/bge-visualized-m3`, **1024 dimensions**. It cannot be swapped without forfeiting the reuse of `meetecho_vector_db_pkm`.
- The embedding endpoint takes `{"text": "..."}` for `/embed` and `{"inputs": [{"text": "..."}]}` for `/embed/batch`. Responses are `{embedding, dimensions}` and `{embeddings, dimensions}`.
- Never write to `meetecho_vector_db_pkm`. It is read-only, and this plan does not read it either — that is the follow-up plan.
- Leave the `taskpilot_tasks` Qdrant collection untouched: 768-dim, incompatible, unused.
- Any env var added must land in `.env`, `.env.example`, and the compose/Portainer stack in the same change.
- Tests must not make network calls. Stub `fetch` with `vi.stubGlobal`.
- Run tests from `apps/mcp` with `npx vitest run`.

---

### Task 1: Configuration and environment parity

**Files:**
- Modify: `apps/mcp/src/config.ts:19-22`
- Modify: `.env.example` (append a new section at the end)
- Modify: `docker-compose.yml` (mcp service, verify `env_file`)
- Test: `apps/mcp/src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.qdrantUrl`, `config.qdrantApiKey`, `config.qdrantCollection`, `config.embeddingUrl`, `config.embeddingDims`, `config.routeConfidenceThreshold`, `config.dedupeSimilarityThreshold`, `config.intakeProjects` (a `Map<string, string>` of workspace slug → project identifier).

- [ ] **Step 1: Write the failing test**

Create `apps/mcp/src/__tests__/config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseIntakeProjects } from "../config.js";

describe("parseIntakeProjects", () => {
  it("parses workspace:identifier pairs", () => {
    const map = parseIntakeProjects("for-ai:SUDIPTASCF,sss-global-apex:REVATICRAF");
    expect(map.get("for-ai")).toBe("SUDIPTASCF");
    expect(map.get("sss-global-apex")).toBe("REVATICRAF");
  });

  it("returns an empty map for empty or malformed input", () => {
    expect(parseIntakeProjects("").size).toBe(0);
    expect(parseIntakeProjects(undefined).size).toBe(0);
    // A pair with no colon is skipped rather than throwing — a bad env var
    // must not stop the server from booting.
    expect(parseIntakeProjects("garbage,for-ai:SUDIPTASCF").size).toBe(1);
  });

  it("trims whitespace around pairs", () => {
    const map = parseIntakeProjects(" for-ai : SUDIPTASCF ");
    expect(map.get("for-ai")).toBe("SUDIPTASCF");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL — `parseIntakeProjects` is not exported from `../config.js`.

- [ ] **Step 3: Write the implementation**

In `apps/mcp/src/config.ts`, add above the `config` object:

```typescript
/**
 * Parse "workspace-slug:PROJECT_IDENTIFIER" pairs into a lookup map.
 * Malformed pairs are skipped — a typo in the env must not stop the server booting.
 */
export function parseIntakeProjects(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;

  for (const pair of raw.split(",")) {
    const [slug, identifier] = pair.split(":");
    if (!slug?.trim() || !identifier?.trim()) continue;
    map.set(slug.trim(), identifier.trim());
  }

  return map;
}
```

Then add these keys inside the `config` object, after the existing LLM block at line 22:

```typescript
  // Vector store (Qdrant) — awareness of existing work items
  qdrantUrl: process.env.QDRANT_URL || "",
  qdrantApiKey: process.env.QDRANT_API_KEY || "",
  qdrantCollection: process.env.QDRANT_COLLECTION_NAME || "taskpilot_vector_db",

  // Embedding server. Dimension is fixed by the model and by the PKM
  // collection we reuse — changing it invalidates every stored vector.
  embeddingUrl: process.env.EMBEDDING_DIRECT_URL || "",
  embeddingDims: 1024,

  // Routing thresholds. Tuned by scripts/eval-routing.ts, not by feel.
  routeConfidenceThreshold: parseFloat(process.env.A2A_ROUTE_CONFIDENCE || "0.7"),
  dedupeSimilarityThreshold: parseFloat(process.env.A2A_DEDUPE_SIMILARITY || "0.85"),

  // Where low-confidence items go, per workspace. Unset means the router
  // returns "undecided" and nothing is written.
  intakeProjects: parseIntakeProjects(process.env.A2A_INTAKE_PROJECTS),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/__tests__/config.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Restore env parity**

Append to `.env.example`:

```bash
# ---------- Agent grounding (Qdrant + embeddings) ----------
QDRANT_URL="http://qdrant.example.com:6333"
QDRANT_API_KEY=""
QDRANT_COLLECTION_NAME="taskpilot_vector_db"
# Embedding server. Must be the same model that produced the PKM vectors
# (BAAI/bge-visualized-m3, 1024-dim) or stored vectors become incomparable.
EMBEDDING_DIRECT_URL="http://embeddings.example.com:18081/embed"
# Routing thresholds — see scripts/eval-routing.ts
A2A_ROUTE_CONFIDENCE=0.7
A2A_DEDUPE_SIMILARITY=0.85
# Where low-confidence items are filed, as workspace-slug:PROJECT_IDENTIFIER
# pairs. Leave empty to have the router refuse rather than guess.
A2A_INTAKE_PROJECTS=""
```

Add the three new keys to `.env` as well (`A2A_ROUTE_CONFIDENCE`, `A2A_DEDUPE_SIMILARITY`, `A2A_INTAKE_PROJECTS`) — the four Qdrant/embedding keys are already there.

- [ ] **Step 6: Verify parity**

Run:

```bash
cd /mnt/projects/TaskPilot && diff <(grep -oE '^[A-Z_][A-Z0-9_]*=' .env|sort -u) <(grep -oE '^[A-Z_][A-Z0-9_]*=' .env.example|sort -u)
```

Expected: no output. Any line printed is a key present in one file and missing from the other — fix it before continuing.

The `mcp` service in `docker-compose.yml` already uses `env_file: .env`, so it inherits these with no compose change. Confirm that is still true:

```bash
sed -n '/^  mcp:/,/restart:/p' docker-compose.yml
```

Expected: the block contains `env_file:` followed by `- .env`. Update the Portainer stack env to match the new keys.

- [ ] **Step 7: Commit**

```bash
git add apps/mcp/src/config.ts apps/mcp/src/__tests__/config.test.ts .env.example
git commit -m "feat(a2a): add Qdrant, embedding and routing threshold config"
```

---

### Task 2: Embedding client

**Files:**
- Create: `apps/mcp/src/knowledge/embeddings.ts`
- Test: `apps/mcp/src/knowledge/__tests__/embeddings.test.ts`

**Interfaces:**
- Consumes: `config.embeddingUrl`, `config.embeddingDims` from Task 1.
- Produces: `embed(text: string): Promise<number[]>` and `embedBatch(texts: string[]): Promise<number[][]>`. Both throw on failure — callers decide how to degrade.

- [ ] **Step 1: Write the failing test**

Create `apps/mcp/src/knowledge/__tests__/embeddings.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/knowledge/__tests__/embeddings.test.ts`
Expected: FAIL — cannot resolve `../embeddings.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/mcp/src/knowledge/embeddings.ts`:

```typescript
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
```

Note: `EMBEDDING_DIRECT_URL` already ends in `/embed`, so `embedBatch` appends `/batch` to reach `/embed/batch`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/knowledge/__tests__/embeddings.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/knowledge/embeddings.ts apps/mcp/src/knowledge/__tests__/embeddings.test.ts
git commit -m "feat(a2a): add embedding client for bge-visualized-m3"
```

---

### Task 3: Qdrant client

**Files:**
- Create: `apps/mcp/src/knowledge/qdrant.ts`
- Test: `apps/mcp/src/knowledge/__tests__/qdrant.test.ts`

**Interfaces:**
- Consumes: `config.qdrantUrl`, `config.qdrantApiKey`, `config.qdrantCollection`, `config.embeddingDims`.
- Produces:
  - `ensureCollection(): Promise<void>`
  - `upsertPoints(points: QdrantPoint[]): Promise<void>` where `QdrantPoint = { id: string; vector: number[]; payload: Record<string, unknown> }`
  - `search(vector: number[], opts: { limit: number; filter?: Record<string, unknown>; collection?: string }): Promise<QdrantHit[]>` where `QdrantHit = { id: string; score: number; payload: Record<string, any> }`
  - `deletePoints(ids: string[]): Promise<void>`
  - `retrievePayloads(ids: string[]): Promise<Map<string, Record<string, any>>>`

- [ ] **Step 1: Write the failing test**

Create `apps/mcp/src/knowledge/__tests__/qdrant.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { ensureCollection, upsertPoints, search, deletePoints, retrievePayloads } from "../qdrant.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(responses: any[]) {
  const spy = vi.fn();
  for (const body of responses) {
    spy.mockResolvedValueOnce({
      ok: body.__ok !== false,
      status: body.__ok === false ? 404 : 200,
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/knowledge/__tests__/qdrant.test.ts`
Expected: FAIL — cannot resolve `../qdrant.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/mcp/src/knowledge/qdrant.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/knowledge/__tests__/qdrant.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/knowledge/qdrant.ts apps/mcp/src/knowledge/__tests__/qdrant.test.ts
git commit -m "feat(a2a): add Qdrant REST client"
```

---

### Task 4: Work-item index sync

**Files:**
- Create: `apps/mcp/src/knowledge/index-sync.ts`
- Test: `apps/mcp/src/knowledge/__tests__/index-sync.test.ts`

**Interfaces:**
- Consumes: `embedBatch` (Task 2), `ensureCollection`/`upsertPoints` (Task 3), `db` from `../db.js`.
- Produces:
  - `buildIndexText(row: { name: string; description_stripped: string | null }): string`
  - `contentHash(text: string): string`
  - `syncWorkItems(): Promise<{ embedded: number; skipped: number }>` — pages through every non-deleted work item via keyset pagination, so growth past any single page still gets indexed.

Sync is incremental by content hash: rows whose text has not changed since the stored point was written are skipped, so MeetEcho-style churn does not re-embed unchanged work. It pages over the entire corpus rather than capping at a fixed row count — a cap would silently stop indexing older items as the corpus grew, with nothing to signal the gap.

- [ ] **Step 1: Write the failing test**

Create `apps/mcp/src/knowledge/__tests__/index-sync.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildIndexText, contentHash } from "../index-sync.js";

describe("buildIndexText", () => {
  it("joins the title and description", () => {
    const text = buildIndexText({ name: "Fix login", description_stripped: "SSO is broken" });
    expect(text).toBe("Fix login\n\nSSO is broken");
  });

  it("tolerates a missing description", () => {
    // 5 of 439 work items have no description text.
    expect(buildIndexText({ name: "Fix login", description_stripped: null })).toBe("Fix login");
  });

  it("truncates very long descriptions to keep embedding latency bounded", () => {
    const text = buildIndexText({ name: "T", description_stripped: "x".repeat(10_000) });
    expect(text.length).toBeLessThanOrEqual(4096);
  });
});

describe("contentHash", () => {
  it("is stable for the same text", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("differs when the text changes", () => {
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/knowledge/__tests__/index-sync.test.ts`
Expected: FAIL — cannot resolve `../index-sync.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/mcp/src/knowledge/index-sync.ts`:

```typescript
import crypto from "node:crypto";
import { db } from "../db.js";
import { embedBatch } from "./embeddings.js";
import { ensureCollection, upsertPoints, retrievePayloads } from "./qdrant.js";

// Keeps a single embed call bounded: ~9 texts/sec on CPU, so a long tail of
// 10k-character descriptions would dominate the sync.
const MAX_INDEX_CHARS = 4096;

// Measured: 64 texts in 6.9s. Large enough to amortise the request, small
// enough that a failure loses little work.
const BATCH_SIZE = 64;

// Rows fetched per keyset page. Independent of BATCH_SIZE: this bounds the
// SQL result and the Qdrant payload lookup, not the embedding call.
const PAGE_SIZE = 500;

export function buildIndexText(row: { name: string; description_stripped: string | null }): string {
  const description = (row.description_stripped || "").trim();
  const text = description ? `${row.name}\n\n${description}` : row.name;
  return text.slice(0, MAX_INDEX_CHARS);
}

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/**
 * Embed work items that are new or whose text changed, and upsert them.
 * Returns counts so the caller can log progress; safe to run repeatedly.
 */
export async function syncWorkItems(): Promise<{ embedded: number; skipped: number }> {
  await ensureCollection();

  let embedded = 0;
  let skipped = 0;
  let after = "00000000-0000-0000-0000-000000000000";

  // Keyset pagination over the whole corpus. A fixed LIMIT would silently
  // stop indexing the oldest items once the corpus outgrew it, and nothing
  // would report the gap — routing would just quietly stop seeing them.
  for (;;) {
    const rows = await db.query(
      `SELECT i.id, i.name, i.description_stripped, i.project_id, i.workspace_id,
              i.sequence_id, p.identifier AS project_identifier, s.group AS state_group
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       LEFT JOIN states s ON s.id = i.state_id
       WHERE i.deleted_at IS NULL AND i.id > $1
       ORDER BY i.id
       LIMIT $2`,
      [after, PAGE_SIZE],
    );

    if (rows.rows.length === 0) break;
    after = String(rows.rows[rows.rows.length - 1].id);

    // One bulk lookup per page, so an unchanged corpus costs one Qdrant call
    // per page and no embedding calls at all.
    const stored = await retrievePayloads(rows.rows.map((row: any) => String(row.id)));

    const pending: { id: string; text: string; payload: Record<string, unknown> }[] = [];

    for (const row of rows.rows) {
      const text = buildIndexText(row);
      const hash = contentHash(text);

      if (stored.get(String(row.id))?.content_hash === hash) {
        skipped++;
        continue;
      }

      pending.push({
        id: String(row.id),
        text,
        payload: {
          entity_type: "work_item",
          issue_id: String(row.id),
          project_id: String(row.project_id),
          workspace_id: String(row.workspace_id),
          identifier: `${row.project_identifier}-${row.sequence_id}`,
          state_group: row.state_group || "",
          content_hash: hash,
        },
      });
    }

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const vectors = await embedBatch(batch.map((item) => item.text));

      await upsertPoints(
        batch.map((item, index) => ({
          id: item.id,
          vector: vectors[index]!,
          payload: item.payload,
        })),
      );
      embedded += batch.length;
    }
  }

  return { embedded, skipped };
}
```

Note: `EMBEDDING_DIRECT_URL` already ends in `/embed`, and the point id is the
issue UUID, so re-running the sync overwrites in place rather than duplicating.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/knowledge/__tests__/index-sync.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the real backfill end to end**

Run from `apps/mcp`:

```bash
npx tsx -e "import('./src/knowledge/index-sync.js').then(async m => console.log(await m.syncWorkItems()))"
```

Expected: `{ embedded: <~439>, skipped: 0 }` in roughly 50 seconds. Run it a second time; expected `{ embedded: 0, skipped: <same count> }`, proving the hash skip works. If the second run re-embeds everything, the skip logic is broken — fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/mcp/src/knowledge/index-sync.ts apps/mcp/src/knowledge/__tests__/index-sync.test.ts
git commit -m "feat(a2a): sync work items into the Qdrant index incrementally"
```

---

### Task 5: Workspace context snapshot

**Files:**
- Create: `apps/mcp/src/knowledge/context.ts`
- Test: `apps/mcp/src/knowledge/__tests__/context.test.ts`

**Interfaces:**
- Consumes: `TaskPilotClient` from `../tools/taskpilot-client.js`.
- Produces:
  - `type WorkspaceContext = { projects: ProjectSummary[]; rules: string }`
  - `type ProjectSummary = { id: string; name: string; identifier: string; description: string }`
  - `getWorkspaceContext(workspace: string, client: TaskPilotClient): Promise<WorkspaceContext>`
  - `formatProjectsForPrompt(projects: ProjectSummary[]): string`

- [ ] **Step 1: Write the failing test**

Create `apps/mcp/src/knowledge/__tests__/context.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatProjectsForPrompt, TASKPILOT_RULES } from "../context.js";

describe("formatProjectsForPrompt", () => {
  it("includes the identifier, name and full description of each project", () => {
    const text = formatProjectsForPrompt([
      {
        id: "p1",
        name: "Finance and Bills",
        identifier: "SUDIPTASCF",
        description: "all task related to finance will go here",
      },
    ]);

    expect(text).toContain("SUDIPTASCF");
    expect(text).toContain("Finance and Bills");
    // The description is the routing rule — it must reach the model intact.
    expect(text).toContain("all task related to finance will go here");
  });

  it("marks projects that have no description", () => {
    const text = formatProjectsForPrompt([
      { id: "p2", name: "RevatiCraft", identifier: "REVATICRAF", description: "" },
    ]);
    expect(text).toContain("(no description)");
  });
});

describe("TASKPILOT_RULES", () => {
  it("states the facts the agent gets wrong without them", () => {
    expect(TASKPILOT_RULES).toContain("no delete");
    expect(TASKPILOT_RULES).toContain("Intake");
    expect(TASKPILOT_RULES).not.toContain("Linear");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/knowledge/__tests__/context.test.ts`
Expected: FAIL — cannot resolve `../context.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/mcp/src/knowledge/context.ts`:

```typescript
import Redis from "ioredis";
import { config } from "../config.js";
import type { TaskPilotClient } from "../tools/taskpilot-client.js";

export interface ProjectSummary {
  id: string;
  name: string;
  identifier: string;
  description: string;
}

export interface WorkspaceContext {
  projects: ProjectSummary[];
  rules: string;
}

const CACHE_TTL_SECONDS = 300;

/**
 * Facts about TaskPilot itself that models otherwise invent. Cycles and
 * modules are deliberately called out as unused: both tables are empty.
 */
export const TASKPILOT_RULES = `TaskPilot facts you must not contradict:
- TaskPilot is its own product. It is not Linear, Jira, Asana or any other tool.
- There is no delete for work items. To remove one, cancel it.
- Cancelling requires human approval and may not take effect immediately.
- Uncertain items belong in Intake, not in a guessed project.
- Cycles and modules exist in the schema but are unused here — do not route to them.`;

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (!redis) {
    redis = new Redis(config.redisUrl, { lazyConnect: true });
    redis.connect().catch((err) => {
      console.warn("[context] Redis unavailable, running uncached:", err.message);
      redis = null;
    });
  }
  return redis;
}

export function formatProjectsForPrompt(projects: ProjectSummary[]): string {
  return projects
    .map(
      (project) =>
        `- id: ${project.id}\n  identifier: ${project.identifier}\n  name: ${project.name}\n  description: ${
          project.description || "(no description)"
        }`,
    )
    .join("\n");
}

export async function getWorkspaceContext(
  workspace: string,
  client: TaskPilotClient,
): Promise<WorkspaceContext> {
  const cacheKey = `mcp:ctx:${workspace}`;

  try {
    const cached = await getRedis()?.get(cacheKey);
    if (cached) {
      return { projects: JSON.parse(cached), rules: TASKPILOT_RULES };
    }
  } catch {
    // Cache read failures are not routing failures.
  }

  const raw = await client.listProjects();
  const projects: ProjectSummary[] = (raw || []).map((project: any) => ({
    id: String(project.id),
    name: project.name || "",
    identifier: project.identifier || "",
    description: project.description || "",
  }));

  try {
    await getRedis()?.set(cacheKey, JSON.stringify(projects), "EX", CACHE_TTL_SECONDS);
  } catch {
    // ignore
  }

  return { projects, rules: TASKPILOT_RULES };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/knowledge/__tests__/context.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/knowledge/context.ts apps/mcp/src/knowledge/__tests__/context.test.ts
git commit -m "feat(a2a): add cached workspace context with TaskPilot rules"
```

---

### Task 6: Confidence-scored router

**Files:**
- Create: `apps/mcp/src/routing/router.ts`
- Test: `apps/mcp/src/routing/__tests__/router.test.ts`

**Interfaces:**
- Consumes: `embed` (Task 2), `search` (Task 3), `getWorkspaceContext`/`formatProjectsForPrompt`/`ProjectSummary` (Task 5), `config.routeConfidenceThreshold` (Task 1).
- Produces:
  - `type RouteDecision = { projectId: string | null; confidence: number; reason: string; candidates: ProjectSummary[]; source: "hint" | "single" | "llm" | "neighbours" | "undecided" }`
  - `scoreNeighbours(hits: QdrantHit[]): Map<string, number>`
  - `matchHint(hint: string, projects: ProjectSummary[]): ProjectSummary | null`
  - `routeWorkItem(input: { workspace: string; title: string; description?: string; projectHint?: string }, client: TaskPilotClient): Promise<RouteDecision>`

- [ ] **Step 1: Write the failing test**

Create `apps/mcp/src/routing/__tests__/router.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scoreNeighbours, matchHint } from "../router.js";

const PROJECTS = [
  { id: "p1", name: "Finance and Bills", identifier: "SUDIPTASCF", description: "finance" },
  { id: "p2", name: "ProDevs", identifier: "PRODEVS", description: "developer platform" },
];

describe("matchHint", () => {
  it("matches on the exact identifier, case-insensitively", () => {
    expect(matchHint("sudiptascf", PROJECTS)?.id).toBe("p1");
  });

  it("matches on the project name", () => {
    expect(matchHint("ProDevs", PROJECTS)?.id).toBe("p2");
  });

  it("returns null when nothing matches, rather than a near-miss", () => {
    // A wrong hint must not silently route somewhere plausible.
    expect(matchHint("Marketing", PROJECTS)).toBeNull();
  });
});

describe("scoreNeighbours", () => {
  it("weights each project by the summed similarity of its neighbours", () => {
    const scores = scoreNeighbours([
      { id: "a", score: 0.9, payload: { project_id: "p1" } },
      { id: "b", score: 0.8, payload: { project_id: "p1" } },
      { id: "c", score: 0.5, payload: { project_id: "p2" } },
    ]);

    expect(scores.get("p1")).toBeCloseTo(1.7);
    expect(scores.get("p2")).toBeCloseTo(0.5);
  });

  it("ignores hits with no project payload", () => {
    const scores = scoreNeighbours([{ id: "a", score: 0.9, payload: {} }]);
    expect(scores.size).toBe(0);
  });

  it("returns an empty map for no hits", () => {
    expect(scoreNeighbours([]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/routing/__tests__/router.test.ts`
Expected: FAIL — cannot resolve `../router.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/mcp/src/routing/router.ts`:

```typescript
import OpenAI from "openai";
import { config } from "../config.js";
import { embed } from "../knowledge/embeddings.js";
import { search, type QdrantHit } from "../knowledge/qdrant.js";
import {
  getWorkspaceContext,
  formatProjectsForPrompt,
  type ProjectSummary,
} from "../knowledge/context.js";
import { getLlmConfig } from "../tools/smart-router.js";
import type { TaskPilotClient } from "../tools/taskpilot-client.js";

export interface RouteDecision {
  projectId: string | null;
  confidence: number;
  reason: string;
  candidates: ProjectSummary[];
  source: "hint" | "single" | "llm" | "neighbours" | "undecided";
}

const NEIGHBOUR_LIMIT = 20;

const ROUTING_SYSTEM_PROMPT = `You route work items to projects in TaskPilot.

You are given the projects (their descriptions are the routing rules, written by the
user), and the projects of the most similar existing work items as evidence.

Reply with ONLY a JSON object:
{"project_id": "<exact id from the list>", "confidence": <0.0-1.0>, "reason": "<one sentence>"}

Set confidence below 0.5 when the item could plausibly belong to more than one
project, or when no project's description covers it. Never invent a project id.
It is far better to be honestly unsure than to be confidently wrong.`;

export function matchHint(hint: string, projects: ProjectSummary[]): ProjectSummary | null {
  const needle = hint.trim().toLowerCase();
  if (!needle) return null;

  return (
    projects.find((project) => project.identifier.toLowerCase() === needle) ||
    projects.find((project) => project.name.toLowerCase() === needle) ||
    null
  );
}

/** Sum neighbour similarity per project — evidence, not a decision. */
export function scoreNeighbours(hits: QdrantHit[]): Map<string, number> {
  const scores = new Map<string, number>();

  for (const hit of hits) {
    const projectId = hit.payload?.project_id;
    if (!projectId) continue;
    scores.set(String(projectId), (scores.get(String(projectId)) || 0) + hit.score);
  }

  return scores;
}

function formatEvidence(scores: Map<string, number>, projects: ProjectSummary[]): string {
  if (scores.size === 0) return "No similar existing work items were found.";

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([projectId, score]) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      return `- ${project?.name || projectId} (id: ${projectId}) — summed similarity ${score.toFixed(2)}`;
    })
    .join("\n");
}

export async function routeWorkItem(
  input: { workspace: string; title: string; description?: string; projectHint?: string },
  client: TaskPilotClient,
): Promise<RouteDecision> {
  const { projects } = await getWorkspaceContext(input.workspace, client);

  if (projects.length === 0) {
    return {
      projectId: null,
      confidence: 0,
      reason: "The workspace has no projects to route into.",
      candidates: [],
      source: "undecided",
    };
  }

  if (input.projectHint) {
    const hinted = matchHint(input.projectHint, projects);
    if (hinted) {
      return {
        projectId: hinted.id,
        confidence: 1,
        reason: `Caller named project ${hinted.identifier}.`,
        candidates: projects,
        source: "hint",
      };
    }
  }

  if (projects.length === 1) {
    return {
      projectId: projects[0]!.id,
      confidence: 1,
      reason: "The workspace has exactly one project.",
      candidates: projects,
      source: "single",
    };
  }

  const text = input.description ? `${input.title}\n\n${input.description}` : input.title;

  let neighbourScores = new Map<string, number>();
  let degraded = false;

  try {
    const vector = await embed(text);
    const hits = await search(vector, {
      limit: NEIGHBOUR_LIMIT,
      filter: { must: [{ key: "entity_type", match: { value: "work_item" } }] },
    });
    neighbourScores = scoreNeighbours(hits);
  } catch (err: any) {
    // Vector search is evidence, not the decision. Losing it lowers our
    // ceiling rather than stopping us.
    console.warn(`[router] Vector search unavailable: ${err.message}`);
    degraded = true;
  }

  try {
    const llmConfig = await getLlmConfig();
    if (!llmConfig.apiKey) throw new Error("No LLM API key configured");

    const llm = new OpenAI({ baseURL: llmConfig.baseUrl, apiKey: llmConfig.apiKey });
    const response = await llm.chat.completions.create({
      model: llmConfig.model,
      messages: [
        { role: "system", content: ROUTING_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Projects:\n${formatProjectsForPrompt(projects)}\n\nEvidence from similar existing work items:\n${formatEvidence(
            neighbourScores,
            projects,
          )}\n\nWork item:\n${text}`,
        },
      ],
      temperature: 0,
      max_tokens: 512,
    });

    const raw = response.choices[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim());

    const chosen = projects.find((project) => project.id === parsed.project_id);
    if (!chosen) throw new Error(`LLM returned unknown project id "${parsed.project_id}"`);

    // Without neighbour evidence we cap what the model is allowed to claim,
    // so a degraded run lands in Intake instead of being trusted.
    const ceiling = degraded ? config.routeConfidenceThreshold - 0.01 : 1;
    const confidence = Math.min(Number(parsed.confidence) || 0, ceiling);

    return {
      projectId: confidence >= config.routeConfidenceThreshold ? chosen.id : null,
      confidence,
      reason: String(parsed.reason || ""),
      candidates: projects,
      source: confidence >= config.routeConfidenceThreshold ? "llm" : "undecided",
    };
  } catch (err: any) {
    console.warn(`[router] LLM routing failed: ${err.message}`);
  }

  // No LLM. Neighbours alone decide only if they are overwhelming.
  const ranked = [...neighbourScores.entries()].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top && (!second || top[1] > second[1] * 2)) {
    return {
      projectId: top[0],
      confidence: config.routeConfidenceThreshold,
      reason: "Chosen from similar existing work items; the LLM was unavailable.",
      candidates: projects,
      source: "neighbours",
    };
  }

  return {
    projectId: null,
    confidence: 0,
    reason: "No project matched with enough confidence to file this automatically.",
    candidates: projects,
    source: "undecided",
  };
}
```

**Note:** this imports `getLlmConfig` from `smart-router.ts`, which is currently module-private. Change its declaration there from `async function getLlmConfig()` to `export async function getLlmConfig()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/routing/__tests__/router.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/routing/router.ts apps/mcp/src/routing/__tests__/router.test.ts apps/mcp/src/tools/smart-router.ts
git commit -m "feat(a2a): add confidence-scored project router"
```

---

### Task 7: Delete the silent fallback and wire routing into create_task

**Files:**
- Modify: `apps/mcp/src/tools/smart-router.ts:124-240` (replace `routeTask`)
- Modify: `apps/mcp/src/tools/handlers.ts:380-394` (`handleCreateTask`)
- Modify: `apps/mcp/src/tools/taskpilot-client.ts` (add `createIntakeIssue`)
- Test: `apps/mcp/src/tools/__tests__/handlers.test.ts` (extend)

**Interfaces:**
- Consumes: `routeWorkItem`, `RouteDecision` (Task 6); `config.intakeProjects` (Task 1).
- Produces: `TaskPilotClient.createIntakeIssue(projectId: string, issue: { name: string; description_html?: string; priority?: string }): Promise<any>`. `handleCreateTask` returns `{ identifier, id, project, title, routing: { confidence, reason, source } }` on success, or `{ status: "undecided", reason, candidates }` when nothing could be filed.

- [ ] **Step 1: Write the failing test**

Append to `apps/mcp/src/tools/__tests__/handlers.test.ts`:

```typescript
import { resolveIntakeProject } from "../handlers.js";

describe("resolveIntakeProject", () => {
  const projects = [
    { id: "p1", name: "Finance and Bills", identifier: "SUDIPTASCF", description: "" },
    { id: "p2", name: "ProDevs", identifier: "PRODEVS", description: "" },
  ];

  it("finds the configured intake project for the workspace", () => {
    const configured = new Map([["for-ai", "SUDIPTASCF"]]);
    expect(resolveIntakeProject("for-ai", projects, configured)).toBe("p1");
  });

  it("returns null when the workspace has no configured intake project", () => {
    // Nothing configured must mean nothing written — never a guessed project.
    expect(resolveIntakeProject("meetecho", projects, new Map())).toBeNull();
  });

  it("returns null when the configured identifier does not exist", () => {
    const configured = new Map([["for-ai", "NOSUCHPROJ"]]);
    expect(resolveIntakeProject("for-ai", projects, configured)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/tools/__tests__/handlers.test.ts`
Expected: FAIL — `resolveIntakeProject` is not exported from `../handlers.js`.

- [ ] **Step 3: Add the intake API method**

In `apps/mcp/src/tools/taskpilot-client.ts`, add after the `createIssue` method:

```typescript
  // --- Intake ---
  /** File into the project's intake queue. Wire shape: { issue: {...} }. */
  async createIntakeIssue(
    projectId: string,
    issue: { name: string; description_html?: string; priority?: string },
  ): Promise<any> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/intake-issues/`,
      { issue },
    );
  }
```

- [ ] **Step 4: Replace routeTask with a delegating shim**

In `apps/mcp/src/tools/smart-router.ts`, delete the entire body of `routeTask` (lines 124-240, including the keyword-scoring fallback, the `STOP_WORDS` set, and the cache helpers `getCachedProject`/`setCachedProject`) and replace with:

```typescript
/**
 * Deprecated: use routeWorkItem from ../routing/router.js, which returns a
 * confidence score instead of always producing a project id. Kept only so
 * existing callers keep compiling; it throws rather than guessing.
 */
export async function routeTask(): Promise<never> {
  throw new Error("routeTask has been replaced by routeWorkItem; update the caller");
}
```

Keep `getLlmConfig`, `decryptInstanceValue` and the LLM config cache — Task 6 imports them.

Remove the now-unused `Redis`, `crypto` and `TaskPilotClient` imports if the compiler flags them.

- [ ] **Step 5: Rewrite handleCreateTask**

In `apps/mcp/src/tools/handlers.ts`, replace `handleCreateTask` (lines 380-394) with:

```typescript
/** Resolve the configured intake project for a workspace, or null. */
export function resolveIntakeProject(
  workspace: string,
  projects: { id: string; identifier: string }[],
  configured: Map<string, string>,
): string | null {
  const identifier = configured.get(workspace);
  if (!identifier) return null;

  const project = projects.find(
    (candidate) => candidate.identifier.toLowerCase() === identifier.toLowerCase(),
  );
  return project ? project.id : null;
}

async function handleCreateTask(args: any, client: TaskPilotClient, workspace: string) {
  const decision = await routeWorkItem(
    {
      workspace,
      title: args.title,
      description: args.description,
      projectHint: args.project_hint,
    },
    client,
  );

  const data: any = { name: args.title };
  if (args.description) data.description_html = `<p>${args.description}</p>`;
  if (args.priority) data.priority = args.priority;

  if (decision.projectId) {
    const project = decision.candidates.find((candidate) => candidate.id === decision.projectId);
    const issue = await client.createIssue(decision.projectId, data);

    return {
      identifier: `${project?.identifier || "?"}-${issue.sequence_id || "?"}`,
      id: issue.id,
      project: project?.name || "",
      title: issue.name,
      routing: {
        confidence: decision.confidence,
        reason: decision.reason,
        source: decision.source,
      },
    };
  }

  // Not confident. File into Intake if one is configured for this workspace.
  const intakeProjectId = resolveIntakeProject(
    workspace,
    decision.candidates,
    config.intakeProjects,
  );

  if (intakeProjectId) {
    const intake = await client.createIntakeIssue(intakeProjectId, {
      name: args.title,
      description_html: data.description_html,
      priority: args.priority,
    });

    return {
      status: "filed_to_intake",
      id: intake?.issue?.id || intake?.id,
      reason: decision.reason,
      candidates: decision.candidates.map((candidate) => candidate.identifier),
    };
  }

  // Nothing configured and not confident: write nothing, and say why.
  return {
    status: "undecided",
    reason: decision.reason,
    candidates: decision.candidates.map((candidate) => candidate.identifier),
    hint: "Pass project_hint, or set A2A_INTAKE_PROJECTS so uncertain items have a home.",
  };
}
```

Add the imports at the top of `handlers.ts`:

```typescript
import { routeWorkItem } from "../routing/router.js";
```

`config` is already imported at line 5.

- [ ] **Step 6: Run the full suite**

Run: `cd apps/mcp && npx tsc --noEmit && npx vitest run`
Expected: tsc exits 0; all tests pass, including the 3 new `resolveIntakeProject` tests.

- [ ] **Step 7: Commit**

```bash
git add apps/mcp/src/tools/ apps/mcp/src/routing/
git commit -m "feat(a2a): route new tasks by confidence, file uncertain ones to intake

Deletes the 'no match, use the first project' fallback that silently
misfiled work items."
```

---

### Task 8: Duplicate detection

**Files:**
- Create: `apps/mcp/src/routing/dedupe.ts`
- Test: `apps/mcp/src/routing/__tests__/dedupe.test.ts`

**Interfaces:**
- Consumes: `embed` (Task 2), `search` (Task 3), `config.dedupeSimilarityThreshold` (Task 1).
- Produces:
  - `type DuplicateMatch = { issueId: string; identifier: string; score: number } | null`
  - `pickDuplicate(hits: QdrantHit[], threshold: number): DuplicateMatch`
  - `findDuplicate(text: string, opts: { projectId?: string }): Promise<DuplicateMatch>`

- [ ] **Step 1: Write the failing test**

Create `apps/mcp/src/routing/__tests__/dedupe.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { pickDuplicate } from "../dedupe.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/routing/__tests__/dedupe.test.ts`
Expected: FAIL — cannot resolve `../dedupe.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/mcp/src/routing/dedupe.ts`:

```typescript
import { config } from "../config.js";
import { embed } from "../knowledge/embeddings.js";
import { search, type QdrantHit } from "../knowledge/qdrant.js";

export interface DuplicateMatch {
  issueId: string;
  identifier: string;
  score: number;
}

const CANDIDATE_LIMIT = 10;

export function pickDuplicate(hits: QdrantHit[], threshold: number): DuplicateMatch | null {
  const best = hits
    .filter((hit) => hit.payload?.issue_id)
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score < threshold) return null;

  return {
    issueId: String(best.payload.issue_id),
    identifier: String(best.payload.identifier || ""),
    score: best.score,
  };
}

/**
 * Find an existing work item that this text duplicates. Returns null on any
 * failure — a missed duplicate is a far smaller problem than a false match.
 */
export async function findDuplicate(
  text: string,
  opts: { projectId?: string } = {},
): Promise<DuplicateMatch | null> {
  try {
    const vector = await embed(text);
    const must: Record<string, unknown>[] = [
      { key: "entity_type", match: { value: "work_item" } },
    ];
    if (opts.projectId) {
      must.push({ key: "project_id", match: { value: opts.projectId } });
    }

    const hits = await search(vector, { limit: CANDIDATE_LIMIT, filter: { must } });
    return pickDuplicate(hits, config.dedupeSimilarityThreshold);
  } catch (err: any) {
    console.warn(`[dedupe] Skipped duplicate check: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/routing/__tests__/dedupe.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Surface duplicates in create_task**

In `handleCreateTask` (Task 7), immediately before `const issue = await client.createIssue(...)`, add:

```typescript
    const duplicate = await findDuplicate(
      args.description ? `${args.title}\n\n${args.description}` : args.title,
      { projectId: decision.projectId },
    );

    if (duplicate && !args.force_create) {
      return {
        status: "possible_duplicate",
        duplicate_of: duplicate.identifier,
        score: duplicate.score,
        hint: "Comment on the existing item, or pass force_create: true to file anyway.",
      };
    }
```

Add the import to `handlers.ts`:

```typescript
import { findDuplicate } from "../routing/dedupe.js";
```

Add `force_create` to the `create_task` tool definition's `inputSchema.properties` at `apps/mcp/src/tools/handlers.ts:105`:

```typescript
        force_create: {
          type: "boolean",
          description: "Create even if a near-duplicate exists. Default false.",
        },
```

- [ ] **Step 6: Run the full suite**

Run: `cd apps/mcp && npx tsc --noEmit && npx vitest run`
Expected: tsc exits 0; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/mcp/src/routing/ apps/mcp/src/tools/handlers.ts
git commit -m "feat(a2a): detect near-duplicate work items before creating"
```

---

### Task 9: Background sync and embedding keepalive

**Files:**
- Modify: `apps/mcp/src/a2a/background.ts` (append two exported functions)
- Modify: `apps/mcp/src/index.ts:81-83`

**Interfaces:**
- Consumes: `syncWorkItems` (Task 4), `embed` (Task 2).
- Produces: `syncKnowledgeIndex(): Promise<void>`, `keepEmbedderWarm(): Promise<void>`.

- [ ] **Step 1: Add the background functions**

Append to `apps/mcp/src/a2a/background.ts`:

```typescript
/**
 * Keep the work-item index current. Incremental by content hash, so a run
 * with no changes costs one Qdrant lookup and no embedding calls.
 */
export async function syncKnowledgeIndex() {
  if (!config.qdrantUrl || !config.embeddingUrl) return;

  try {
    const { embedded, skipped } = await syncWorkItems();
    if (embedded > 0) {
      console.log(`[knowledge] Indexed ${embedded} work items (${skipped} unchanged)`);
    }
  } catch (err: any) {
    console.warn(`[knowledge] Index sync failed: ${err.message}`);
  }
}

/**
 * The embedding server unloads the model after 300s idle and takes ~10.5s to
 * reload. A cheap embed every few minutes keeps it resident.
 */
export async function keepEmbedderWarm() {
  if (!config.embeddingUrl) return;

  try {
    await embed("keepalive");
  } catch (err: any) {
    console.warn(`[knowledge] Keepalive failed: ${err.message}`);
  }
}
```

Add the imports at the top of `background.ts`:

```typescript
import { syncWorkItems } from "../knowledge/index-sync.js";
import { embed } from "../knowledge/embeddings.js";
```

- [ ] **Step 2: Schedule them**

In `apps/mcp/src/index.ts`, extend the import at line 5:

```typescript
import { pollHitlDecisions, retryWebhooks, cleanupOldData, syncKnowledgeIndex, keepEmbedderWarm } from "./a2a/background.js";
```

And after the existing `setInterval` calls at lines 81-82:

```typescript
    // Keep the model resident: it unloads after 300s idle.
    setInterval(keepEmbedderWarm, 4 * 60 * 1000);
    setInterval(syncKnowledgeIndex, 10 * 60 * 1000);
    // First index build, after the server is already accepting requests.
    void syncKnowledgeIndex();
```

- [ ] **Step 3: Verify it compiles and the suite still passes**

Run: `cd apps/mcp && npx tsc --noEmit && npx vitest run`
Expected: tsc exits 0; all tests pass.

- [ ] **Step 4: Verify the keepalive works against the real server**

Run:

```bash
curl -s -m 8 http://nuc.lan:18081/info
```

Expected: `"model_loaded": true` while the MCP server is running. Wait 6 minutes with the server up and check again — it must still be `true`. If it is `false`, the interval is not firing.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/background.ts apps/mcp/src/index.ts
git commit -m "feat(a2a): sync the knowledge index and keep the embedder warm"
```

---

### Task 10: Routing eval against the existing corpus

**Files:**
- Create: `apps/mcp/scripts/eval-routing.ts`

**Interfaces:**
- Consumes: `routeWorkItem` (Task 6), `db`, `TaskPilotClient`/`getOrCreateApiToken`.
- Produces: a report on stdout. Not imported by application code.

This is the task that turns "no mistakes" into a number. It replays real work items whose project is known and reports how often the router agrees.

- [ ] **Step 1: Write the script**

Create `apps/mcp/scripts/eval-routing.ts`:

```typescript
/**
 * Replay existing work items through the router and report accuracy.
 *
 * Every work item's current project is ground truth, so this measures the
 * router against reality rather than against our expectations.
 *
 * Usage: npx tsx scripts/eval-routing.ts <workspace-slug> [sample-size]
 */
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { routeWorkItem } from "../src/routing/router.js";
import { TaskPilotClient, getOrCreateApiToken } from "../src/tools/taskpilot-client.js";

const workspace = process.argv[2];
const sampleSize = parseInt(process.argv[3] || "100", 10);

if (!workspace) {
  console.error("Usage: npx tsx scripts/eval-routing.ts <workspace-slug> [sample-size]");
  process.exit(1);
}

async function main() {
  const ws = await db.query(`SELECT id FROM workspaces WHERE slug = $1`, [workspace]);
  if (ws.rows.length === 0) throw new Error(`No such workspace: ${workspace}`);

  const owner = await db.query(
    `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
    [ws.rows[0].id],
  );
  const token = await getOrCreateApiToken(owner.rows[0].user_id, workspace);
  const client = new TaskPilotClient(workspace, token);

  const items = await db.query(
    `SELECT i.name, i.description_stripped, i.project_id, p.identifier
     FROM issues i
     JOIN projects p ON p.id = i.project_id
     WHERE i.deleted_at IS NULL AND i.workspace_id = $1
     ORDER BY random()
     LIMIT $2`,
    [ws.rows[0].id, sampleSize],
  );

  let correct = 0;
  let wrong = 0;
  let undecided = 0;
  const misroutes: string[] = [];

  for (const item of items.rows) {
    const decision = await routeWorkItem(
      {
        workspace,
        title: item.name,
        description: item.description_stripped || undefined,
      },
      client,
    );

    if (!decision.projectId) {
      undecided++;
    } else if (decision.projectId === String(item.project_id)) {
      correct++;
    } else {
      wrong++;
      misroutes.push(
        `  "${item.name.slice(0, 60)}" → expected ${item.identifier}, got ${decision.projectId} (conf ${decision.confidence.toFixed(2)}): ${decision.reason}`,
      );
    }
  }

  const total = items.rows.length;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

  console.log(`\nRouting eval — ${workspace}, ${total} items, threshold ${config.routeConfidenceThreshold}`);
  console.log(`  correct:   ${correct} (${pct(correct)})`);
  console.log(`  MISROUTED: ${wrong} (${pct(wrong)})   <- the number that must approach zero`);
  console.log(`  undecided: ${undecided} (${pct(undecided)})   <- safe: these go to Intake`);

  if (misroutes.length > 0) {
    console.log(`\nMisroutes:\n${misroutes.join("\n")}`);
  }

  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the eval**

Run from `apps/mcp`:

```bash
npx tsx scripts/eval-routing.ts for-ai 100
```

Expected: a report. `for-ai` holds 432 of the 439 work items across 8 projects, so it is the meaningful corpus.

Record the three numbers in the commit message. **Misrouted is the number that matters** — undecided items are safe by design, because they go to Intake rather than to a wrong project.

- [ ] **Step 3: Tune the threshold**

If misrouted is above ~2%, raise `A2A_ROUTE_CONFIDENCE` in `.env` (try 0.8, then 0.85) and re-run. Higher thresholds trade undecided-rate for misroute-rate, which is the trade we want. Record the chosen value and the numbers that justified it.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/scripts/eval-routing.ts
git commit -m "test(a2a): add routing eval against the existing work-item corpus

Baseline at threshold <X>: <correct>% correct, <wrong>% misrouted,
<undecided>% undecided over <N> items in for-ai."
```

---

## Definition of done

- `npx tsc --noEmit` exits 0 and `npx vitest run` passes in `apps/mcp`.
- `grep -rn "using first project" apps/mcp/src` returns nothing.
- `.env` ↔ `.env.example` key parity holds (the diff in Task 1 Step 6 is empty).
- The eval reports a misroute rate you have accepted, at a recorded threshold.
- A second run of `syncWorkItems()` embeds nothing and skips everything.
