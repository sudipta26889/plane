import crypto from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { subscribe, publishDiscovery, isConfigured } from "./mqtt.js";
import { handleA2aRequest } from "../a2a/protocol-handler.js";
import { consumeQuota } from "../a2a/rate-limit.js";
import { pollHitlDecisions } from "../a2a/background.js";
import type { AuthContext } from "../a2a/types.js";

/**
 * Inbound MQTT ingest.
 *
 * This is the only path that lets the outside world cause writes, so it is
 * built to be boring: an explicit allowlist, a real revocable credential, the
 * same approval gate as every other caller, and a hard ceiling on how many
 * messages can reach the model in an hour.
 *
 * A message from a topic is not a person. Ingest acts as a `peer_` client,
 * which means `requiresHumanApproval` gates every write it attempts — the same
 * rule external A2A peers already live under — and the audit trail shows the
 * peer as the actor rather than a human who did nothing.
 */

/** Only messages reaching the model cost anything; this bounds the bill. */
const GLOBAL_AGENT_INGESTS_PER_HOUR = 60;
const HOUR = 3600;

type Handler = "agent" | "rediscover" | "observe" | "notify" | "availability";

interface Rule {
  topic: string;
  handler: Handler;
  /** Per-rule hourly limit. Only meaningful for the agent handler. */
  perHour?: number;
}

/**
 * The allowlist. Every entry earned its place by being measured on the real
 * broker — see docs/superpowers/specs/2026-09-07-mqtt-event-bus-design.md for
 * the topics that were excluded and why.
 */
export const RULES: Rule[] = [
  // The deliberate "make a task of this" channel. Anything published here is
  // asking to be handled, so it is the only rule that reaches the model.
  { topic: "taskpilot/ingest/+", handler: "agent", perHour: GLOBAL_AGENT_INGESTS_PER_HOUR },

  // Home Assistant forgets discovered entities when it restarts and re-announces
  // itself with `online`. Without this our entities silently vanish from HA
  // until this process happens to restart too.
  { topic: "homeassistant/status", handler: "rediscover" },

  // No verified payload for these yet. They fire on a real occurrence rather
  // than continuously, which is the shape an ingest rule wants — but the rule
  // that parses them must be written against a real captured message, so for
  // now they are logged and nothing more. See `observe`.
  { topic: "frigate/events", handler: "observe" },
  { topic: "frigate/reviews", handler: "observe" },
  { topic: "zigbee2mqtt/bridge/state", handler: "observe" },

  // DharaHIL publishes telemetry only and never accepts an approval over MQTT
  // — the right call, since MQTT authenticates a connection, not a request.
  // So this is strictly a notification: the payload is never read as a
  // decision, it only means "a decision landed, go ask the authenticated API
  // now" instead of waiting out the poll interval. The poller stays as the
  // safety net, because a dropped message must make us late, not wrong.
  { topic: "dharahil/last_decision/state", handler: "notify" },

  // An approval gateway that is down blocks every pending write. Backed by a
  // last will, so this arrives even if DharaHIL dies without saying goodbye.
  { topic: "dharahil/availability", handler: "availability" },
];

/**
 * Reject a topic that could feed our own output back in.
 *
 * TaskPilot publishes `taskpilot/task/created`; a rule matching that namespace
 * would create a task about creating a task, forever. Only the explicit ingest
 * channel is allowed under our own prefix.
 */
export function isSafeIngestTopic(topic: string): boolean {
  if (!topic.startsWith("taskpilot/")) return true;
  return topic.startsWith("taskpilot/ingest/");
}

/** MQTT topic match supporting the `+` single-level wildcard. */
export function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.split("/");
  const t = topic.split("/");
  if (p.length !== t.length) return false;
  return p.every((segment, i) => segment === "+" || segment === t[i]);
}

export function findRule(topic: string): Rule | null {
  return RULES.find((rule) => topicMatches(rule.topic, topic)) ?? null;
}

/**
 * Drop our own traffic.
 *
 * Every message this server publishes carries `origin: "taskpilot-mcp"`. The
 * topic allowlist should already prevent a loop; this is the second, independent
 * guard the design calls for, because one guard is a single point of failure
 * and the failure mode here is an infinite loop that costs money.
 */
