# TaskPilot A2A (Agent-to-Agent) Protocol — Design Spec

**Date**: 2026-03-23
**Status**: Approved
**Author**: Sudipta + Claude

## Overview

Add A2A v0.3 protocol support to TaskPilot's existing MCP server (`apps/mcp`). This turns TaskPilot from a "tool that agents call" into an "agent that collaborates with other agents." MCP handles synchronous tool calls; A2A handles async tasks, HITL approvals, webhooks, and streaming.

Both protocols coexist on the same Express server:
- `/mcp-server` — existing MCP endpoint (unchanged)
- `/a2a` — new A2A JSON-RPC endpoint
- `/.well-known/agent-card.json` — A2A discovery
- `/a2a/stream` — SSE streaming
- `/a2a/llms.txt` — AI-readable documentation

## Architecture

### Approach

A2A wraps existing MCP handlers. The A2A `task-executor` maps each A2A skill to the existing MCP tool handler functions via `executeToolCall()` from `handlers.ts`. No changes to MCP tools — A2A is purely additive.

### File Structure

```
apps/mcp/src/
├── a2a/
│   ├── agent-card.ts          # Agent Card definition & route
│   ├── protocol-handler.ts    # JSON-RPC method dispatch
│   ├── task-executor.ts       # Async task state machine, wraps MCP handlers
│   ├── skill-registry.ts      # A2A skills → MCP tools + scopes + HITL config
│   ├── auth.ts                # A2A auth (reuses existing OAuth tokens)
│   ├── rate-limit.ts          # Multi-tier rate limiting
│   ├── audit-log.ts           # Operation audit trail
│   ├── webhooks.ts            # HMAC-signed webhook delivery with retries
│   ├── sse.ts                 # Server-Sent Events for task streaming
│   ├── dharahil.ts            # DharaHIL HITL client integration
│   └── types.ts               # Shared A2A types
├── routes/
│   ├── ... (existing MCP routes, unchanged)
│   └── a2a.ts                 # Express router: POST /a2a, GET /a2a/stream, etc.
├── tools/
│   └── ... (existing, unchanged)
├── db.ts                      # Extended with A2A tables
├── config.ts                  # Extended with A2A + DharaHIL config
└── index.ts                   # Adds A2A routes
```

## Database Schema

7 new tables added to `initDatabase()`:

```sql
-- A2A async tasks
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

-- State transition audit trail
CREATE TABLE IF NOT EXISTS a2a_task_history (
  id SERIAL PRIMARY KEY,
  task_id VARCHAR(255) NOT NULL,
  from_state VARCHAR(50),
  to_state VARCHAR(50) NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- HITL approvals
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

-- Rate limiting (uses Redis for counters; this table for config/audit only)
-- Primary rate limiting uses Redis (already configured in config.redisUrl)
-- Keys: "a2a:rl:client:<id>:min", "a2a:rl:user:<id>:hour", etc.
-- TTL-based expiry in Redis (no cleanup needed)

-- Webhook configs
CREATE TABLE IF NOT EXISTS a2a_webhook_configs (
  id SERIAL PRIMARY KEY,
  client_id VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  UNIQUE(client_id, url),
  secret VARCHAR(255) NOT NULL,
  events JSONB DEFAULT '[]',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook delivery tracking
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

-- Audit logs
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
```

Indexes on: `a2a_tasks(task_id)`, `a2a_tasks(context_id)`, `a2a_tasks(client_id, state)`, `a2a_tasks(idempotency_key)`, `a2a_task_history(task_id)`, `a2a_approvals(task_id)`, `a2a_approvals(status)`, `a2a_audit_logs(created_at)`, `a2a_webhook_deliveries(status, next_retry_at)`.

6 tables in PostgreSQL. Rate limiting uses Redis (already available via `config.redisUrl`).

## Agent Card & Discovery

`GET /.well-known/agent-card.json` returns:

