import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { buildAgentCard, buildLlmsTxt } from "../a2a/agent-card.js";
import { validateJsonRpcRequest, handleA2aRequest } from "../a2a/protocol-handler.js";
import { authenticateA2aRequest } from "../a2a/auth.js";
import { checkRateLimit, buildRateLimitHeaders } from "../a2a/rate-limit.js";
import { sseManager } from "../a2a/sse.js";
import { A2A_ERROR_CODES } from "../a2a/types.js";

const router: Router = Router();

/**
 * GET /.well-known/agent-card.json
 * Returns the A2A agent card describing skills, capabilities, and auth flows.
 */
router.get("/.well-known/agent-card.json", (_req: Request, res: Response) => {
  res.json(buildAgentCard(config.baseUrl));
});

/**
 * GET /a2a/llms.txt
 * Returns a human/LLM-readable description of the A2A API.
 */
router.get("/a2a/llms.txt", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(buildLlmsTxt(config.baseUrl));
});

/**
 * POST /a2a
 * Main A2A JSON-RPC endpoint. Handles all A2A protocol methods.
 */
router.post("/a2a", async (req: Request, res: Response) => {
  const body = req.body;

  // Validate JSON-RPC shape first
  const validation = validateJsonRpcRequest(body);
  if (!validation.valid) {
    res.status(400).json({
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: { code: A2A_ERROR_CODES.INVALID_REQUEST, message: validation.error },
    });
    return;
  }

  const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";

  // Neither initialize nor the agent card requires auth. validateJsonRpcRequest
  // above has already canonicalised aliases, so GetAgentCard arrives here as
  // agent.getCard; the card is public over the well-known GET regardless.
  if (body.method === "initialize" || body.method === "agent.getCard") {
    const response = await handleA2aRequest(body, null, ipAddress);
    res.json(response);
    return;
  }

  // All other methods require authentication
  let auth;
  try {
    auth = await authenticateA2aRequest(req);
  } catch (err: any) {
    res.status(401).setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
    );
    res.json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: { code: A2A_ERROR_CODES.AUTH_REQUIRED, message: err.message || "Authentication required" },
    });
    return;
  }

  // Check rate limit. If Redis is unreachable the check itself throws, and an
  // unguarded await here rejects the handler so the caller never gets a
  // response at all. Fail open: rate limiting protects against abuse, but a
  // cache outage must not become an outage of the whole A2A surface.
  const isTaskCreate = body.method === "message.send";
  let rateLimitResult;
  try {
    rateLimitResult = await checkRateLimit(auth.clientId, auth.userId, ipAddress, isTaskCreate);
  } catch (err: any) {
    console.error(`[a2a] Rate limit check failed, allowing request: ${err.message}`);
    rateLimitResult = { allowed: true, limit: 0, remaining: 0, resetAt: 0 };
  }

  // Set rate limit headers
  const rlHeaders = buildRateLimitHeaders(rateLimitResult);
  for (const [key, value] of Object.entries(rlHeaders)) {
    res.setHeader(key, value);
  }

  if (!rateLimitResult.allowed) {
    res.status(429).json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: { code: A2A_ERROR_CODES.RATE_LIMITED, message: "Rate limit exceeded" },
    });
    return;
  }

  // Dispatch to protocol handler
  const response = await handleA2aRequest(body, auth, ipAddress);
  res.json(response);
});

/**
 * GET /a2a/stream
 * SSE endpoint for real-time task state updates.
 * Supports Bearer token via Authorization header or ?token= query param.
 */
router.get("/a2a/stream", async (req: Request, res: Response) => {
  // Authenticate (supports ?token= for EventSource compatibility)
  let auth;
  try {
    auth = await authenticateA2aRequest(req);
  } catch (err: any) {
    res.status(401).json({ error: err.message || "Authentication required" });
    return;
  }

  const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
  if (!taskId) {
    res.status(400).json({ error: "Missing required query param: taskId" });
    return;
  }

  // Attach SSE listener — this takes over the response
  sseManager.addListener(taskId, res);
});

export default router;
