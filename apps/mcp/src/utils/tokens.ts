import crypto from "node:crypto";
import { generateSecureToken } from "./pkce.js";
import { db } from "../db.js";
import { config } from "../config.js";

export interface McpTokenPayload {
  sub: string;
  workspace_slug: string;
  client_id: string;
  scope: string;
  exp: number;
  iat: number;
  jti: string;
  token_type: "access" | "refresh";
}

export function createJwtToken(
  payload: McpTokenPayload,
  secret: string,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${signature}`;
}

export function verifyJwtToken(
  token: string,
  secret: string,
): McpTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    const data = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(data)
      .digest("base64url");

    if (!timingSafeEqual(signature, expectedSignature)) return null;

    const payloadJson = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as McpTokenPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

export async function generateAccessToken({
  userId,
  workspaceSlug,
  clientId,
  scope,
}: {
  userId: string;
  workspaceSlug: string;
  clientId: string;
  scope: string;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const jti = generateSecureToken();
  const refreshJti = generateSecureToken();

  const accessTokenPayload: McpTokenPayload = {
    sub: userId,
    workspace_slug: workspaceSlug,
    client_id: clientId,
    scope,
    exp: now + config.accessTokenTtl,
    iat: now,
    jti,
    token_type: "access",
  };

  const refreshTokenPayload: McpTokenPayload = {
    ...accessTokenPayload,
    exp: now + config.refreshTokenTtl,
    jti: refreshJti,
    token_type: "refresh",
  };

  const accessToken = createJwtToken(accessTokenPayload, config.jwtSecret);
  const refreshToken = createJwtToken(refreshTokenPayload, config.jwtSecret);

  await db.query(
    `INSERT INTO mcp_access_tokens
     (access_token, refresh_token, token_type, scope, expires_at, user_id, workspace_slug, client_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      jti,
      refreshJti,
      "Bearer",
      scope,
      new Date((now + config.accessTokenTtl) * 1000),
      userId,
      workspaceSlug,
      clientId,
    ],
  );

  return { accessToken, refreshToken, expiresIn: config.accessTokenTtl, tokenType: "Bearer" };
}

export async function validateAccessToken(
  accessToken: string,
): Promise<McpTokenPayload | null> {
  const payload = verifyJwtToken(accessToken, config.jwtSecret);
  if (!payload) return null;

  const result = await db.query(
    `SELECT id FROM mcp_access_tokens WHERE access_token = $1 AND revoked = false`,
    [payload.jti],
  );

  if (result.rows.length === 0) return null;

  await db.query(
    `UPDATE mcp_access_tokens SET last_used_at = NOW() WHERE access_token = $1`,
    [payload.jti],
  );

  return payload;
}

export async function refreshAccessTokenFn(
  refreshToken: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
} | null> {
  const payload = verifyJwtToken(refreshToken, config.jwtSecret);
  if (!payload || payload.token_type !== "refresh") return null;

  const result = await db.query(
    `SELECT id FROM mcp_access_tokens WHERE refresh_token = $1 AND revoked = false`,
    [payload.jti],
  );

  if (result.rows.length === 0) return null;

  const newTokens = await generateAccessToken({
    userId: payload.sub,
    workspaceSlug: payload.workspace_slug,
    clientId: payload.client_id,
    scope: payload.scope,
  });

  await db.query(
    `UPDATE mcp_access_tokens SET revoked = true, revoked_at = NOW() WHERE refresh_token = $1`,
    [payload.jti],
  );

  return newTokens;
}

export async function revokeAccessTokenFn(accessToken: string): Promise<boolean> {
  const payload = verifyJwtToken(accessToken, config.jwtSecret);
  if (!payload) return false;

  const result = await db.query(
    `UPDATE mcp_access_tokens SET revoked = true, revoked_at = NOW()
     WHERE access_token = $1 AND revoked = false`,
    [payload.jti],
  );

  return (result.rowCount ?? 0) > 0;
}

export const MCP_SCOPES: Record<string, string> = {
  "taskpilot:read": "Read projects and tasks",
  "taskpilot:write": "Create and manage tasks",
  "taskpilot:manage": "Manage cycles and modules",
  "taskpilot:delete": "Delete tasks and data",
};

export function validateScopes(scopeString: string): boolean {
  if (!scopeString) return true;
  const scopes = scopeString.split(" ");
  return scopes.every((s) => s in MCP_SCOPES);
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}