```json
{
  "name": "TaskPilot",
  "description": "AI-native project management agent — create, track, and manage tasks across projects",
  "version": "1.0.0",
  "protocol": "a2a",
  "protocolVersion": "0.3",
  "url": "https://mcp.taskpilot.sudiptadhara.in/a2a",
  "authentication": {
    "type": "oauth2",
    "flows": {
      "authorizationCode": {
        "authorizationUrl": "https://mcp.taskpilot.sudiptadhara.in/authorize",
        "tokenUrl": "https://mcp.taskpilot.sudiptadhara.in/token",
        "scopes": {
          "taskpilot:read": "Read projects, tasks, members, labels, cycles",
          "taskpilot:write": "Create/update/move tasks, assign, label"
        }
      }
    }
  },
  "capabilities": {
    "streaming": true,
    "webhooks": true,
    "humanInTheLoop": true
  },
  "skills": [ "...see Skill Registry section..." ],
  "rateLimits": {
    "clientPerMinute": 60,
    "clientPerHour": 1000,
    "userPerMinute": 100
  }
}
```

`GET /a2a/llms.txt` — plain-text documentation for AI agent consumption covering auth flow, all skills, request/response examples, and error codes.

## Skill Registry

Maps A2A skill names → MCP tool names, scopes, and HITL policy:

| A2A Skill | MCP Tool | Scope | HITL |
|-----------|----------|-------|------|
| `task.create` | `create_task` | `taskpilot:write` | No |
| `task.update` | `update_task` | `taskpilot:write` | No |
| `task.find` | `find_tasks` | `taskpilot:read` | No |
| `task.get` | `get_task` | `taskpilot:read` | No |
| `task.move` | `move_task` | `taskpilot:write` | Conditional* |
| `task.summarize` | `get_task_summary` | `taskpilot:read` | No |
| `task.assign` | `assign_task` | `taskpilot:write` | No |
| `task.unassign` | `unassign_task` | `taskpilot:write` | No |
| `label.add` | `add_label` | `taskpilot:write` | No |
| `label.remove` | `remove_label` | `taskpilot:write` | No |
| `comment.add` | `add_comment` | `taskpilot:write` | No |
| `cycle.assign` | `assign_to_cycle` | `taskpilot:write` | No |
| `project.list` | `list_projects` | `taskpilot:read` | No |
| `project.list_states` | `list_states` | `taskpilot:read` | No |
| `project.list_members` | `list_members` | `taskpilot:read` | No |
| `project.list_labels` | `list_labels` | `taskpilot:read` | No |
| `project.list_cycles` | `list_cycles` | `taskpilot:read` | No |
| `project.list_tasks` | `list_tasks` | `taskpilot:read` | No |

*Conditional HITL: `task.move` to "Cancelled" state requires approval. All other state transitions proceed without approval.

## Task State Machine

States per A2A v0.3 spec:

```
submitted → working → completed
                   → failed
         → auth_required → (approved) → submitted
                         → (rejected) → rejected
                         → (expired)  → rejected
         → canceled  (client-initiated)
```

Terminal states (immutable): `completed`, `failed`, `canceled`, `rejected`.

**Terminology note:** A2A task state `canceled` (client cancels an A2A task via `task.cancel`) is distinct from TaskPilot workflow state "Cancelled" (moving a TaskPilot issue to the Cancelled state via `task.move`/`move_task`). The former is an A2A protocol operation; the latter is a project management action that triggers HITL.

Every state transition is recorded in `a2a_task_history`.

## Execution Flow

When `message.send` arrives:

1. Validate JSON-RPC structure
2. Authenticate (reuse existing OAuth Bearer token validation)
3. Check rate limits
4. Look up skill in registry, validate scope
5. Check if HITL approval is required:
   - **YES** → Insert `a2a_tasks` (state: `auth_required`), insert `a2a_approvals`, submit to DharaHIL, return `taskId` + `state: auth_required`
   - **NO** → Insert `a2a_tasks` (state: `submitted`), transition to `working`, call `executeToolCall(mcpTool, args, authContext)` inline
6. On success → state `completed`, store result
7. On error → retry up to 3x, then state `failed`
8. Record transitions in `a2a_task_history`
9. Log to `a2a_audit_logs`
10. Queue webhook deliveries
11. Notify SSE listeners

Non-HITL tasks execute **inline** (synchronous) since MCP tool calls are fast (sub-second). The client gets the result in the same response.

HITL tasks are **async**: client polls via `task.get` or listens on SSE. A background interval (every 30s) polls DharaHIL for decisions.

## JSON-RPC Methods

