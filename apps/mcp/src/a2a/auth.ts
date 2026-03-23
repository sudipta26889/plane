import type { Request } from "express";
import { validateAccessToken } from "../utils/tokens.js";
import type { AuthContext } from "./types.js";

export function hasRequiredScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
}

/**
 * Authenticate an A2A request. Extracts Bearer token from:
 * 1. Authorization header (Bearer <token>)
 * 2. Query param `token` (for SSE EventSource compatibility)
 *
 * Returns AuthContext on success, throws on failure.
 */
export async function authenticateA2aRequest(req: Request): Promise<AuthContext> {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  if (!token && typeof req.query.token === "string") {
    token = req.query.token;
  }

  if (!token) {
    throw new Error("Authorization required");
  }

  const payload = await validateAccessToken(token);
  if (!payload) {
    throw new Error("Invalid or expired access token");
  }

  return {
    userId: payload.sub,
    workspaceSlug: payload.workspace_slug,
    clientId: payload.client_id,
    scopes: payload.scope ? payload.scope.split(" ") : [],
  };
}
