import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { initDatabase } from "./db.js";
import { pollHitlDecisions, retryWebhooks, cleanupOldData, syncKnowledgeIndex, keepEmbedderWarm } from "./a2a/background.js";

// Routes
import discoveryRouter from "./routes/discovery.js";
import registerRouter from "./routes/register.js";
import authorizeRouter from "./routes/authorize.js";
import tokenRouter from "./routes/token.js";
import revokeRouter from "./routes/revoke.js";
import approveRouter from "./routes/approve.js";
import mcpRouter from "./routes/mcp.js";
import a2aRouter from "./routes/a2a.js";
import { checkDependencies, reportHealthTransitions, redactHealthReport } from "./health.js";
import { startIngest } from "./agent/ingest.js";
import { startLiveIndex } from "./knowledge/live-index.js";
import { authenticateA2aRequest } from "./a2a/auth.js";

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

// Health check. Returns 503 when a dependency is down: every one of them has a
// fallback that keeps the server answering, so a 200 here regardless of their
// state is how a dead LLM endpoint stayed invisible for months.
app.get("/health", async (req, res) => {
  const report = await checkDependencies();

  // Anyone may learn WHETHER the server is healthy — monitoring needs that
  // without a credential. Only an authenticated caller sees which host, which
  // model, and the raw error text.
  let detailed = false;
  try {
    await authenticateA2aRequest(req);
    detailed = true;
  } catch {
    detailed = false;
  }

  res.status(report.status === "ok" ? 200 : 503).json(detailed ? report : redactHealthReport(report));
});

// Liveness only — "is the process up", for restart policies that must not react
// to a degraded dependency.
app.get("/health/live", (_req, res) => {
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
    // Shout when a dependency dies, rather than waiting for someone to poll.
    setInterval(reportHealthTransitions, 5 * 60 * 1000);
    void reportHealthTransitions();
    // Keep the model resident: it unloads after 300s idle.
    setInterval(keepEmbedderWarm, 4 * 60 * 1000);
    setInterval(syncKnowledgeIndex, 10 * 60 * 1000);
    // First index build, after the server is already accepting requests.
    void syncKnowledgeIndex();

    // Live index: a change is searchable in seconds instead of up to ten
    // minutes. The periodic sync above stays as the reconciliation pass —
    // NOTIFY is a notification, not a delivery guarantee, so dropping it would
    // trade a bounded staleness for an unbounded one.
    void startLiveIndex();
    void startIngest();
    console.log("[a2a] Background tasks started");
  });
}

main();
