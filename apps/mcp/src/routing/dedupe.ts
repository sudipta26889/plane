import { config } from "../config.js";
import { embed } from "../knowledge/embeddings.js";
import { search, type QdrantHit } from "../knowledge/qdrant.js";
import { buildIndexText } from "../knowledge/index-sync.js";
import { db } from "../db.js";
import { askJev, decide, JevUncertainError } from "../decisions/jev.js";

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
// Inbox's cold-email bands: between these Jev is unsure and the threshold decides.
const MIN_DUPLICATE_PROBABILITY = 0.75;
const MAX_DISTINCT_PROBABILITY = 0.25;

async function isDuplicateByJev(text: string, nearest: QdrantHit): Promise<DuplicateMatch | null> {
  const existing = await db.query(`SELECT name, description_stripped FROM issues WHERE id = $1`, [nearest.payload.issue_id]);
  if (existing.rows.length === 0) throw new Error("Nearest work item no longer exists");

  const answers = await askJev(
    { new_item: text, existing_item: buildIndexText(existing.rows[0]) },
    {
      duplicate: {
        type: "noul",
        instructions: "Is `new_item` the same piece of work as `existing_item`, so that filing it would create a duplicate?",
        criteria: {
          true: "Both describe the same task; doing one would complete the other.",
          false: "They are different tasks, even if they share a topic, project or workstream.",
        },
      },
    },
  );

  const answer = answers.duplicate;
  if (answer?.type !== "noul") throw new Error("Jev response is missing the duplicate answer");
  if (answer.noul > MAX_DISTINCT_PROBABILITY && answer.noul < MIN_DUPLICATE_PROBABILITY) {
    throw new JevUncertainError(`Jev duplicate probability ${answer.noul.toFixed(2)} is inside the uncertain band`);
  }
  return answer.noul >= MIN_DUPLICATE_PROBABILITY
    ? { issueId: String(nearest.payload.issue_id), identifier: String(nearest.payload.identifier || ""), score: nearest.score }
    : null;
}

export async function findDuplicate(
  text: string,
  opts: { projectIds: string[]; vector?: number[] },
): Promise<DuplicateMatch | null> {
  if (opts.projectIds.length === 0) return null;

  try {
    // Reuse the router's embedding when the caller already has one for this
    // exact text; embedding is the expensive step on a CPU-only server.
    const vector = opts.vector ?? (await embed(text));
    const hits = await search(vector, {
      limit: CANDIDATE_LIMIT,
      // Deliberately WITHOUT the router's must_not on triage: an item parked in
      // Intake is still a real item you should not duplicate, even though it is
      // not evidence about where work belongs. The two searches want opposite
      // things from the same rows.
      filter: {
        must: [
          { key: "entity_type", match: { value: "work_item" } },
          { key: "project_id", match: { any: opts.projectIds } },
        ],
      },
    });
    const nearest = hits.find((hit) => hit.payload?.issue_id);
    const byThreshold = async () => pickDuplicate(hits, config.dedupeSimilarityThreshold);
    if (!nearest) return byThreshold();

    // The similarity threshold is the incumbent decider here, not an LLM; Jev
    // shadows it on the nearest candidate.
    return await decide({
      feature: "dedupe",
      subject: text.slice(0, 255),
      jev: () => isDuplicateByJev(text, nearest),
      fallback: byThreshold,
      same: (jev, threshold) => (jev?.issueId ?? null) === (threshold?.issueId ?? null),
    });
  } catch (err: any) {
    console.warn(`[dedupe] Skipped duplicate check: ${err.message}`);
    return null;
  }
}
