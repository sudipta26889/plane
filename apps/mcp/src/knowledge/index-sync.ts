import crypto from "node:crypto";
import { db } from "../db.js";
import { embedBatch } from "./embeddings.js";
import { ensureCollection, upsertPoints, retrievePayloads } from "./qdrant.js";

// Bounds one item's contribution to a batch. Throughput is char-bound
// (~1750 chars/sec warm on CPU), so an untrimmed 10k-char description would
// cost as much as six average items on its own.
const MAX_INDEX_CHARS = 4096;

// Measured on real work items (avg ~1018 chars): ~1750 chars/sec warm, so 32
// items is ~19s. The earlier 64 came from a benchmark of 60-char strings and
// was ~37s warm — which blew the timeout as soon as a cold start landed on top.
const BATCH_SIZE = 32;

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
  //
  // The cursor is per-run: a mid-sync failure restarts from the beginning next
  // tick rather than resuming. That is deliberate — the hash skip makes the
  // re-scan cost one Qdrant lookup per page and no embedding calls.
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
