import "dotenv/config";

/**
 * Parse "workspace-slug:PROJECT_IDENTIFIER" pairs into a lookup map.
 * Malformed pairs are skipped — a typo in the env must not stop the server booting.
 */
export function parseIntakeProjects(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;

  for (const pair of raw.split(",")) {
    const [slug, identifier] = pair.split(":");
    if (!slug?.trim() || !identifier?.trim()) continue;
    map.set(slug.trim(), identifier.trim());
  }

  return map;
}

export const config = {
  port: parseInt(process.env.MCP_PORT || "4650", 10),
  baseUrl: process.env.MCP_ISSUER_URL || "http://localhost:4650",
  frontendUrl: process.env.FRONTEND_URL || "",

  // TaskPilot API
  taskpilotApiUrl: process.env.TASKPILOT_API_URL || "http://api:4647",
  taskpilotApiKey: process.env.TASKPILOT_API_KEY || "",
  taskpilotWorkspaceSlug: process.env.TASKPILOT_WORKSPACE_SLUG || "",

  // Database
  databaseUrl: process.env.DATABASE_URL || "",

  // Redis
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379/7",

  // LLM (smart routing)
  llmApiBaseUrl: process.env.LLM_API_BASE_URL || "http://nuc.lan:4000",
  llmApiKey: process.env.LLM_API_KEY || "",
  // Fallback only: the instance_configurations row LLM_MODEL wins when set.
  // Not "nemotron-3-nano" — that is a local 4B model, a different thing.
  llmModel: process.env.LLM_MODEL || "nemotron-3-nano-cloud",

  // MQTT event bus. The broker carries ~100 msg/sec across 1,115 topics, so
  // nothing subscribes to a wildcard — inbound is an explicit allowlist only.
  mqttHost: process.env.MQTT_HOST || "",
  mqttPort: parseInt(process.env.MQTT_PORT || "1883", 10),
  mqttUsername: process.env.MQTT_USERNAME || "",
  mqttPassword: process.env.MQTT_PASSWORD || "",
  // The peer client id inbound MQTT ingest acts as. Empty disables ingest.
  // A real minted token must exist for this client, so revoking it stops
  // ingest without a redeploy.
  mqttIngestClientId: process.env.MQTT_INGEST_CLIENT_ID || "",

  // Long-term agentic memory (longmemory-hydrograph MCP). Unset means the agent
  // runs on conversation history alone and /health reports memory unavailable —
  // there is deliberately no local fallback store to hide that with.
  longmemoryUrl: process.env.LONGMEMORY_URL || "",
  longmemoryApiKey: process.env.LONGMEMORY_API_KEY || "",

  // Vector store (Qdrant) — awareness of existing work items
  qdrantUrl: process.env.QDRANT_URL || "",
  qdrantApiKey: process.env.QDRANT_API_KEY || "",
  qdrantCollection: process.env.QDRANT_COLLECTION_NAME || "taskpilot_embeddinggemma2",

  // Embedding model, served by the same LiteLLM gateway as the chat model.
  // Unset disables the vector index. The dimension is fixed by the model:
  // changing either invalidates every stored vector, so a new model gets a new
  // QDRANT_COLLECTION_NAME and a full re-index rather than a mixed collection.
  embeddingModel: process.env.EMBEDDING_MODEL || "",
  embeddingDims: 768,

  // Jev decision model, via LiteLLM's /systemone pass-through. Unset = off.
  // Every feature runs in shadow unless named in DECISION_MODEL_LIVE
  // (comma-separated: route_project, dedupe). See src/decisions/jev.ts.
  decisionModel: process.env.DECISION_MODEL || "",
  decisionModelLive: (process.env.DECISION_MODEL_LIVE || "").split(",").map((item) => item.trim()).filter(Boolean),
  // Jev's concentration below which it does not act. On the 75 hard items of
  // for-ai (2026-10-12): >= 0.9 decided 43 with 1 wrong; >= 0.8, 53 with 3.
  decisionMinConfidence: parseFloat(process.env.DECISION_MIN_CONFIDENCE || "0.9"),

  // Routing thresholds. Tuned by scripts/eval-routing.ts, not by feel.
  routeConfidenceThreshold: parseFloat(process.env.A2A_ROUTE_CONFIDENCE || "0.7"),
  // Calibrated for embeddinggemma-2 (2026-10-12) by re-scoring 120 real
  // nearest-neighbour pairs under both models. The old 0.90 (bge-m3) maps to
  // 0.94 at 97.5% agreement, but one old near-miss scores 0.941 under gemma;
  // 0.945 stays below it. "[P24-1] Confidence calibration API" vs "[P24-3]
  // Accounting-engine gap fix" — same workstream, different tasks — scores
  // 0.864. A missed duplicate only creates an item, which is the status quo; a
  // false match blocks real work, so the bias is deliberate.
  dedupeSimilarityThreshold: parseFloat(process.env.A2A_DEDUPE_SIMILARITY || "0.945"),

  // Where low-confidence items go, per workspace. Unset means the router
  // returns "undecided" and nothing is written.
  intakeProjects: parseIntakeProjects(process.env.A2A_INTAKE_PROJECTS),

  // JWT secret (for signing tokens)
  jwtSecret: process.env.MCP_JWT_SECRET || process.env.SECRET_KEY || "change-me",

  // Token TTLs
  accessTokenTtl: parseInt(process.env.MCP_ACCESS_TOKEN_TTL || "3600", 10),
  refreshTokenTtl: parseInt(process.env.MCP_REFRESH_TOKEN_TTL || "2592000", 10),
  authCodeTtl: parseInt(process.env.MCP_AUTH_CODE_TTL || "600", 10),

  // DharaHIL (Human-in-the-Loop)
  dharahilBaseUrl: process.env.DHARAHIL_BASE_URL || "",
  dharahilApiKey: process.env.DHARAHIL_API_KEY || "",
  dharahilTenantId: process.env.DHARAHIL_TENANT_ID || "",
  dharahilAppId: process.env.DHARAHIL_APP_ID || "",
  dharahilEnabled: process.env.DHARAHIL_ENABLED === "true",
};