| Method | Purpose | Auth Required |
|--------|---------|---------------|
| `initialize` | Protocol handshake, returns capabilities | No |
| `message.send` | Execute a skill, returns taskId + state | Yes |
| `task.get` | Get task status + result by taskId | Yes |
| `task.list` | List tasks in a contextId | Yes |
| `task.cancel` | Cancel a pending/auth_required task | Yes |
| `context.get` | List all tasks within a contextId | Yes |

## DharaHIL Integration

TaskPilot is a **DharaHIL client**. It submits approval requests and polls for decisions. The gateway controls TTL, message formatting, and notification delivery.

**DharaHIL applies to both MCP and A2A.** The DharaHIL client module (`src/a2a/dharahil.ts`) is shared. Critical actions require human approval regardless of which protocol initiated them.

### Critical actions requiring HITL:

| Action | Trigger | Risk Level |
|--------|---------|------------|
| Cancel a task | `move_task` / `task.move` to "Cancelled" state | MEDIUM |

All other operations (create, update, assign, label, comment, etc.) proceed without approval via both MCP and A2A.

### MCP HITL flow:

HITL check is inserted **inside `executeToolCall()`** in `handlers.ts`, before calling the handler function. The function signature does not change — it still returns `Promise<any>`, but now may block while awaiting approval.

When a critical action is triggered via MCP:

1. `executeToolCall()` checks if `(toolName, args)` matches a critical action rule (e.g., `move_task` where `args.state` matches "Cancelled" case-insensitively)
2. If yes and `DHARAHIL_ENABLED=true` → call `dharahilClient.runApprovalLoop()`, block until decision
3. APPROVED → execute handler, return result
4. REJECTED/EXPIRED/ERROR → throw error to MCP client
5. If not a critical action → execute handler normally (existing behavior)

This makes MCP write tools **synchronous-blocking** during approval. TaskPilot enforces a **60-second max wait** regardless of gateway TTL. If the gateway sets a longer TTL and no decision arrives within 60s, TaskPilot returns a timeout error to the MCP client. The human can still approve via Slack/Telegram, but the MCP request will have already returned.

### DharaHIL unavailability:

**Fail-closed.** If the DharaHIL gateway is unreachable during a critical action:
- MCP: `executeToolCall()` throws an error — the critical action is blocked
- A2A: task moves to `failed` state with error "Approval gateway unreachable"

Non-critical actions are unaffected — they never contact DharaHIL.

### A2A HITL flow:

When a critical action is triggered via A2A (`message.send`):

1. Task created with state `auth_required`
2. Submit to DharaHIL
3. Return taskId + state to client immediately (async)
4. Background polling picks up decision
5. APPROVED → execute → completed
6. REJECTED/EXPIRED → rejected

### What TaskPilot controls:
- Whether to submit for approval (critical action rules, shared between MCP and A2A)
- Risk level assignment (`MEDIUM` for task cancellation)
- Request context: `toolName`, `toolArgs`, `contextSummary`, `riskLevel`, `tags`, `idempotencyKey`
- Polling interval (3 seconds)
- Decision handling: APPROVED → execute, REJECTED/EXPIRED → reject, REVISE → treat as reject for task operations

### What DharaHIL gateway controls:
- TTL (`expires_at` in response)
- Message formatting for Slack/Telegram
- Notification delivery
- Decision storage

### Config additions:
```typescript
dharahilBaseUrl: process.env.DHARAHIL_BASE_URL,
dharahilApiKey: process.env.DHARAHIL_API_KEY,
dharahilTenantId: process.env.DHARAHIL_TENANT_ID,
dharahilAppId: process.env.DHARAHIL_APP_ID,
dharahilEnabled: process.env.DHARAHIL_ENABLED === "true",
```

When `DHARAHIL_ENABLED=false`, critical actions execute without approval (dev mode).

### Example submission (same for both MCP and A2A):
```typescript
dharahilClient.runApprovalLoop({
  toolName: "move_task",
  toolArgs: { identifier: "PROJ-42", state: "Cancelled" },
  context: {
    agentId: "taskpilot-mcp",  // or "taskpilot-a2a"
    runId: userId,
    stepId: taskId,
    contextSummary: `Cancel task PROJ-42: "Fix login bug" in project WebApp`,
    riskLevel: "MEDIUM",
    tags: ["taskpilot", "task.move", "cancel"],
    idempotencyKey: `task_move_PROJ-42_cancelled_${Date.now()}`,
  },
});
```

