import { Router, type Request, type Response } from "express";
import express from "express";
import { revokeAccessTokenFn } from "../utils/tokens.js";
import { setCorsHeaders, noCacheHeaders } from "../utils/cors.js";

const router: Router = Router();

router.use(["/mcp-server/revoke", "/revoke"], express.urlencoded({ extended: true }));

router.options(["/mcp-server/revoke", "/revoke"], (_req, res) => {
  setCorsHeaders(res);
  res.status(204).end();
});

/**
 * OAuth 2.0 Token Revocation Endpoint (RFC 7009)
 * Always returns 200 per spec.
 */
router.post(["/mcp-server/revoke", "/revoke"], async (req: Request, res: Response) => {
  setCorsHeaders(res);
  noCacheHeaders(res);

  try {
    const token = req.body.token;
    if (!token) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "Missing required parameter: token",
      });
      return;
    }

    await revokeAccessTokenFn(token);
    console.log("[revoke] Token revoked");
  } catch (err) {
    console.error("[revoke] Error:", err);
  }

  // RFC 7009: always return 200
  res.status(200).end();
});

export default router;
