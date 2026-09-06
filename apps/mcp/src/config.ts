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
  llmModel: process.env.LLM_MODEL || "gpt-4o-mini",

  // Vector store (Qdrant) — awareness of existing work items
  qdrantUrl: process.env.QDRANT_URL || "",
  qdrantApiKey: process.env.QDRANT_API_KEY || "",
  qdrantCollection: process.env.QDRANT_COLLECTION_NAME || "taskpilot_vector_db",

  // Embedding server. Dimension is fixed by the model and by the PKM
  // collection we reuse — changing it invalidates every stored vector.
  embeddingUrl: process.env.EMBEDDING_DIRECT_URL || "",
  embeddingDims: 1024,

  // Routing thresholds. Tuned by scripts/eval-routing.ts, not by feel.
  routeConfidenceThreshold: parseFloat(process.env.A2A_ROUTE_CONFIDENCE || "0.7"),
  // Measured over 20 real work items: true duplicates scored 0.895-1.000, while
  // "[P24-1] Confidence calibration API" vs "[P24-3] Accounting-engine gap fix"
  // — same workstream, different tasks — scored 0.877. 0.90 clears that false
  // positive. A missed duplicate only creates an item, which is the status quo;
  // a false match blocks real work, so the bias is deliberate.
  dedupeSimilarityThreshold: parseFloat(process.env.A2A_DEDUPE_SIMILARITY || "0.90"),

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
