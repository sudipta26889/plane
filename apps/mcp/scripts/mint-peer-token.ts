/**
 * Mint a long-lived A2A bearer token for a machine peer (e.g. OpenClaw/Mitra).
 *
 * Peers hold a static credential rather than running the OAuth authorization-code
 * flow, so they cannot refresh. `config.accessTokenTtl` (1 hour) is therefore the
 * wrong lifetime here; this mints a token with an explicit long expiry instead.
 *
 * Revoke one at any time without redeploying:
 *   UPDATE mcp_access_tokens SET revoked = true WHERE client_id = 'peer_mitra';
 *
 * Usage:
 *   npx tsx scripts/mint-peer-token.ts <peer-name> <user-email> <workspace-slug> [days]
 */
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { createJwtToken, type McpTokenPayload } from "../src/utils/tokens.js";
import { generateSecureToken } from "../src/utils/pkce.js";

const [peerName, email, workspaceSlug, daysArg] = process.argv.slice(2);
const days = parseInt(daysArg || "365", 10);

// Least privilege: these are the only two scopes any A2A skill checks.
const SCOPE = "taskpilot:read taskpilot:write";

if (!peerName || !email || !workspaceSlug) {
  console.error(
    "Usage: npx tsx scripts/mint-peer-token.ts <peer-name> <user-email> <workspace-slug> [days]",
  );
  process.exit(1);
}

async function main() {
  const user = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (user.rows.length === 0) throw new Error(`No user with email ${email}`);
  const userId = String(user.rows[0].id);

  const workspace = await db.query(`SELECT id FROM workspaces WHERE slug = $1`, [workspaceSlug]);
  if (workspace.rows.length === 0) throw new Error(`No workspace with slug ${workspaceSlug}`);

  // The token binds a user to a workspace, so the peer can only act where that
  // user is a member. Refuse rather than mint a token that would fail later.
  const member = await db.query(
    `SELECT 1 FROM workspace_members
     WHERE member_id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [userId, workspace.rows[0].id],
  );
  if (member.rows.length === 0) {
    throw new Error(`${email} is not a member of workspace ${workspaceSlug}`);
  }

  const clientId = `peer_${peerName}`;
  await db.query(
    `INSERT INTO mcp_clients (client_id, client_name, scope, token_endpoint_auth_method)
     VALUES ($1, $2, $3, 'none')
     ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, updated_at = NOW()`,
    [clientId, `A2A peer: ${peerName}`, SCOPE],
  );

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + days * 24 * 60 * 60;
  const jti = generateSecureToken();

  const payload: McpTokenPayload = {
    sub: userId,
    workspace_slug: workspaceSlug,
    client_id: clientId,
    scope: SCOPE,
    exp: expiresAt,
    iat: now,
    jti,
    token_type: "access",
  };

  const accessToken = createJwtToken(payload, config.jwtSecret);

  // validateAccessToken looks the row up by jti and checks only `revoked`;
  // expiry is enforced by the JWT's own exp claim.
  await db.query(
    `INSERT INTO mcp_access_tokens
     (access_token, token_type, scope, expires_at, user_id, workspace_slug, client_id)
     VALUES ($1, 'Bearer', $2, $3, $4, $5, $6)`,
    [jti, SCOPE, new Date(expiresAt * 1000), userId, workspaceSlug, clientId],
  );

  console.log(`peer:       ${peerName}`);
  console.log(`client_id:  ${clientId}`);
  console.log(`user:       ${email}`);
  console.log(`workspace:  ${workspaceSlug}`);
  console.log(`scope:      ${SCOPE}`);
  console.log(`expires:    ${new Date(expiresAt * 1000).toISOString()} (${days} days)`);
  console.log(`\ntoken:\n${accessToken}`);

  await db.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
