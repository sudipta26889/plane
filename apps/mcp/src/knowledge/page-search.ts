import { embed } from "./embeddings.js";
import { search, type QdrantHit } from "./qdrant.js";

/**
 * Semantic search over pages.
 *
 * `page_list` can only page through names in creation order, so finding a page
 * by what it is *about* was impossible — the agent could reach 5,908 pages only
 * by walking them. This searches the same index the router uses, scoped the
 * same way.
 */

export interface PageMatch {
  page_id: string;
  project_id: string;
  name: string;
  source: string;
  score: number;
}

const CANDIDATE_LIMIT = 20;

/** Shape hits into matches, dropping anything without the id we need to act on. */
export function toPageMatches(hits: QdrantHit[], limit: number): PageMatch[] {
  return hits
    .filter((hit) => hit.payload?.page_id)
    .slice(0, limit)
    .map((hit) => ({
      page_id: String(hit.payload.page_id),
      project_id: String(hit.payload.project_id ?? ""),
      name: String(hit.payload.name ?? ""),
      source: String(hit.payload.source ?? "local"),
      score: hit.score,
    }));
}

/**
 * Find pages matching a query, restricted to the caller's own projects.
 *
 * `projectIds` is required, not optional: taskpilot_vector_db is one collection
 * shared by every workspace on this instance, so an unscoped search would
 * return another tenant's pages. An empty list short-circuits rather than
 * searching everything.
 */
export async function searchPages(
  query: string,
  opts: { projectIds: string[]; limit?: number },
): Promise<PageMatch[]> {
  if (!query.trim() || opts.projectIds.length === 0) return [];

  const vector = await embed(query);
  const hits = await search(vector, {
    limit: CANDIDATE_LIMIT,
    filter: {
      must: [
        { key: "entity_type", match: { value: "page" } },
        { key: "project_id", match: { any: opts.projectIds } },
      ],
    },
  });

  return toPageMatches(hits, opts.limit ?? 10);
}
