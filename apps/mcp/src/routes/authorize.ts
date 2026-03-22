import { Router, type Request, type Response } from "express";
import { validateCodeChallengeMethod } from "../utils/pkce.js";
import { validateScopes } from "../utils/tokens.js";
import { setCorsHeaders } from "../utils/cors.js";
import { config } from "../config.js";
import { db } from "../db.js";

const router = Router();

router.options(["/mcp-server/authorize", "/authorize"], (_req, res) => {
  setCorsHeaders(res);
  res.status(204).end();
});

/**
 * OAuth 2.1 Authorization Endpoint
 * Copied from Inbox's working implementation — the exact same flow.
 *
 * Flow:
 * 1. Client redirects user here with OAuth params
 * 2. We validate params and look up the client
 * 3. We redirect to consent page with base64-encoded oauth_state
 * 4. User approves on consent page → consent page calls /oauth/approve
 */
router.get(["/mcp-server/authorize", "/authorize"], async (req: Request, res: Response) => {
  setCorsHeaders(res);

  try {
    const searchParams = req.query;

    // Support base64-encoded oauth_state parameter (like Inbox/MeetEcho)
    const oauthState = searchParams.oauth_state as string | undefined;
    let clientId: string | undefined;
    let redirectUri: string | undefined;
    let responseType: string | undefined;
    let scope: string;
    let state: string;
    let codeChallenge: string | undefined;
    let codeChallengeMethod: string;

    if (oauthState) {
      try {
        const decoded = Buffer.from(oauthState, "base64url").toString("utf-8");
        const params = new URLSearchParams(decoded);
        clientId = params.get("client_id") || undefined;
        redirectUri = params.get("redirect_uri") || undefined;
        responseType = params.get("response_type") || undefined;
        scope = params.get("scope") || "";
        state = params.get("state") || "";
        codeChallenge = params.get("code_challenge") || undefined;
        codeChallengeMethod = params.get("code_challenge_method") || "S256";
      } catch {
        res.status(400).json({ error: "Invalid oauth_state parameter" });
        return;
      }
    } else {
      clientId = searchParams.client_id as string | undefined;
      redirectUri = searchParams.redirect_uri as string | undefined;
      responseType = searchParams.response_type as string | undefined;
      scope = (searchParams.scope as string) || "";
      state = (searchParams.state as string) || "";
      codeChallenge = searchParams.code_challenge as string | undefined;
      codeChallengeMethod = (searchParams.code_challenge_method as string) || "S256";
    }

    // Validate required parameters
    if (!clientId) {
      res.status(400).json({ error: "Missing required parameter: client_id" });
      return;
    }
    if (!redirectUri) {
      res.status(400).json({ error: "Missing required parameter: redirect_uri" });
      return;
    }
    if (responseType !== "code") {
      res.status(400).json({
        error: "Invalid response_type. Only 'code' is supported",
      });
      return;
    }
    if (!codeChallenge) {
      res.status(400).json({
        error: "Missing required parameter: code_challenge. PKCE is mandatory.",
      });
      return;
    }
    if (!validateCodeChallengeMethod(codeChallengeMethod)) {
      res.status(400).json({
        error: `Invalid code_challenge_method: ${codeChallengeMethod}`,
      });
      return;
    }

    // Validate scopes
    if (scope && !validateScopes(scope)) {
      res.status(400).json({ error: "Invalid scope requested" });
      return;
    }

    // Verify client exists
    const clientResult = await db.query(
      `SELECT * FROM mcp_clients WHERE client_id = $1`,
      [clientId],
    );

    if (clientResult.rows.length === 0) {
      console.warn(`[authorize] Unknown client_id: ${clientId}`);
      res.status(400).json({ error: "Unknown client" });
      return;
    }

    const client = clientResult.rows[0];

    // Validate redirect_uri format (like Inbox)
    try {
      const parsedRedirect = new URL(redirectUri);
      const isLocalhost = ["localhost", "127.0.0.1"].includes(parsedRedirect.hostname);
      if (
        !isLocalhost &&
        parsedRedirect.protocol !== "https:" &&
        parsedRedirect.protocol !== "claude:"
      ) {
        res.status(400).json({ error: "redirect_uri must use HTTPS (except localhost)" });
        return;
      }
    } catch {
      res.status(400).json({ error: "Invalid redirect_uri format" });
      return;
    }

    // Build consent page redirect with base64-encoded JSON state
    // The consent page uses atob() + JSON.parse(), so we must use standard base64 + JSON
    // Include ALL OAuth params so the approve endpoint can recover them
    const consentPayload = JSON.stringify({
      client_id: clientId,
      client_name: client.client_name || "MCP Client",
      redirect_uri: redirectUri,
      scope: scope || "taskpilot:read taskpilot:write",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
    });

    // Use standard base64 (not base64url) because consent page uses atob()
    const encodedConsent = Buffer.from(consentPayload).toString("base64");
    const consentUrl = `${config.frontendUrl}/oauth/consent?oauth_state=${encodeURIComponent(encodedConsent)}`;

    console.log(`[authorize] Redirecting to consent: ${consentUrl}`);
    res.redirect(consentUrl);
  } catch (err) {
    console.error("[authorize] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
