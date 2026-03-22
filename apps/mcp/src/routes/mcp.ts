import { Router, type Request, type Response } from "express";
import { validateAccessToken } from "../utils/tokens.js";
import { setCorsHeaders } from "../utils/cors.js";
import { config } from "../config.js";
import { getToolDefinitions, executeToolCall } from "../tools/handlers.js";

const router = Router();

router.options("/mcp-server", (_req, res) => {
  setCorsHeaders(res);
  res.status(204).end();
});

/**
 * GET /mcp-server — Method Not Allowed (matches Inbox/Next.js behavior).
 * Claude expects 405 on GET, then POSTs for the actual MCP protocol.
 */
router.get("/mcp-server", (_req: Request, res: Response) => {
  setCorsHeaders(res);
  res.status(405).end();
});

/**
 * POST /mcp-server — Handle MCP JSON-RPC protocol requests.
 * Copied from Inbox's working pattern: Bearer token auth with WWW-Authenticate header.
 */
router.post("/mcp-server", async (req: Request, res: Response) => {
  setCorsHeaders(res);

  try {
    const message = req.body;

    if (message.jsonrpc !== "2.0") {
      res.json(createErrorResponse(message.id, -32600, "Invalid Request: jsonrpc must be '2.0'"));
      return;
    }

    if (!message.method || typeof message.method !== "string") {
      res.json(createErrorResponse(message.id, -32600, "Invalid Request: missing or invalid method"));
      return;
    }

    // Authenticate via Bearer token
    const authHeader = req.headers.authorization;
    let userId: string | undefined;
    let workspaceSlug: string | undefined;
    let clientId: string | undefined;
    let scopes: string[] = [];

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const tokenPayload = await validateAccessToken(token);

      if (!tokenPayload) {
        // IMPORTANT: Set headers BEFORE calling res.json() (which sends the response)
        res.status(401);
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
        );
        res.json({ detail: "Invalid or expired access token" });
        return;
      }

      userId = tokenPayload.sub;
      workspaceSlug = tokenPayload.workspace_slug;
      clientId = tokenPayload.client_id;
      scopes = tokenPayload.scope ? tokenPayload.scope.split(" ") : [];
    } else {
      // No auth — return 401 with discovery hint
      // IMPORTANT: Set headers BEFORE res.json()
      res.status(401);
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`,
      );
      res.json({ detail: "Authorization required" });
      return;
    }

    // Handle initialize
    if (message.method === "initialize") {
      res.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: "TaskPilot MCP Server",
            version: "1.0.0",
            instructions:
              `You have access to TaskPilot project management tools for workspace "${workspaceSlug}". ` +
              "Use these tools to create, manage, and search for tasks, projects, cycles, and more.",
          },
        },
      });
      return;
    }

    // Handle notifications/initialized
    if (message.method === "notifications/initialized") {
      res.status(202).end();
      return;
    }

    // Handle ping
    if (message.method === "ping" || message.method === "notifications/ping") {
      res.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { timestamp: new Date().toISOString() },
      });
      return;
    }

    // Handle tools/list
    if (message.method === "tools/list") {
      res.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: getToolDefinitions() },
      });
      return;
    }

    // Handle tools/call
    if (message.method === "tools/call") {
      const toolName = message.params?.name;
      if (!toolName) {
        res.json(createErrorResponse(message.id, -32602, "Invalid params: missing tool name"));
        return;
      }

      if (!userId || !workspaceSlug) {
        res.json(createErrorResponse(message.id, -32603, "Internal error: missing user context"));
        return;
      }

      try {
        const result = await executeToolCall(toolName, message.params?.arguments || {}, {
          userId,
          workspaceSlug,
          clientId: clientId || "",
          scopes,
        });

        res.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
          },
        });
      } catch (err: any) {
        console.error(`[mcp] Tool execution failed: ${toolName}`, err);
        res.json(createErrorResponse(message.id, -32603, `Tool execution failed: ${err.message || "Unknown error"}`));
      }
      return;
    }

    res.json(createErrorResponse(message.id, -32601, `Method not found: ${message.method}`));
  } catch (err: any) {
    console.error("[mcp] Protocol error:", err);
    res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error: " + (err.message || "Invalid JSON"),
      },
    });
  }
});

function createErrorResponse(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export default router;
