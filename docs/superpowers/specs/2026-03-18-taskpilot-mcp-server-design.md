# TaskPilot MCP Server — Design Spec

**Date:** 2026-03-18
**Status:** Draft
**Author:** Sudipta Dhara + Claude

## Overview

A standalone FastAPI MCP server that exposes TaskPilot workspace operations as MCP tools. AI agents (Claude Code, personal assistants) call it with natural descriptions, and it intelligently routes tasks to the correct project using LLM-powered classification with Redis caching.

## Architecture

```
AI Agent (Claude Code, personal assistant, etc.)
    ↓ MCP protocol (JSON-RPC over SSE/HTTP)
    ↓ OAuth 2.1 (PKCE + client_credentials)
TaskPilot MCP Server (FastAPI, port 4650)
    ├── OAuth 2.1 endpoints (authorize, token, revoke, discovery)
    ├── MCP JSON-RPC handler (tools/list, tools/call)
    ├── Smart Router (LiteLLM + Redis cache)
    └── TaskPilot API client (X-Api-Key auth)
            ↓ HTTP
    TaskPilot API (port 4647)
            ↓
    PostgreSQL / Redis / MinIO
```

## OAuth 2.1 Authentication

### Grant Types

1. **authorization_code** (with PKCE) — browser-based MCP clients
2. **refresh_token** — token rotation
3. **client_credentials** — machine-to-machine (Claude Code, scripts)

### Discovery Endpoints

- `GET /.well-known/oauth-protected-resource` — RFC 9728
- `GET /.well-known/oauth-authorization-server` — RFC 8414

### OAuth Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/oauth/authorize` | GET | Authorization (redirect to consent page) |
| `/oauth/token` | POST | Token exchange (code→token, refresh, client_credentials) |
| `/oauth/revoke` | POST | Token revocation |
| `/oauth/register` | POST | Dynamic client registration (disabled by default) |

### Token Model

Following MegaSearch pattern — **hashed storage, prefixed tokens**:

```python
# Token prefixes
ACCESS_TOKEN_PREFIX = "mcp_at_"    # OAuth access token
REFRESH_TOKEN_PREFIX = "mcp_rt_"   # OAuth refresh token
STATIC_TOKEN_PREFIX = "mcp_st_"    # MCP static token (no OAuth flow)
CLIENT_ID_PREFIX = "mcp_"          # Client identifier

# Storage: only SHA256 hashes stored in DB
# Raw tokens returned to client ONCE at creation
```

**OAuthClient:**
- `client_id` (unique, prefixed `mcp_`)
- `client_secret_hash` (optional, for confidential clients)
- `client_name`, `redirect_uris`, `grant_types`
- `scope` (default: `"taskpilot:read taskpilot:write"`)
- `owner_id` (FK to TaskPilot user, required for client_credentials)
- `is_active`

**OAuthAccessToken:**
- `token_hash` (SHA256, indexed)
- `user_id`, `client_id`, `scope`
- `expires_at` (default: 1 hour)
- `revoked_at` (nullable — soft revocation)

**OAuthRefreshToken:**
- `token_hash` (SHA256, indexed)
- `access_token_id` (FK)
- `user_id`, `client_id`
- `expires_at` (default: 30 days)
- `revoked_at` (nullable)

**MCPStaticToken:**
- `token_hash` (SHA256, indexed)
- `name` (friendly label)
- `user_id`, `workspace_slug`
- `expires_at` (nullable — permanent if None)
- `last_used_at`, `revoked_at`

### Auth Codes

Stored in **Redis** (not DB) with 10-minute TTL:
```
Key: oauth:code:<code_value>
Value: {client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, created_at}
TTL: 600 seconds
```

### PKCE (RFC 7636)

```python
# S256 only (plain rejected per OAuth 2.1)
code_verifier: 43-128 chars, [A-Za-z0-9\-._~]
code_challenge: BASE64URL(SHA256(code_verifier))
# Constant-time comparison via secrets.compare_digest()
```

### Scopes

| Scope | Access |
|-------|--------|
| `taskpilot:read` | List projects, tasks, cycles, modules, states |
| `taskpilot:write` | Create/update/delete tasks, comments, assignments |

