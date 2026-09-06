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

You are given two things: the projects with their descriptions, and a summary of
where the most similar EXISTING work items are actually filed.

The filing evidence outranks the descriptions. Descriptions are short, often
stale, and rarely describe everything a project has come to hold — a project
described as being about one topic is frequently where all of a product's work
lives, engineering included. The evidence shows what the user actually does.
When the two disagree, follow the evidence.

Only prefer a description over the evidence when the item plainly belongs to a
project that has no similar items yet.

Reply with ONLY a JSON object:
{"project_id": "<exact id from the list>", "confidence": <0.0-1.0>, "reason": "<one sentence>"}

Set confidence below 0.5 when the evidence is split, or when neither the
evidence nor any description covers the item. Never invent a project id. It is
far better to be honestly unsure than to be confidently wrong.

Keep "reason" under 15 words. A long reason risks the reply being truncated,
which throws the whole routing decision away.`;

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

/** Count hits per project — same truthy-`project_id` predicate as `scoreNeighbours`. */
export function countHitsByProject(hits: QdrantHit[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const hit of hits) {
    const projectId = hit.payload?.project_id;
    if (!projectId) continue;
    counts.set(String(projectId), (counts.get(String(projectId)) || 0) + 1);
  }

  return counts;
}

// Measured against the live index: genuine neighbours score 0.60-0.93, while a
// deliberately unrelated query tops out at ~0.35. 0.55 sits between the two.
// Without this, `share` alone reports relative dominance as confidence — two
// weak hits in the only project with any history would score 1.0.
const MIN_NEIGHBOUR_SIMILARITY = 0.55;

/**
 * Decide from neighbour evidence alone, used only when the LLM is unavailable.
 * Confidence is the share of total similarity mass held by the winning project,
 * so it reflects the evidence instead of being asserted. A lone weak hit is not
 * evidence: the winning project itself must be corroborated by at least two
 * of its own neighbours — being counted against every other project's hits
 * would make that check nearly a no-op. Nor is being uncontested: `share` is
 * relative dominance, not evidentiary strength, so the winner's own average
 * score per hit must also clear an absolute floor.
 *
 * Similarity here is Cosine, which ranges over [-1, 1]: a negative score is
 * evidence against a project, not weak evidence for it, so it must not be
 * allowed to shrink the denominator and inflate another project's share.
 */
export function decideFromNeighbours(
  scores: Map<string, number>,
  threshold: number,
  hitsByProject: Map<string, number>,
): { projectId: string; confidence: number } | null {
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [top] = ranked;
  if (!top) return null;

  const [topProjectId, topScore] = top;
  const winnerHitCount = hitsByProject.get(topProjectId) || 0;
  if (winnerHitCount < 2) return null;

  const total = ranked.reduce((sum, [, score]) => sum + Math.max(score, 0), 0);
  if (total <= 0) return null;

  // `share` below measures relative dominance, not evidentiary strength: a
  // lone weak winner in an otherwise-empty field would still take 100% of
  // the share. Require the winner's own average score per hit to clear an
  // absolute floor too.
  if (topScore / winnerHitCount < MIN_NEIGHBOUR_SIMILARITY) return null;

  const share = Math.min(Math.max(topScore, 0) / total, 1);
  if (share < threshold) return null;

  return { projectId: topProjectId, confidence: share };
}

/**
 * Describe where similar work already lives, in terms a model will actually
 * weigh: how many of the nearest items each project holds, and how close the
 * closest one is. A bare summed-similarity float was easy to ignore in favour
 * of reasoning about the project description.
 */
export function formatEvidence(hits: QdrantHit[], projects: ProjectSummary[]): string {
  if (hits.length === 0) return "No similar existing work items were found.";

  const counts = countHitsByProject(hits);
  const best = new Map<string, number>();
  for (const hit of hits) {
    const projectId = hit.payload?.project_id;
    if (!projectId) continue;
    const id = String(projectId);
    best.set(id, Math.max(best.get(id) ?? 0, hit.score));
  }

  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([projectId, count]) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      return `- ${project?.name || projectId} (id: ${projectId}): ${count} of the ${hits.length} most similar items, closest match ${(best.get(projectId) ?? 0).toFixed(2)}`;
    });

  return lines.join("\n");
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
  let neighbourHitsByProject = new Map<string, number>();
  let neighbourHits: QdrantHit[] = [];
  let degraded = false;

  try {
    const vector = await embed(text);
    const hits = await search(vector, {
      limit: NEIGHBOUR_LIMIT,
      filter: {
        must: [
          { key: "entity_type", match: { value: "work_item" } },
          { key: "project_id", match: { any: projects.map((project) => project.id) } },
        ],
      },
    });
    neighbourHits = hits;
    neighbourScores = scoreNeighbours(hits);
    neighbourHitsByProject = countHitsByProject(hits);
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
            neighbourHits,
            projects,
          )}\n\nWork item:\n${text}`,
        },
      ],
      temperature: 0,
      max_tokens: 1024,
    });

    const raw = response.choices[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim());

    const chosen = projects.find((project) => project.id === parsed.project_id);
    if (!chosen) throw new Error(`LLM returned unknown project id "${parsed.project_id}"`);

    // Without neighbour evidence we cap what the model is allowed to claim,
    // so a degraded run lands in Intake instead of being trusted.
    const ceiling = degraded ? config.routeConfidenceThreshold - 0.01 : 1;
    const confidence = Math.max(Math.min(Number(parsed.confidence) || 0, ceiling), 0);

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

  // No LLM. Neighbours alone decide only if the evidence itself clears the bar.
  const decision = decideFromNeighbours(
    neighbourScores,
    config.routeConfidenceThreshold,
    neighbourHitsByProject,
  );
  // Defence in depth: even though the search is already scoped to this
  // workspace's projects, never hand back a project id we can't confirm
  // belongs here — mirrors the check the LLM path does on `chosen`.
  const decidedProject = decision && projects.find((project) => project.id === decision.projectId);
  if (decision && decidedProject) {
    return {
      projectId: decidedProject.id,
      confidence: decision.confidence,
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
