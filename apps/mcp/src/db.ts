import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function initDatabase(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS mcp_clients (
        id SERIAL PRIMARY KEY,
        client_id VARCHAR(255) UNIQUE NOT NULL,
        client_secret VARCHAR(255),
        client_name VARCHAR(255) DEFAULT 'MCP Client',
        redirect_uris JSONB DEFAULT '[]'::jsonb,
        grant_types JSONB DEFAULT '["authorization_code","refresh_token"]'::jsonb,
        response_types JSONB DEFAULT '["code"]'::jsonb,
        token_endpoint_auth_method VARCHAR(50) DEFAULT 'none',
        scope VARCHAR(512) DEFAULT '',
        logo_uri VARCHAR(512),
        tos_uri VARCHAR(512),
        policy_uri VARCHAR(512),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS mcp_authorization_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(255) UNIQUE NOT NULL,
        client_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        workspace_slug VARCHAR(255) NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope VARCHAR(512) DEFAULT '',
        state VARCHAR(512) DEFAULT '',
        code_challenge VARCHAR(255) NOT NULL,
        code_challenge_method VARCHAR(10) DEFAULT 'S256',
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT false,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS mcp_access_tokens (
        id SERIAL PRIMARY KEY,
        access_token VARCHAR(255) NOT NULL,
        refresh_token VARCHAR(255),
        token_type VARCHAR(50) DEFAULT 'Bearer',
        scope VARCHAR(512) DEFAULT '',
        expires_at TIMESTAMPTZ NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        workspace_slug VARCHAR(255) NOT NULL,
        client_id VARCHAR(255) NOT NULL,
        revoked BOOLEAN DEFAULT false,
        revoked_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_clients_client_id ON mcp_clients(client_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_auth_codes_code ON mcp_authorization_codes(code);
      CREATE INDEX IF NOT EXISTS idx_mcp_access_tokens_access ON mcp_access_tokens(access_token);
      CREATE INDEX IF NOT EXISTS idx_mcp_access_tokens_refresh ON mcp_access_tokens(refresh_token);
    `);
    console.log("[db] Schema initialized");
  } finally {
    client.release();
  }
}
