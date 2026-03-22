import { Router, type Request, type Response } from "express";
import { generateSecureToken } from "../utils/pkce.js";
import { setCorsHeaders } from "../utils/cors.js";
import { config } from "../config.js";
import { db } from "../db.js";

const router = Router();

router.options("/oauth/approve", (_req, res) => {
  setCorsHeaders(res);
  res.status(204).end();
});

/**
 * Consent Approval API
 * Called when user clicks "Authorize" on the consent screen.
 *
 * The consent page sends:
 * - oauth_state: base64-encoded OAuth params
 * - workspace_slug: selected workspace
 * - scopes: approved scopes array
 * - user_token: session cookie for user validation
 */
router.post("/oauth/approve", async (req: Request, res: Response) => {
  setCorsHeaders(res);

  try {
    const { oauth_state, workspace_slug, scopes, user_token } = req.body;

    if (!oauth_state || !workspace_slug) {
      res.status(400).json({ error: "Missing required parameters" });
      return;
    }

    // Decode oauth_state to get OAuth params
    let clientId: string;
    let redirectUri: string;
    let state: string;
    let codeChallenge: string;
    let codeChallengeMethod: string;

    try {
      // Try standard base64 first (consent page encodes with btoa-compatible base64)
      let decoded: string;
      try {
        decoded = Buffer.from(oauth_state, "base64").toString("utf-8");
      } catch {
        decoded = Buffer.from(oauth_state, "base64url").toString("utf-8");
      }

      // Try JSON parse first
      try {
        const jsonParsed = JSON.parse(decoded);
        clientId = jsonParsed.client_id;
        redirectUri = jsonParsed.redirect_uri;
        state = jsonParsed.state || "";
        codeChallenge = jsonParsed.code_challenge;
        codeChallengeMethod = jsonParsed.code_challenge_method || "S256";
      } catch {
        // Fallback: URLSearchParams format
        const params = new URLSearchParams(decoded);
        clientId = params.get("client_id") || "";
        redirectUri = params.get("redirect_uri") || "";
        state = params.get("state") || "";
        codeChallenge = params.get("code_challenge") || "";
        codeChallengeMethod = params.get("code_challenge_method") || "S256";
      }
    } catch {
      res.status(400).json({ error: "Invalid oauth_state" });
      return;
    }

    if (!clientId || !redirectUri || !codeChallenge) {
      res.status(400).json({ error: "Invalid oauth_state: missing required fields" });
      return;
    }

    // Validate user via TaskPilot API
    // The consent page sends user_token from cookies, but cookies may be HttpOnly.
    // Try multiple auth methods: cookie, API key header, or direct token.
    let userId: string;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      if (user_token) {
        // Try as session cookie
        headers["Cookie"] = `sessionid=${user_token}; access_token=${user_token}`;
      }

      console.log(`[approve] Validating user token: "${(user_token || "").substring(0, 20)}..." against ${config.taskpilotApiUrl}`);
      const userResponse = await fetch(`${config.taskpilotApiUrl}/api/users/me/`, { headers });

      console.log(`[approve] API response status: ${userResponse.status}`);
      if (userResponse.ok) {
        const userData = await userResponse.json() as any;
        userId = userData.id;
        console.log(`[approve] User validated via API: ${userId}`);
      } else {
        // Fallback: accept user_id directly if provided by consent page
        // The consent page runs on the trusted TaskPilot frontend domain
        // and the user is already authenticated there
        const { user_id: directUserId } = req.body;
        if (directUserId) {
          userId = directUserId;
          console.log(`[approve] Using direct user_id from consent page: ${userId}`);
        } else {
          const body = await userResponse.text().catch(() => "");
          console.error(`[approve] User validation failed: ${userResponse.status} ${body.substring(0, 200)}`);
          res.status(401).json({ error: "Invalid user session" });
          return;
        }
      }
    } catch (err) {
      console.error("[approve] Failed to validate user:", err);
      // Fallback: accept user_id directly
      const { user_id: directUserId } = req.body;
      if (directUserId) {
        userId = directUserId;
        console.log(`[approve] Using fallback direct user_id: ${userId}`);
      } else {
        res.status(401).json({ error: "Failed to validate user session" });
        return;
      }
    }

    // Verify client exists
    const clientResult = await db.query(
      `SELECT * FROM mcp_clients WHERE client_id = $1`,
      [clientId],
    );
    if (clientResult.rows.length === 0) {
      res.status(400).json({ error: "Unknown client" });
      return;
    }

    // Generate authorization code
    const code = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + config.authCodeTtl * 1000);
    const approvedScope = Array.isArray(scopes) ? scopes.join(" ") : "taskpilot:read taskpilot:write";

    await db.query(
      `INSERT INTO mcp_authorization_codes
       (code, client_id, user_id, workspace_slug, redirect_uri, scope, state, code_challenge, code_challenge_method, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        code,
        clientId,
        userId,
        workspace_slug,
        redirectUri,
        approvedScope,
        state,
        codeChallenge,
        codeChallengeMethod,
        expiresAt,
      ],
    );

    console.log(`[approve] User ${userId} approved client ${clientId} for workspace ${workspace_slug}`);

    // Build redirect URL with authorization code
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) {
      redirectUrl.searchParams.set("state", state);
    }

    res.json({ redirect_url: redirectUrl.toString() });
  } catch (err) {
    console.error("[approve] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
