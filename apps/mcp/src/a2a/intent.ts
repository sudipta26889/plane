import OpenAI from "openai";
import { config } from "../config.js";
import { getAllSkills } from "./skill-registry.js";
import { getToolDefinitions } from "../tools/handlers.js";
import { getLlmConfig } from "../tools/smart-router.js";

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

  const validSkills = new Set(getAllSkills().map((skill) => skill.name));

  try {
    const llmConfig = await getLlmConfig();
    if (!llmConfig.apiKey) throw new Error("No LLM API key configured");

    const llm = new OpenAI({ baseURL: llmConfig.baseUrl, apiKey: llmConfig.apiKey });
    const response = await llm.chat.completions.create({
      model: llmConfig.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Skills:\n${buildIntentMenu()}\n\nMessage:\n${text}` },
      ],
      temperature: 0,
      max_tokens: 512,
    });

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