export function isOwnMessage(payload: string): boolean {
  try {
    return JSON.parse(payload)?.origin === "taskpilot-mcp";
  } catch {
    return false;
  }
}

/**
 * A stable key for the same event.
 *
 * MQTT QoS 1 is at-least-once: the same message will sometimes arrive twice.
 * The A2A path already refuses a repeated idempotency key, so deriving one here
 * makes a redelivery a no-op rather than a second work item. Prefer an id the
 * publisher chose; fall back to hashing the content.
 */
export function idempotencyKeyFor(topic: string, payload: string): string {
  let id: string | undefined;
  try {
    const parsed = JSON.parse(payload);
    id = parsed?.id ?? parsed?.messageId ?? parsed?.event_id;
  } catch {
    // Not JSON; the content hash below is the only option.
  }
  const suffix = id ?? crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
  return `mqtt:${topic}:${suffix}`;
}

/**
 * Resolve the credential ingest acts as.
 *
 * Deliberately a lookup of a real minted peer token rather than an identity
 * assembled from environment variables: revoking the token must be enough to
 * stop ingest, and the workspace must be one the bound user is actually a
 * member of. Returns null if no live token exists, and ingest then stays off —
 * fail closed, since the alternative is an ungated write path.
 */
export async function resolveIngestIdentity(): Promise<AuthContext | null> {
  const clientId = config.mqttIngestClientId;
  if (!clientId) return null;

  const result = await db.query(
    `SELECT user_id, workspace_slug, scope
       FROM mcp_access_tokens
      WHERE client_id = $1 AND revoked = false AND expires_at > NOW()
   ORDER BY expires_at DESC
      LIMIT 1`,
    [clientId],
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    userId: row.user_id,
    workspaceSlug: row.workspace_slug,
    clientId,
    scopes: String(row.scope || "").split(/\s+/).filter(Boolean),
  };
}

let identity: AuthContext | null = null;
let lastError: string | null = null;
let started = false;
let observed = 0;
let dispatched = 0;
let notified = 0;
let dharahilOnline: boolean | null = null;
let pollTimer: NodeJS.Timeout | null = null;

/**
 * A burst of decisions should cost one poll, not one per message. Short enough
 * that a human who just clicked approve sees it act immediately.
 */
const NOTIFY_DEBOUNCE_MS = 1_000;

function scheduleHitlPoll(): void {
  if (pollTimer) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollHitlDecisions().catch((err) =>
      console.warn(`[ingest] triggered HITL poll failed: ${err?.message}`),
    );
  }, NOTIFY_DEBOUNCE_MS);
}

async function handleAgentMessage(topic: string, payload: string, rule: Rule): Promise<void> {
  if (!identity) {
    console.warn(`[ingest] ${topic} dropped: no live credential for ${config.mqttIngestClientId}`);
    return;
  }

  // Two ceilings: this rule's, and a global one across every agent-invoking
  // rule. A single chatty publisher must not be able to spend the whole budget.
  const perRule = await consumeQuota(`mqtt:ingest:${rule.topic}`, rule.perHour ?? GLOBAL_AGENT_INGESTS_PER_HOUR, HOUR);
  const global = await consumeQuota("mqtt:ingest:global", GLOBAL_AGENT_INGESTS_PER_HOUR, HOUR);
  if (!perRule.allowed || !global.allowed) {
    console.warn(`[ingest] ${topic} refused: hourly ingest ceiling reached`);
    return;
  }

  // Free text, deliberately. The agent decides what to do with it, and every
  // write it chooses still goes through the approval gate because the caller
  // is a peer_ client.
  const text = extractText(payload);
  if (!text) return;

  const response = await handleA2aRequest(buildIngestRequest(topic, payload, text), identity, "mqtt");

  dispatched++;
  if (response?.error) {
    lastError = response.error.message;
    console.warn(`[ingest] ${topic} failed: ${response.error.message}`);
  } else {
    console.log(`[ingest] ${topic} dispatched as ${identity.clientId}`);
  }
}

