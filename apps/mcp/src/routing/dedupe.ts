import { config } from "../config.js";
import { embed } from "../knowledge/embeddings.js";
import { search, type QdrantHit } from "../knowledge/qdrant.js";
import { buildIndexText } from "../knowledge/index-sync.js";
import { db } from "../db.js";
import { askJev, decide, type JevSink, type Question } from "../decisions/jev.js";

export interface DuplicateMatch {
  issueId: string;
  identifier: string;
  score: number;
  /** Jev's probability that this is the same work, when Jev judged it. */
  probability?: number;
  /** The existing item's state group ("completed", "started", ...). */
  stateGroup?: string;
}

/**
 * The outcome of a duplicate check. `skipped` says the check could not run,
 * which is different from "no duplicate": failing open silently let a
 * week-long embedder outage file every repeat alert as new work.
 */
export interface DuplicateCheck {
  match: DuplicateMatch | null;
  skipped?: string;
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
    stateGroup: String(best.payload.state_group || ""),
  };
}

/**
 * Find an existing work item that this text duplicates. Returns null on any
 * failure — a missed duplicate is a far smaller problem than a false match.
 *
 * The vector collection (QDRANT_COLLECTION_NAME) is one Qdrant collection shared by every workspace on
 * this instance, so `projectIds` (the caller's own candidate projects, e.g.
 * `routeWorkItem`'s `candidates`) is required rather than optional: without
 * it there is no way to keep a search from returning a "duplicate" that
 * actually belongs to a different tenant. Mirrors the `{ any: [...] }` scope
 * filter `routeWorkItem` already applies in `router.ts`.
 */
// Two stages, measured on 143 hand-labelled real pairs (2026-10-12):
// similarity alone cannot tell "the same task filed twice" from "the next
// quarter's filing of the same form" or "gap fix 3 vs gap fix 2" — at any
// cutoff it blocked real work (0.945: precision 0.94, 5 false blocks). So
// similarity only RECALLS candidates (>= 0.90 caught every true duplicate),
// and Jev JUDGES them: p >= 0.5 gave precision 1.00, recall 0.85.
const RECALL_SIMILARITY = 0.9;
const MAX_JUDGED = 3;
const DUPLICATE_PROBABILITY = 0.5;

async function judgeWithJev(text: string, candidates: QdrantHit[], sink: JevSink): Promise<DuplicateMatch | null> {
  const ids = candidates.map((hit) => String(hit.payload.issue_id));
  const rows = await db.query(`SELECT id::text, name, description_stripped FROM issues WHERE id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.rows.map((row: any) => [row.id, row]));
  const judged = candidates.filter((hit) => byId.has(String(hit.payload.issue_id)));
  if (judged.length === 0) return null;

  const question = (index: number): Question => ({
    type: "noul",
    // "Same piece of work" alone read a recurring alert as a new event: 96
    // daily "[Paperclip Health] ... at <time>" tickets for one outage were
    // judged distinct. Naming the repeat-report case lifted recall on the 143
    // labelled pairs from 0.907 to 1.000 at precision 1.000; the false side
    // names what must stay separate (next quarter's filing, gap fix 3 vs 2).
    instructions: `Would filing \`new_item\` duplicate \`existing_items[${index}]\`: the same task filed twice, or another report of the same ongoing problem that it already tracks?`,
    criteria: {
      true: "The same task, or a repeat report of the same unresolved problem (the same failure seen again at a later time); resolving the existing item resolves the new one.",
      false: "Separate work that must be done on its own: a different period, quarter, phase, number, component or sub-task, even when the wording is almost identical.",
    },
  });
  const answers = await askJev(
    {
      new_item: text,
      existing_items: judged.map((hit) => buildIndexText(byId.get(String(hit.payload.issue_id)))),
    },
    Object.fromEntries(judged.map((_, index) => [`duplicate_${index}`, question(index)])),
    sink,
  );

  let best: { hit: QdrantHit; p: number } | null = null;
  judged.forEach((hit, index) => {
    const answer = answers[`duplicate_${index}`];
    if (answer?.type !== "noul") throw new Error("Jev response is missing a duplicate answer");
    if (answer.noul >= DUPLICATE_PROBABILITY && (!best || answer.noul > best.p)) best = { hit, p: answer.noul };
  });
  if (!best) return null;
  const { hit, p } = best as { hit: QdrantHit; p: number };
  return {
    issueId: String(hit.payload.issue_id),
    identifier: String(hit.payload.identifier || ""),
    score: hit.score,
    probability: p,
    stateGroup: String(hit.payload.state_group || ""),
  };
}

export async function findDuplicate(
  text: string,
  opts: { projectIds: string[]; vector?: number[] },
): Promise<DuplicateCheck> {
  if (opts.projectIds.length === 0) return { match: null, skipped: "no project to search" };

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
        // A cancelled item is work someone decided not to do; filing it again
        // is not a duplicate. Several are known misfilings, too.
        must_not: [{ key: "state_group", match: { value: "cancelled" } }],
      },
    });
    const byThreshold = async () => pickDuplicate(hits, config.dedupeSimilarityThreshold);
    const candidates = hits.filter((hit) => hit.payload?.issue_id && hit.score >= RECALL_SIMILARITY).slice(0, MAX_JUDGED);
    if (candidates.length === 0) return { match: null };

    // The similarity threshold is the incumbent: it decides when Jev is off,
    // shadowed, or fails.
    const match = await decide({
      feature: "dedupe",
      subject: text.slice(0, 255),
      jev: (sink) => judgeWithJev(text, candidates, sink),
      fallback: byThreshold,
      same: (jev, threshold) => (jev?.issueId ?? null) === (threshold?.issueId ?? null),
    });
    return { match };
  } catch (err: any) {
    console.warn(`[dedupe] Skipped duplicate check: ${err.message}`);
    return { match: null, skipped: String(err.message).slice(0, 200) };
  }
}
