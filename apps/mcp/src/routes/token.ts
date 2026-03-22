import { Router, type Request, type Response } from "express";
import express from "express";
import { verifyCodeChallenge, validateCodeVerifier } from "../utils/pkce.js";
import { generateAccessToken, refreshAccessTokenFn } from "../utils/tokens.js";
import { setCorsHeaders, noCacheHeaders } from "../utils/cors.js";
import { db } from "../db.js";

const router = Router();

// Token endpoint uses application/x-www-form-urlencoded (per OAuth spec)
router.use(["/mcp-server/token", "/token"], express.urlencoded({ extended: true }));

router.options(["/mcp-server/token", "/token"], (_req, res) => {
  setCorsHeaders(res);
  res.status(204).end();
});

function oauthError(res: Response, error: string, errorDescription: string, status = 400) {
  setCorsHeaders(res);
  noCacheHeaders(res);
  res.status(status).json({ error, error_description: errorDescription });
}

/**
 * OAuth 2.1 Token Endpoint (RFC 6749 Section 3.2)
 * Copied from Inbox — form data input, same grant type handling.
 */
router.post(["/mcp-server/token", "/token"], async (req: Request, res: Response) => {
  setCorsHeaders(res);
  noCacheHeaders(res);

  try {
    const grantType = req.body.grant_type;
    const clientId = req.body.client_id;

    if (!grantType) {
      oauthError(res, "invalid_request", "Missing required parameter: grant_type");
      return;
    }
    if (!clientId) {
      oauthError(res, "invalid_request", "Missing required parameter: client_id");
      return;
    }

    const clientResult = await db.query(
      `SELECT * FROM mcp_clients WHERE client_id = $1`,
      [clientId],
    );
    if (clientResult.rows.length === 0) {
      oauthError(res, "invalid_client", "Unknown client_id");
      return;
    }

    if (grantType === "authorization_code") {
      await handleAuthorizationCodeGrant(req, res, clientResult.rows[0]);
    } else if (grantType === "refresh_token") {
      await handleRefreshTokenGrant(req, res, clientResult.rows[0]);
    } else {
      oauthError(res, "unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
    }
  } catch (err) {
    console.error("[token] Error:", err);
    oauthError(res, "server_error", "Internal server error", 500);
  }
});

async function handleAuthorizationCodeGrant(req: Request, res: Response, client: any) {
  const code = req.body.code;
  const redirectUri = req.body.redirect_uri;
  const codeVerifier = req.body.code_verifier;

  if (!code) {
    oauthError(res, "invalid_request", "Missing required parameter: code");
    return;
  }
  if (!redirectUri) {
    oauthError(res, "invalid_request", "Missing required parameter: redirect_uri");
    return;
  }
  if (!codeVerifier) {
    oauthError(res, "invalid_request", "Missing required parameter: code_verifier");
    return;
  }
  if (!validateCodeVerifier(codeVerifier)) {
    oauthError(res, "invalid_request", "Invalid code_verifier format");
    return;
  }

  const authCodeResult = await db.query(
    `SELECT * FROM mcp_authorization_codes WHERE code = $1 AND client_id = $2 AND used = false`,
    [code, client.client_id],
  );

  if (authCodeResult.rows.length === 0) {
    oauthError(res, "invalid_grant", "Invalid authorization code");
    return;
  }

  const authCode = authCodeResult.rows[0];

  if (new Date(authCode.expires_at) < new Date()) {
    oauthError(res, "invalid_grant", "Authorization code expired");
    return;
  }

  if (authCode.redirect_uri !== redirectUri) {
    oauthError(res, "invalid_grant", "redirect_uri mismatch");
    return;
  }

  const pkceValid = verifyCodeChallenge(
    codeVerifier,
    authCode.code_challenge,
    authCode.code_challenge_method as "S256" | "plain",
  );

  if (!pkceValid) {
    oauthError(res, "invalid_grant", "Invalid code_verifier");
    return;
  }

  // Mark code as used
  await db.query(
    `UPDATE mcp_authorization_codes SET used = true, used_at = NOW() WHERE id = $1`,
    [authCode.id],
  );

  const tokens = await generateAccessToken({
    userId: authCode.user_id,
    workspaceSlug: authCode.workspace_slug,
    clientId: client.client_id,
    scope: authCode.scope || "",
  });

  console.log(`[token] Issued access token for user ${authCode.user_id}`);

  res.json({
    access_token: tokens.accessToken,
    token_type: tokens.tokenType,
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: authCode.scope || "",
  });
}

async function handleRefreshTokenGrant(req: Request, res: Response, _client: any) {
  const refreshToken = req.body.refresh_token;

  if (!refreshToken) {
    oauthError(res, "invalid_request", "Missing required parameter: refresh_token");
    return;
  }

  const tokens = await refreshAccessTokenFn(refreshToken);

  if (!tokens) {
    oauthError(res, "invalid_grant", "Invalid or expired refresh token");
    return;
  }

  console.log("[token] Refreshed access token");

  res.json({
    access_token: tokens.accessToken,
    token_type: tokens.tokenType,
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
  });
}

export default router;
