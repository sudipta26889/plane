import "dotenv/config";

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