## Rate Limiting

Multi-tier, using Redis (already configured via `config.redisUrl`):

| Tier | Limit | Scope |
|------|-------|-------|
| Client/minute | 60 | Per OAuth client |
| Client/hour | 1000 | Per OAuth client |
| User/minute | 100 | Per authenticated user |
| User/hour | 2000 | Per authenticated user |
| Task create/minute | 30 | `message.send` specifically |
| IP/minute | 20 | Unauthenticated requests (`initialize`) |

Sliding window approach using Redis INCR + EXPIRE. Keys auto-expire — no cleanup needed.

Response headers on every `/a2a` response:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 57
X-RateLimit-Reset: 1711180800
Retry-After: 12          (only when limit exceeded)
```

Rate limit exceeded returns JSON-RPC error code `-32003`.

## Webhooks

Clients register webhook endpoints via `message.send` with a special `webhook.configure` skill (not in the skill registry — handled directly by the protocol handler). Accepts `url`, `secret`, and `events` array. Deliveries are triggered on task state changes.

- **Events**: `task.created`, `task.state_changed`, `task.completed`, `task.failed`, `task.canceled`, `task.rejected`, `task.approval_required`
- **Signing**: HMAC-SHA256 — `X-Webhook-Signature: sha256=<hmac(payload, secret)>`
- **Retries**: Exponential backoff — 1s, 5s, 15s, 1min, 5min (5 attempts max)
- **Delivery**: Inline after state transition (non-blocking fire-and-forget HTTP)

Webhook payload:
```json
{
  "event": "task.completed",
  "timestamp": "2026-03-23T16:30:00Z",
  "task": {
    "id": "task_xyz123",
    "context_id": "ctx_abc456",
    "skill": "task.create",
    "state": "completed",
    "result": { "...": "..." },
    "created_at": "...",
    "completed_at": "..."
  }
}
```

## SSE Streaming

`GET /a2a/stream?taskId=<id>` — Bearer auth required (token passed via query param `token` since `EventSource` does not support custom headers). Primarily for server-to-server A2A use.

Event types:
```
event: ping           → every 15s keepalive
event: task.state_changed → state transitions
event: task.completed  → final result
event: final          → connection closes
```

5-minute max connection. Auto-closes on terminal state.

## Audit Logging

Every `/a2a` request logged to `a2a_audit_logs`:

Fields: `userId`, `clientId`, `ipAddress`, `operation`, `taskId`, `skill`, `success`, `errorCode`, `errorMessage`, `metadata` (including `duration_ms`).

Events tracked: `auth.success`, `auth.failure`, `task.created`, `task.executed`, `task.completed`, `task.failed`, `task.canceled`, `approval.requested`, `approval.approved`, `approval.rejected`, `rate_limit.exceeded`, `webhook.delivered`, `webhook.failed`.

## Data Retention

- `a2a_tasks`, `a2a_task_history`: 90-day retention. A background cleanup deletes completed/failed/canceled tasks older than 90 days.
- `a2a_audit_logs`: 90-day retention.
- `a2a_webhook_deliveries`: 30-day retention.
- `a2a_approvals`: 90-day retention (aligned with tasks).
- Rate limiting: Redis TTL-based, auto-expires.

## What Changes in Existing Code

- `handlers.ts` → `executeToolCall()` gets a HITL check before handler execution (for critical actions only)
- `config.ts` → DharaHIL config fields added
- `db.ts` → A2A table creation added to `initDatabase()` (in a separate `initA2aDatabase()` function called from `initDatabase()`)
- `index.ts` → A2A route mounted

## What Does NOT Change

- MCP tool definitions and individual handler functions
- All existing OAuth routes (`/authorize`, `/token`, `/revoke`, `/register`)
- All existing MCP discovery endpoints (`/.well-known/oauth-*`)
- Existing database tables (`mcp_clients`, `mcp_access_tokens`, etc.)
- Docker configuration (same port 4650, same container)
- MCP JSON-RPC endpoint (`/mcp-server`)

## Testing Strategy

- Unit tests for each A2A module (skill registry, state machine, rate limiter, webhook signer)
- Integration test: full `message.send` → `task.get` flow via HTTP
- HITL test: mock DharaHIL gateway responses
- SSE test: verify event stream format
- Rate limit test: verify limits are enforced and headers returned
