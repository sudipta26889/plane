import { config } from "../config.js";
import { db } from "../db.js";
import { getLlmConfig } from "../tools/smart-router.js";

/**
 * Jev (TypeSafe's typed decision model) for small fixed-answer decisions, next
 * to the LLM rather than instead of it. Same contract as Inbox's
 * apps/web/utils/decision-model/:
 *
 * - Off unless DECISION_MODEL is set.
 * - Shadow by default: the existing decider still decides; Jev's answer is
 *   recorded beside it in decision_model_runs, never awaited.
 * - Live only for features named in DECISION_MODEL_LIVE, and only after the
 *   shadow rows show Jev matching or beating the existing decider. Even then,
 *   an uncertain answer or any Jev error hands the decision back.
 *
 * Jev's confidence measures how concentrated its answer is, not whether it is
 * right — so it gates handing off, it is never reported as routing confidence.
 */

// Jev answers in well under a second; past this the existing decider is the
// better use of the caller's time.
const REQUEST_TIMEOUT_MS = 15_000;

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } };

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

/** Thrown by a Jev decider when its answer is too spread out to act on. */
export class JevUncertainError extends Error {}

/**
 * Where a decider's raw Jev answers land, so decision_model_runs keeps them
 * for every outcome. Uncertain answers are exactly the ones calibration needs,
 * and they never reach a decided result.
 */
export interface JevSink {
  answers?: Record<string, Answer>;
  model?: string;
}

export async function askJev(
  state: Record<string, unknown>,
  questions: Record<string, Question>,
  sink?: JevSink,
): Promise<Record<string, Answer>> {
  const llm = await getLlmConfig();
  // LiteLLM's /systemone route passes System One straight through to TypeSafe
  // with the ordinary LiteLLM key.
  const response = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
    // The JSON round trip drops undefined fields, which the API rejects.
    body: JSON.stringify({ model: config.decisionModel, state: JSON.parse(JSON.stringify(state)), questions }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // The body is work-item text, so it stays out of the error.
  if (!response.ok) throw new Error(`Jev request failed with status ${response.status}`);

  const body: any = await response.json();
  const answers: Record<string, any> = body?.answers ?? {};
  for (const answer of Object.values(answers)) {
    // TypeSafe's own definition, (p_max - 1/n) / (1 - 1/n): 0 for a uniform
    // spread. The chosen option's raw probability is a different scale.
    if (answer?.type === "choice" && answer.confidence === undefined) {
      const n = Object.keys(answer.probabilities ?? {}).length;
      const p = answer.probabilities?.[answer.choice] ?? 0;
      answer.confidence = n > 1 ? Math.max((p - 1 / n) / (1 - 1 / n), 0) : p;
    }
  }
  // We use typesafe/jev-latest as LiteLLM serves it. The alias moves between
  // releases, so record the version that answered: an upgrade then shows up
  // next to the thresholds it may shift.
  if (sink) {
    sink.answers = answers;
    sink.model = body?.model;
  }
  return answers;
}

export function isLive(feature: string): boolean {
  return config.decisionModelLive.includes(feature);
}

/**
 * Run one decision through Jev and the existing decider per the mode above.
 * `jev` throws JevUncertainError when its answer should not be acted on.
 */
export async function decide<T>(opts: {
  feature: string;
  subject?: string;
  jev: (sink: JevSink) => Promise<T>;
  fallback: () => Promise<T>;
  same: (jev: T, fallback: T) => boolean;
}): Promise<T> {
  if (!config.decisionModel) return opts.fallback();

  const started = Date.now();
  const sink: JevSink = {};
  const jevRun = opts.jev(sink).then(
    (result) => ({ ok: true as const, result, ms: Date.now() - started }),
    (error: unknown) => ({ ok: false as const, error, ms: Date.now() - started }),
  );

  if (!isLive(opts.feature)) {
    let fallbackResult: T;
    try {
      fallbackResult = await opts.fallback();
    } catch (fallbackError) {
      // Still the existing decider's failure to report, but keep Jev's answer:
      // these are the cases where the comparison matters most.
      void jevRun.then((run) =>
        record(sink, opts, "shadow", "fallback-error", run.ms, run.ok ? run.result : undefined, undefined, `${message(fallbackError)}${run.ok ? "" : ` | Jev: ${message(run.error)}`}`),
      );
      throw fallbackError;
    }

    // ponytail: not awaited, so a slow or failing Jev can never delay or
    // change a decision that was already made.
    void jevRun.then((run) =>
      record(
        sink,
        opts,
        "shadow",
        run.ok ? (opts.same(run.result, fallbackResult) ? "agree" : "disagree") : run.error instanceof JevUncertainError ? "uncertain" : "error",
        run.ms,
        run.ok ? run.result : undefined,
        fallbackResult,
        run.ok ? undefined : message(run.error),
      ),
    );
    return fallbackResult;
  }

  const run = await jevRun;
  if (run.ok) {
    void record(sink, opts, "live", "decided", run.ms, run.result);
    return run.result;
  }

  if (!(run.error instanceof JevUncertainError)) {
    console.warn(`[jev] ${opts.feature} failed, falling back: ${message(run.error)}`);
  }
  const result = await opts.fallback();
  void record(sink, opts, "live", run.error instanceof JevUncertainError ? "escalated" : "fallback", run.ms, undefined, result, message(run.error));
  return result;
}

async function record(
  sink: JevSink,
  opts: { feature: string; subject?: string },
  mode: "shadow" | "live",
  outcome: string,
  latencyMs: number,
  jevResult?: unknown,
  fallbackResult?: unknown,
  error?: string,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO decision_model_runs (feature, subject, model, mode, outcome, jev_result, fallback_result, answers, latency_ms, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [opts.feature, opts.subject ?? null, sink.model ?? config.decisionModel, mode, outcome, toJson(jevResult), toJson(fallbackResult), toJson(sink.answers), latencyMs, error ?? null],
    );
  } catch (err) {
    console.warn(`[jev] Could not record ${opts.feature} run: ${message(err)}`);
  }
}

function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Non-Error rejection";
}
