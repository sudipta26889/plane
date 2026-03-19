# TaskPilot MCP OAuth 2.1 Consent Flow — Design Spec

**Date:** 2026-03-19
**Status:** Draft
**Author:** Sudipta Dhara + Claude
**Depends on:** MCP Server (2026-03-18-taskpilot-mcp-server-design.md)

## Overview

When an MCP client (Claude, Claude Code, or any MCP-compatible tool) connects to TaskPilot's MCP server, the user is redirected to a consent page hosted in the TaskPilot web app. They log in (if not already), select a workspace, choose permissions, and click Authorize. The MCP client is then automatically authenticated — no API keys to copy-paste.

## User Flow

```
1. User adds custom connector in Claude:
   Name: "TaskPilot"
   URL: https://taskpilot-mcp.sudiptadhara.in

2. Claude's MCP client calls:
   GET https://taskpilot-mcp.sudiptadhara.in/.well-known/oauth-protected-resource
   → discovers authorization server

3. Claude initiates OAuth:
   GET https://taskpilot-mcp.sudiptadhara.in/oauth/authorize?
     response_type=code
     client_id=<dynamic>
     redirect_uri=<claude_callback>
     code_challenge=<S256>
     code_challenge_method=S256
     scope=taskpilot:read taskpilot:write

4. MCP server encodes params as base64 oauth_state, redirects:
   → https://taskpilot.sudiptadhara.in/oauth/consent?oauth_state=<base64>

5. TaskPilot web app:
   a. If not logged in → redirect to /sign-in?return_to=/oauth/consent?oauth_state=...
   b. If logged in → show consent page

6. Consent page shows:
   - TaskPilot logo
   - "Claude wants to access your TaskPilot account"
   - Workspace dropdown (all user's workspaces)
   - Permission checkboxes (taskpilot:read, taskpilot:write, taskpilot:manage, taskpilot:delete)
   - Deny / Authorize buttons

7. User selects workspace, checks permissions, clicks Authorize

8. Frontend POST to MCP server:
   POST https://taskpilot-mcp.sudiptadhara.in/oauth/approve
   Body: { oauth_state, workspace_slug, approved_scopes[], user_token }

9. MCP server:
   - Validates user_token against TaskPilot API
   - Creates auth code in Redis (10 min TTL)
   - Records consent in OAuthConsent table
   - Returns redirect_uri with code

10. Claude exchanges code for access_token (standard OAuth)

11. Future connections: if consent exists for this client + user → auto-approve (skip consent page)
```

## Consent Page Design

Hosted at `https://taskpilot.sudiptadhara.in/oauth/consent` in the TaskPilot React web app.

### UI Elements

```
┌─────────────────────────────────────┐
│           ✈️ TaskPilot              │
│                                     │
│        Authorize Access             │
│  Claude wants to access your        │
│  TaskPilot account                  │
│                                     │
│  Workspace                          │
│  ┌─────────────────────────────┐    │
│  │ For AI                    ▼ │    │
│  └─────────────────────────────┘    │
│                                     │
│  This application will be able to:  │
│  ┌─────────────────────────────┐    │
│  │ ☑ Read projects and tasks   │    │
│  │   taskpilot:read            │    │
│  ├─────────────────────────────┤    │
│  │ ☑ Create and manage tasks   │    │
│  │   taskpilot:write           │    │
│  ├─────────────────────────────┤    │
│  │ ☑ Manage cycles & modules   │    │
│  │   taskpilot:manage          │    │
│  ├─────────────────────────────┤    │
│  │ ☐ Delete tasks and data     │    │
│  │   taskpilot:delete          │    │
│  └─────────────────────────────┘    │
│                                     │
│  You can revoke access at any time  │
│  in your account settings.          │
│                                     │
│  ┌──────────┐  ┌──────────────┐     │
│  │   Deny   │  │  Authorize   │     │
│  └──────────┘  └──────────────┘     │
└─────────────────────────────────────┘
```

### Scopes

| Scope | Label | Description | Default |
|-------|-------|-------------|---------|
| `taskpilot:read` | Read projects and tasks | List projects, tasks, cycles, modules, states | Checked |
| `taskpilot:write` | Create and manage tasks | Create/update tasks, comments, assignments | Checked |
| `taskpilot:manage` | Manage cycles and modules | Create/manage sprints, modules, labels | Checked |
| `taskpilot:delete` | Delete tasks and data | Delete tasks, bulk operations | Unchecked |

## Architecture

### Components

```
MCP Client (Claude)
    ↓ OAuth 2.1 (PKCE)
MCP Server (FastAPI, port 4650)
    ├── GET /oauth/authorize → redirect to TaskPilot consent page
    ├── POST /oauth/approve → validate consent, issue auth code
    ├── POST /oauth/token → exchange code for access token
    └── POST /oauth/revoke → revoke tokens
            ↓ redirect
TaskPilot Web App (React, port 4646)
    └── /oauth/consent → consent page component
            ↓ validates user session
    TaskPilot API (Django, port 4647)
    └── GET /api/users/me/workspaces/ → list user's workspaces
```