/**
 * Build the A2A request an ingested message becomes.
 *
 * Separated out because the contextId here is load-bearing and easy to drop:
 * without one the handler skips the ReAct agent entirely and silently falls
 * back to the single-shot intent adapter, which looks like a worse agent
 * rather than a missing field.
 */
export function buildIngestRequest(topic: string, payload: string, text: string) {
  const key = idempotencyKeyFor(topic, payload);
  // One context per topic, so a stream of related events reads as one ongoing
  // conversation instead of losing its history every message.
  const contextId = `mqtt:${topic}`;
  return {
    jsonrpc: "2.0",
    id: `mqtt-${Date.now()}`,
    method: "message.send",
    params: {
      contextId,
      idempotencyKey: key,
      message: { role: "user", messageId: key, contextId, parts: [{ kind: "text", text: `[via MQTT ${topic}] ${text}` }] },
    },
  };
}

/** Take the human-readable content out of whatever shape arrived. */
export function extractText(payload: string): string {
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed === "string") return parsed;
    const candidate = parsed?.text ?? parsed?.message ?? parsed?.title ?? parsed?.summary;
    // No obvious field: hand over the whole document rather than guessing at
    // a schema the publisher never promised.
    return typeof candidate === "string" && candidate.trim() ? candidate : JSON.stringify(parsed);
  } catch {
    return payload.trim();
  }
}

export async function startIngest(): Promise<void> {
  if (!isConfigured() || !config.mqttIngestClientId) return;

  identity = await resolveIngestIdentity();
  if (!identity) {
    // Loud, because the symptom of a missing token is silence, which is
    // indistinguishable from "nothing was published".
    console.warn(
      `[ingest] no live token for ${config.mqttIngestClientId}; ingest is OFF. ` +
        `Mint one: npx tsx scripts/mint-peer-token.ts mqtt <email> <workspace>`,
    );
    lastError = `no live token for ${config.mqttIngestClientId}`;
    return;
  }

  await subscribe(
    RULES.map((rule) => rule.topic),
    async (topic, payload) => {
      if (!isSafeIngestTopic(topic) || isOwnMessage(payload)) return;

      const rule = findRule(topic);
      if (!rule) return;

      switch (rule.handler) {
        case "agent":
          await handleAgentMessage(topic, payload, rule);
          break;
        case "rediscover":
          // HA republishes `online` after a restart, having forgotten every
          // entity it discovered. Re-announce so ours come back.
          if (payload.trim() === "online") {
            console.log("[ingest] Home Assistant restarted; re-announcing discovery");
            await publishDiscovery();
          }
          break;
        case "notify":
          // The payload is deliberately ignored. Trusting it would make an
          // MQTT publisher able to approve a write, which is exactly what
          // DharaHIL refuses to allow and what this must not reintroduce.
          notified++;
          scheduleHitlPoll();
          break;
        case "availability":
          dharahilOnline = payload.trim() === "online";
          if (!dharahilOnline) console.warn("[ingest] DharaHIL is offline; approvals are blocked");
          break;
        case "observe":
          // No verified payload yet. Log a bounded sample so the parsing rule
          // can later be written against a real message rather than a
          // remembered schema, and cost nothing in the meantime.
          observed++;
          console.log(`[ingest] observed ${topic}: ${payload.slice(0, 500)}`);
          break;
      }
    },
  );

  started = true;
  console.log(`[ingest] listening on ${RULES.length} allowlisted topics as ${identity.clientId}`);
}

/** Status for /health, so an ingest that never started is visible. */
export function getIngestStatus(): { ok: boolean; detail: string } {
  if (!isConfigured() || !config.mqttIngestClientId) {
    return { ok: true, detail: "disabled (no MQTT_INGEST_CLIENT_ID)" };
  }
  if (started) {
    // DharaHIL being down is reported, not hidden: it blocks every pending write.
    const hil = dharahilOnline === null ? "unknown" : dharahilOnline ? "online" : "OFFLINE";
    return {
      ok: dharahilOnline !== false,
      detail: `${RULES.length} topics, ${dispatched} dispatched, ${notified} decision notices, ${observed} observed, dharahil ${hil}`,
    };
  }
  return { ok: false, detail: lastError ?? "not started" };
}