### Authorization Flow (URL redirect)

```
1. Client → GET /oauth/authorize?
     response_type=code
     client_id=mcp_xxx
     redirect_uri=https://...
     code_challenge=xxx
     code_challenge_method=S256
     scope=taskpilot:read taskpilot:write
     state=xxx

2. Server checks if user logged in (via TaskPilot session cookie)
   - If not: redirect to TaskPilot login page with return URL
   - If yes: show consent page or auto-approve

3. Server creates auth code in Redis, redirects:
   → redirect_uri?code=xxx&state=xxx

4. Client → POST /oauth/token
     grant_type=authorization_code
     code=xxx
     redirect_uri=xxx
     client_id=xxx
     code_verifier=xxx

5. Server validates PKCE, returns:
   {access_token: "mcp_at_xxx", refresh_token: "mcp_rt_xxx", expires_in: 3600}
```

### Client Credentials Flow (for Claude Code)

```
1. Client → POST /oauth/token
     grant_type=client_credentials
     client_id=mcp_xxx
     client_secret=xxx
     scope=taskpilot:read taskpilot:write

2. Server validates secret, returns:
   {access_token: "mcp_at_xxx", expires_in: 3600}
   (No refresh token for client_credentials)
```

## MCP Tools

### Smart Tools (auto-route to correct project)

**`create_task`**
```json
{
  "name": "create_task",
  "description": "Create a task in the workspace. Automatically determines the right project based on context, or use project_hint to specify.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": {"type": "string", "description": "Task title"},
      "description": {"type": "string", "description": "Optional detailed description"},
      "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"]},
      "project_hint": {"type": "string", "description": "Optional project name or identifier to route to"}
    },
    "required": ["title"]
  }
}
```

**`move_task`**
```json
{
  "name": "move_task",
  "description": "Move a task to a different state (e.g., In Progress, Done, Cancelled)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "identifier": {"type": "string", "description": "Task identifier like FOR-AI-42 or task UUID"},
      "state": {"type": "string", "description": "Target state name (e.g., 'In Progress', 'Done')"}
    },
    "required": ["identifier", "state"]
  }
}
```

**`find_tasks`**
```json
{
  "name": "find_tasks",
  "description": "Search for tasks across the workspace",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {"type": "string", "description": "Search text"},
      "state": {"type": "string", "description": "Filter by state name"},
      "priority": {"type": "string", "enum": ["urgent", "high", "medium", "low", "none"]},
      "project_hint": {"type": "string", "description": "Filter by project name"}
    },
    "required": ["query"]
  }
}
```

### Explicit Tools (direct control)

**`list_projects`** — List all projects in workspace
**`list_tasks`** — List/filter issues with optional project, state, assignee, priority filters
**`get_task`** — Get task details by identifier (e.g., `FOR-AI-42`)
**`update_task`** — Update any task field (title, description, priority, assignee, dates)
**`add_comment`** — Add a comment to a task
**`list_states`** — Get workflow states for a project
**`list_cycles`** — Get sprints/cycles
**`assign_to_cycle`** — Add task to a sprint

## Smart Routing

### Flow

```
create_task("buy shampoo")
    ↓
1. Check Redis cache: hash("buy shampoo" normalized) → project_id?
2. Cache MISS → Call LiteLLM:
   System: "You are a task router. Given the project list and a task, return the project_id."
   User: "Projects: [{id: x, name: 'Personal Errands', desc: '...'}, ...]
          Task: 'buy shampoo'"
   → LLM returns: project_id
3. Cache SET: key=route:<workspace>:<keyword_hash>, value=project_id, TTL=7 days
4. Create issue via TaskPilot API
5. Return: {identifier: "ERRANDS-5", project: "Personal Errands", url: "..."}
```

### Cache Strategy

