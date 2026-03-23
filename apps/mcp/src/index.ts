import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { initDatabase } from "./db.js";
import { pollHitlDecisions, retryWebhooks, cleanupOldData } from "./a2a/background.js";

// Routes
import discoveryRouter from "./routes/discovery.js";
import registerRouter from "./routes/register.js";
import authorizeRouter from "./routes/authorize.js";
import tokenRouter from "./routes/token.js";
import revokeRouter from "./routes/revoke.js";
import approveRouter from "./routes/approve.js";
import mcpRouter from "./routes/mcp.js";
import a2aRouter from "./routes/a2a.js";

const app = express();

// Global CORS
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["WWW-Authenticate"],
  }),
);

// JSON body parser (for MCP and approve endpoints)
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.path} ${req.headers.authorization ? "(auth)" : "(no-auth)"}`);
  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "taskpilot-mcp" });
});

// Discovery endpoints (/.well-known/*)
app.use(discoveryRouter);

// OAuth endpoints — each handles both /mcp-server/X and /X (Claude.ai bug #82 workaround)
app.use(registerRouter);
app.use(authorizeRouter);
app.use(tokenRouter);
app.use(revokeRouter);

// Consent approval (called by frontend consent page)
app.use(approveRouter);

// MCP protocol endpoint (POST /mcp-server)
app.use(mcpRouter);

// A2A protocol endpoints
app.use(a2aRouter);

// Root endpoint
app.get("/", (_req, res) => {
  res.json({ name: "taskpilot-mcp", version: "1.0.0", status: "ok" });
});

// Start server
async function main() {
  try {
    await initDatabase();
    console.log(`[mcp] Database initialized`);
  } catch (err) {
    console.error("[mcp] Failed to initialize database:", err);
    process.exit(1);
  }

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`[mcp] TaskPilot MCP Server listening on port ${config.port}`);
    console.log(`[mcp] Base URL: ${config.baseUrl}`);
    console.log(`[mcp] Frontend: ${config.frontendUrl}`);

    // A2A background tasks
    setInterval(async () => { await pollHitlDecisions(); await retryWebhooks(); }, 30000);
    setInterval(cleanupOldData, 24 * 60 * 60 * 1000);
    console.log("[a2a] Background tasks started");
  });
}

main();
