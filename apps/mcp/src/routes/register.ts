import { Router, type Request, type Response } from "express";
import { generateSecureToken } from "../utils/pkce.js";
import { setCorsHeaders, noCacheHeaders } from "../utils/cors.js";
import { db } from "../db.js";

const router = Router();

// Claude.ai bug #82: also handle /register (root level)
router.options(["/mcp-server/register", "/register"], (_req, res) => {
  setCorsHeaders(res);
  res.status(204).end();
});

/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591)
 * Copied from Inbox's working implementation.
 */
router.post(["/mcp-server/register", "/register"], async (req: Request, res: Response) => {
  setCorsHeaders(res);
  noCacheHeaders(res);

  try {
    const body = req.body;
    const {
      client_name,
      redirect_uris,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      scope,
      logo_uri,
      tos_uri,
      policy_uri,
    } = body;

    const resolvedClientName =
      (typeof client_name === "string" && client_name) || "MCP Client";

    if (
      !redirect_uris ||
      !Array.isArray(redirect_uris) ||
      redirect_uris.length === 0
    ) {
      res.status(400).json({
        error: "invalid_request",
        error_description:
          "Missing or invalid required field: redirect_uris (must be non-empty array)",
      });
      return;
    }

    // Validate redirect URIs
    for (const uri of redirect_uris) {
      try {
        new URL(uri);
      } catch {
        res.status(400).json({
          error: "invalid_request",
          error_description: `Invalid redirect URI format: ${uri}`,
        });
        return;
      }
    }

    const validGrantTypes = ["authorization_code", "refresh_token"];
    const clientGrantTypes = grant_types || ["authorization_code", "refresh_token"];
    for (const grantType of clientGrantTypes) {
      if (!validGrantTypes.includes(grantType)) {
        res.status(400).json({
          error: "invalid_request",
          error_description: `Unsupported grant_type: ${grantType}`,
        });
        return;
      }
    }

    const clientResponseTypes = response_types || ["code"];
    const clientAuthMethod = token_endpoint_auth_method || "none";
    const clientId = `mcp_${generateSecureToken(16)}`;

    const result = await db.query(
      `INSERT INTO mcp_clients
       (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, scope, logo_uri, tos_uri, policy_uri)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        clientId,
        resolvedClientName,
        JSON.stringify(redirect_uris),
        JSON.stringify(clientGrantTypes),
        JSON.stringify(clientResponseTypes),
        clientAuthMethod,
        scope || "",
        logo_uri || null,
        tos_uri || null,
        policy_uri || null,
      ],
    );

    const client = result.rows[0];

    console.log(`[register] New MCP client: ${clientId} (${resolvedClientName})`);

    // RFC 7591: response format
    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
      redirect_uris,
      grant_types: clientGrantTypes,
      response_types: clientResponseTypes,
      token_endpoint_auth_method: clientAuthMethod,
    };

    if (resolvedClientName !== "MCP Client") {
      response.client_name = resolvedClientName;
    }

    res.status(201).json(response);
  } catch (err) {
    console.error("[register] Error:", err);
    res.status(500).json({
      error: "server_error",
      error_description: "Internal server error",
    });
  }
});

export default router;
