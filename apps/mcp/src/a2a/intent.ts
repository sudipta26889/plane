import OpenAI from "openai";
import { config } from "../config.js";
import { getAllSkills } from "./skill-registry.js";
import { getToolDefinitions } from "../tools/handlers.js";
import { getLlmConfig, defuseMessages } from "../tools/smart-router.js";
import { LLM_MAX_TOKENS } from "../routing/router.js";
import { askJev, decide, isLive, type JevSink } from "../decisions/jev.js";

/**
 * A2A peers such as OpenClaw's built-in channel can only send free text — their
 * outbound message carries `parts: [{text}]` and nothing else. TaskPilot
 * dispatches on a named skill, so something has to turn one into the other.
 *
 * This asks the instance's configured LLM to pick a skill and build its input,
 * and refuses when it is not confident. Refusing costs the caller a round trip;
 * guessing wrong silently creates or mutates the wrong work item.
 */

export interface IntentResult {
  skill: string;
  input: Record<string, unknown>;
  confidence: number;
  reason: string;
}

// nemotron-3-nano-cloud reasons first: measured routing calls average ~10s and
// reach 45s on the items it thinks longest about. The OpenAI SDK defaults to a 600s timeout with 2 retries — up to 30
// minutes for one call — while the calling A2A peer gives up at 120s, so a hung
// LLM held a connection open long after anyone was listening and then completed
// work nobody received. 60s covers the slowest measured call and stays well
// inside the peer's budget.
const LLM_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You translate a user's message into one TaskPilot skill call.

Reply with ONLY a JSON object:
{"skill": "<exact skill name>", "input": {<arguments>}, "confidence": <0.0-1.0>, "reason": "<one sentence>"}

Rules:
- "skill" must be exactly one of the listed names. Never invent one.
- "input" must satisfy that skill's schema, including every required field. If a
  required field is not present or clearly implied in the message, do not guess a
  value — return low confidence instead.
- Prefer a read skill over a write skill when the message is a question.
- Set confidence below 0.5 when the message is ambiguous, is small talk, or asks
  for something no skill covers.
- There is no delete. Removing work means cancelling it.`;

/** The skill menu handed to the model: each skill with the schema of its arguments. */
export function buildIntentMenu(): string {
  const tools = getToolDefinitions();

  return getAllSkills()
    .map((skill) => {
      const tool = tools.find((candidate: any) => candidate.name === skill.mcpTool);
      const schema = tool ? JSON.stringify((tool as any).inputSchema) : "{}";
      return `- ${skill.name}: ${skill.description}\n  input schema: ${schema}`;
    })
    .join("\n");
}

/**
 * Parse the model's reply and reject anything that would not dispatch: unknown
 * skills, malformed JSON, or a non-object input.
 */
export function parseIntentResponse(raw: string, validSkills: Set<string>): IntentResult | null {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!validSkills.has(parsed.skill)) return null;
    if (parsed.input !== undefined && (typeof parsed.input !== "object" || parsed.input === null)) {
      return null;
    }

    return {
      skill: parsed.skill,
      input: parsed.input ?? {},
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * Map free text onto a skill call. Returns null when the model is unavailable,
 * answers unusably, or is not confident enough — the caller must then refuse
 * rather than act.
 */
export async function resolveIntent(text: string): Promise<IntentResult | null> {
  if (!text.trim()) return null;

  // Jev classifies the skill in shadow next to the LLM, so decision_model_runs
  // accumulates the comparison the two-stage design needs (Jev picks the skill,
  // the LLM only extracts that skill's arguments) before anyone switches it on.
  return decide<IntentResult | null>({
    feature: "intent",
    subject: text.slice(0, 255),
    jev: (sink) => classifySkillWithJev(text, sink),
    fallback: () => resolveWithLlm(text),
    same: (jev, llm) => (jev?.skill ?? null) === (llm?.skill ?? null),
  });
}

const JEV_NO_SKILL = "none";

async function classifySkillWithJev(text: string, sink: JevSink): Promise<IntentResult | null> {
  // Jev picks a skill but cannot write its arguments. Acting on it alone would
  // run a skill with empty input, so it stays shadow-only even if "intent" is
  // listed in DECISION_MODEL_LIVE: live, this throws and the LLM decides.
  if (isLive("intent")) throw new Error("intent is shadow-only until argument extraction is split out");

  const skills = [...getAllSkills()].sort((a, b) => a.name.localeCompare(b.name));
  const answers = await askJev(
    { message: text },
    {
      skill: {
        type: "choice",
        instructions: "Which TaskPilot action does `message` ask for? Prefer a read action when it is a question.",
        criteria: {
          ...Object.fromEntries(skills.map((skill) => [skill.name, skill.description])),
          [JEV_NO_SKILL]: "Small talk, or a request no listed action covers.",
        },
      },
    },
    sink,
  );
  const answer = answers.skill;
  if (answer?.type !== "choice") throw new Error("Jev response is missing the skill answer");
  if (answer.choice === JEV_NO_SKILL) return null;
  return { skill: answer.choice, input: {}, confidence: answer.confidence, reason: "Jev skill classification (shadow)" };
}

/** The incumbent: one LLM call picks the skill and builds its input. */
async function resolveWithLlm(text: string): Promise<IntentResult | null> {
  const validSkills = new Set(getAllSkills().map((skill) => skill.name));

  try {
    const llmConfig = await getLlmConfig();
    if (!llmConfig.apiKey) throw new Error("No LLM API key configured");

    const llm = new OpenAI({ baseURL: llmConfig.baseUrl, apiKey: llmConfig.apiKey });
    const response = await llm.chat.completions.create({
      model: llmConfig.model,
      messages: defuseMessages([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Skills:\n${buildIntentMenu()}\n\nMessage:\n${text}` },
      ]),
      temperature: 0,
      max_tokens: LLM_MAX_TOKENS,
    }, { timeout: LLM_TIMEOUT_MS, maxRetries: 1 });

    const intent = parseIntentResponse(response.choices[0]?.message?.content ?? "", validSkills);
    if (!intent) return null;

    // Shares the routing threshold rather than adding a second knob: both answer
    // the same question, "is this confident enough to act on?"
    if (intent.confidence < config.routeConfidenceThreshold) {
      console.log(
        `[intent] Declining "${text.slice(0, 60)}" — ${intent.skill} at ${intent.confidence}`,
      );
      return null;
    }

    return intent;
  } catch (err: any) {
    console.warn(`[intent] Could not resolve intent: ${err.message}`);
    return null;
  }
}
