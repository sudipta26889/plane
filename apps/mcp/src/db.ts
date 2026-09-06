import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
});

async function initA2aDatabase(client: any): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS a2a_tasks (
      id SERIAL PRIMARY KEY,
      task_id VARCHAR(255) UNIQUE NOT NULL,
      context_id VARCHAR(255) NOT NULL,
      client_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      workspace_slug VARCHAR(255) NOT NULL,
      skill VARCHAR(100) NOT NULL,
      input JSONB NOT NULL,
      state VARCHAR(50) NOT NULL DEFAULT 'submitted',
      state_reason TEXT,
      result JSONB,
      error JSONB,
      requires_approval BOOLEAN DEFAULT false,
      idempotency_key VARCHAR(255),
      retry_count INT DEFAULT 0,
      max_retries INT DEFAULT 3,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS a2a_task_history (
      id SERIAL PRIMARY KEY,
      task_id VARCHAR(255) NOT NULL,
      from_state VARCHAR(50),
      to_state VARCHAR(50) NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS a2a_approvals (
      id SERIAL PRIMARY KEY,
      task_id VARCHAR(255) UNIQUE NOT NULL,
      skill VARCHAR(100) NOT NULL,
      request_data JSONB NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      dharahil_request_id VARCHAR(255),
      dharahil_channel VARCHAR(50),
      responded_by VARCHAR(255),
      expires_at TIMESTAMPTZ NOT NULL,
      responded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS a2a_webhook_configs (
      id SERIAL PRIMARY KEY,
      client_id VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      secret VARCHAR(255) NOT NULL,
      events JSONB DEFAULT '[]',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(client_id, url)
    );

    CREATE TABLE IF NOT EXISTS a2a_webhook_deliveries (
      id SERIAL PRIMARY KEY,
      webhook_config_id INT NOT NULL,
      task_id VARCHAR(255) NOT NULL,
      event VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      attempts INT DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      next_retry_at TIMESTAMPTZ,
      response_status INT,
      response_body TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS a2a_audit_logs (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255),
      client_id VARCHAR(255),
      ip_address VARCHAR(45),
      operation VARCHAR(100) NOT NULL,
      task_id VARCHAR(255),
      skill VARCHAR(100),
      success BOOLEAN NOT NULL,
      error_code VARCHAR(50),
      error_message TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS a2a_conversations (
      id SERIAL PRIMARY KEY,
      context_id VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL,
      content TEXT,
      tool_calls JSONB,
      tool_call_id VARCHAR(255),
      name VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS a2a_agent_runs (
      task_id VARCHAR(255) PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_task_id ON a2a_tasks(task_id);
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context_id ON a2a_tasks(context_id);
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_client_state ON a2a_tasks(client_id, state);
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_idempotency ON a2a_tasks(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_a2a_task_history_task_id ON a2a_task_history(task_id);
    CREATE INDEX IF NOT EXISTS idx_a2a_approvals_task_id ON a2a_approvals(task_id);
    CREATE INDEX IF NOT EXISTS idx_a2a_approvals_status ON a2a_approvals(status);
    CREATE INDEX IF NOT EXISTS idx_a2a_audit_logs_created ON a2a_audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_a2a_webhook_deliveries_status ON a2a_webhook_deliveries(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_a2a_conversations_context ON a2a_conversations(context_id, created_at);
  `);
  console.log("[db] A2A schema initialized");
}

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
    await initA2aDatabase(client);
  } finally {
    client.release();
  }
}
