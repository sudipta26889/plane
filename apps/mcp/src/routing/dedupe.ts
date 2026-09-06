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
 *
 * `taskpilot_vector_db` is one Qdrant collection shared by every workspace on
 * this instance, so `projectIds` (the caller's own candidate projects, e.g.
 * `routeWorkItem`'s `candidates`) is required rather than optional: without
 * it there is no way to keep a search from returning a "duplicate" that
 * actually belongs to a different tenant. Mirrors the `{ any: [...] }` scope
 * filter `routeWorkItem` already applies in `router.ts`.
 */
export async function findDuplicate(
  text: string,
  opts: { projectIds: string[] },
): Promise<DuplicateMatch | null> {
  if (opts.projectIds.length === 0) return null;

  try {
    const vector = await embed(text);
    const hits = await search(vector, {
      limit: CANDIDATE_LIMIT,
      filter: {
        must: [
          { key: "entity_type", match: { value: "work_item" } },
          { key: "project_id", match: { any: opts.projectIds } },
        ],
      },
    });
    return pickDuplicate(hits, config.dedupeSimilarityThreshold);
  } catch (err: any) {
    console.warn(`[dedupe] Skipped duplicate check: ${err.message}`);
    return null;
  }
}