- **Key format:** `mcp:route:<workspace_slug>:<sha256(normalized_title)[:16]>`
- **Value:** `project_id`
- **TTL:** 7 days
- **Redis DB:** 7 (separate from TaskPilot's DB 6)
- **Cache invalidation:** When projects are added/removed, clear `mcp:route:<workspace>:*`

### LLM Call

```python
# Uses LiteLLM at http://nuc.lan:4000
client = OpenAI(base_url="http://nuc.lan:4000", api_key=llm_api_key)
response = client.chat.completions.create(
    model=llm_model,  # from .env
    messages=[
        {"role": "system", "content": ROUTING_SYSTEM_PROMPT},
        {"role": "user", "content": f"Projects: {project_list_json}\nTask: {title}"}
    ],
    temperature=0,
    max_tokens=100,
)
# Parse project_id from response
```

## Tech Stack

- **Framework:** FastAPI + uvicorn
- **Database:** PostgreSQL (same instance as TaskPilot, separate tables with `mcp_` prefix)
- **Cache:** Redis at `nuc.lan:6379/7`
- **LLM:** LiteLLM proxy at `nuc.lan:4000`
- **TaskPilot API:** `http://api:4647` (Docker internal)
- **Location:** `apps/mcp/` in monorepo
- **Container:** `taskpilot-mcp` on port 4650

## Configuration (.env)

```bash
# MCP Server
MCP_PORT=4650
MCP_ISSUER_URL=https://taskpilot-mcp.sudiptadhara.in
MCP_RESOURCE_URL=https://taskpilot-mcp.sudiptadhara.in/mcp

# TaskPilot API
TASKPILOT_API_URL=http://api:4647
TASKPILOT_API_KEY=taskpilot_api_<token>
TASKPILOT_WORKSPACE_SLUG=for-ai

# Database (same PostgreSQL, separate tables)
DATABASE_URL=postgresql://taskpilot_db_user:xxx@nuc.lan:5432/taskpilot_db

# Redis
REDIS_URL=redis://:xxx@nuc.lan:6379/7

# LLM (for smart routing)
LLM_API_BASE_URL=http://nuc.lan:4000
LLM_API_KEY=<key>
LLM_MODEL=<model>

# OAuth
MCP_ACCESS_TOKEN_TTL=3600
MCP_REFRESH_TOKEN_TTL=2592000
MCP_AUTH_CODE_TTL=600
```

## Docker

```yaml
# In docker-compose.yml
mcp:
  container_name: taskpilot-mcp
  build:
    context: ./apps/mcp
    dockerfile: Dockerfile
  ports:
    - "4650:4650"
  env_file: .env
  depends_on:
    - api
  restart: always
```

## Directory Structure

```
apps/mcp/
├── Dockerfile
├── requirements.txt
├── app/
│   ├── main.py              # FastAPI app, SSE+HTTP MCP endpoints
│   ├── config.py             # Pydantic Settings
│   ├── database/
│   │   ├── connection.py     # SQLAlchemy async engine
│   │   └── models/
│   │       ├── oauth_client.py
│   │       ├── oauth_token.py
│   │       └── mcp_static_token.py
│   ├── oauth/
│   │   ├── endpoints.py      # /oauth/authorize, /oauth/token, /oauth/revoke
│   │   ├── discovery.py      # .well-known endpoints
│   │   ├── security.py       # PKCE, token generation, hashing
│   │   └── auth.py           # get_current_user dependency
│   ├── mcp/
│   │   ├── server.py         # JSON-RPC handler
│   │   ├── tools.py          # Tool definitions
│   │   └── handlers.py       # Tool execution logic
│   ├── router/
│   │   ├── smart_router.py   # LLM-based project routing
│   │   └── cache.py          # Redis routing cache
│   └── taskpilot/
│       └── client.py         # TaskPilot API HTTP client
```

## NPM Proxy Host

```
taskpilot-mcp.sudiptadhara.in → http://192.168.11.150:4650
```

## Success Criteria

1. Claude Code can be configured with `taskpilot-mcp` as an MCP server
2. `create_task("buy shampoo")` routes to the correct project without specifying project_id
3. `move_task("FOR-AI-42", "Done")` updates the task state
4. `find_tasks("what's in progress")` returns current work items
5. OAuth 2.1 flow works with both browser redirect and client_credentials
6. Smart routing cache hits on repeated similar tasks (< 50ms vs ~2s for LLM)
7. All operations respect workspace scoping — one token = one workspace