### MCP Server Changes (`apps/mcp/`)

**`/oauth/authorize` endpoint (updated):**
```python
@router.get("/oauth/authorize")
async def authorize(...):
    # Validate client, redirect_uri, code_challenge
    # Encode all OAuth params as base64 oauth_state
    oauth_state = base64.urlsafe_b64encode(json.dumps({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method,
        "client_name": client.client_name,
    }).encode()).decode()

    # Check if consent already exists for this user + client
    # If yes → auto-approve, issue code, redirect back
    # If no → redirect to consent page
    return RedirectResponse(
        f"{settings.frontend_url}/oauth/consent?oauth_state={oauth_state}"
    )
```

**New `/oauth/approve` endpoint:**
```python
@router.post("/oauth/approve")
async def approve(
    oauth_state: str,
    workspace_slug: str,
    scopes: list[str],
    user_token: str,  # TaskPilot session/auth token
):
    # 1. Validate user_token against TaskPilot API (GET /api/users/me/)
    # 2. Decode oauth_state to get original OAuth params
    # 3. Generate auth code, store in Redis with workspace_slug
    # 4. Record consent in OAuthConsent table
    # 5. Redirect to client's redirect_uri with code
```

### TaskPilot Web App Changes (`apps/web/`)

**New route:** `/oauth/consent`

**New component:** `apps/web/app/(all)/oauth/consent/page.tsx`

```typescript
// Consent page component
// 1. Parse oauth_state from URL query params
// 2. Check if user is logged in (auth context)
//    - If not: redirect to /sign-in?return_to=/oauth/consent?oauth_state=...
// 3. Fetch user's workspaces (GET /api/users/me/workspaces/)
// 4. Display consent UI (workspace dropdown, scope checkboxes)
// 5. On Authorize: POST to MCP server /oauth/approve
// 6. On Deny: redirect back to client with error=access_denied
```

### Dynamic Client Registration

MCP clients like Claude create clients dynamically. The MCP server supports this via `/oauth/register` (RFC 7591):

```python
POST /oauth/register
{
    "client_name": "Claude",
    "redirect_uris": ["https://claude.ai/oauth/callback"],
    "grant_types": ["authorization_code"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none"
}
→ { "client_id": "mcp_xxx", "client_name": "Claude" }
```

Public clients (like Claude) don't get a `client_secret` — they rely on PKCE for security.

## Token Storage

### Auth Code (Redis)
```
Key: oauth:code:<code_value>
Value: {
    client_id, user_id, workspace_slug,
    redirect_uri, scope,
    code_challenge, code_challenge_method
}
TTL: 600 seconds (10 minutes)
```

### Access Token (PostgreSQL)
- `token_hash` (SHA256, never store raw)
- `user_id` (TaskPilot user UUID)
- `workspace_slug` (selected workspace)
- `client_id`, `scope`, `expires_at`, `revoked_at`

### Consent Record (PostgreSQL)
- `user_id` + `client_id` (unique constraint)
- `workspace_slug`, `scope`, `granted_at`
- Used for auto-approve on future connections

## Security

1. **PKCE S256 only** — plain method rejected per OAuth 2.1
2. **Auth codes single-use** — deleted from Redis after exchange
3. **Token hashing** — only SHA256 hashes stored, raw tokens returned once
4. **Redirect URI validation** — HTTPS required (localhost exception for dev)
5. **User validation** — consent page validates user via TaskPilot API session
6. **CORS** — MCP server allows only TaskPilot frontend origin for /oauth/approve
7. **Auto-approve** — only after explicit first consent recorded in DB

## Revocation

Users can revoke MCP client access from their TaskPilot profile settings (future: add "Connected Apps" section alongside "Personal Access Tokens"). For now, revocation via MCP server's `/oauth/revoke` endpoint.

## Configuration

Add to `.env`:
```bash
# MCP OAuth
MCP_DYNAMIC_REGISTRATION=true
FRONTEND_URL=https://taskpilot.sudiptadhara.in
```

## Files to Create/Modify

### New files:
- `apps/web/app/(all)/oauth/consent/page.tsx` — consent page React component
- `apps/web/app/(all)/oauth/consent/layout.tsx` — minimal layout (no sidebar)

### Modified files:
- `apps/mcp/app/oauth/endpoints.py` — update authorize, add approve endpoint, add register endpoint
- `apps/mcp/app/oauth/discovery.py` — add registration_endpoint to metadata
- `apps/mcp/app/mcp/server.py` — workspace_slug from token context
- `apps/mcp/app/oauth/auth.py` — include workspace_slug in MCPAuthContext from token

## Success Criteria

1. Adding `https://taskpilot-mcp.sudiptadhara.in` as a custom connector in Claude redirects to TaskPilot consent page
2. Consent page shows workspace dropdown and permission checkboxes
3. Clicking Authorize completes the OAuth flow — Claude is connected
4. Subsequent connections auto-approve (consent already recorded)
5. MCP tools work with the selected workspace context
6. Deny button redirects back to Claude with error
