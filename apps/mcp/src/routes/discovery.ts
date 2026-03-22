import { Router } from "express";
import { config } from "../config.js";

const router = Router();

/**
 * RFC 9728: OAuth 2.0 Protected Resource Metadata
 * Tells MCP clients where the authorization server is.
 */
router.get("/.well-known/oauth-protected-resource", (_req, res) => {
  const baseUrl = config.baseUrl;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    resource: `${baseUrl}/mcp-server`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    resource_type: "mcp-server",
    mcp_protocol_version: "2024-11-05",
    scopes_supported: [
      "taskpilot:read",
      "taskpilot:write",
      "taskpilot:manage",
      "taskpilot:delete",
    ],
    token_types_supported: ["Bearer"],
  });
});

/**
 * RFC 9728 with path — handles /.well-known/oauth-protected-resource/mcp-server etc.
 */
router.get("/.well-known/oauth-protected-resource/*", (_req, res) => {
  const baseUrl = config.baseUrl;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    resource: `${baseUrl}/mcp-server`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    resource_type: "mcp-server",
    mcp_protocol_version: "2024-11-05",
    scopes_supported: [
      "taskpilot:read",
      "taskpilot:write",
      "taskpilot:manage",
      "taskpilot:delete",
    ],
    token_types_supported: ["Bearer"],
  });
});

/**
 * RFC 8414: OAuth 2.0 Authorization Server Metadata
 */
router.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const baseUrl = config.baseUrl;

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/mcp-server/authorize`,
    token_endpoint: `${baseUrl}/mcp-server/token`,
    registration_endpoint: `${baseUrl}/mcp-server/register`,
    revocation_endpoint: `${baseUrl}/mcp-server/revoke`,
    scopes_supported: [
      "taskpilot:read",
      "taskpilot:write",
      "taskpilot:manage",
      "taskpilot:delete",
    ],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_types_supported: ["Bearer"],
    service_documentation: `${baseUrl}/docs`,
    ui_locales_supported: ["en"],
    require_pushed_authorization_requests: false,
    require_request_uri_registration: false,
    require_pkce: true,
  });
});

export default router;
