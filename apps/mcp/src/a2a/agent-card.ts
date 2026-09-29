import { getAllSkills } from "./skill-registry.js";

const SCOPES = {
  "taskpilot:read": "Read projects, tasks, pages, members, labels, cycles",
  "taskpilot:write": "Create projects; create/update/move tasks, assign, label, comment; write and archive pages; triage intake; link work items",
};

export function buildAgentCard(baseUrl: string) {
  const skills = getAllSkills().map((skill) => ({
    // A2A requires `id` and `tags` on every skill; `name` stays for the clients
    // that were reading this card before.
    id: skill.name,
    name: skill.name,
    description: skill.description,
    tags: [skill.name.split(".")[0], skill.scope],
    requiresApproval: skill.approval === "conditional" ? "conditional" : skill.approval,
  }));

  const oauthFlows = {
    authorizationCode: {
      authorizationUrl: `${baseUrl}/authorize`,
      tokenUrl: `${baseUrl}/token`,
      scopes: SCOPES,
    },
  };

  return {
    name: "TaskPilot",
    description: "AI-native project management agent — create, track, and manage tasks across projects",
    version: "1.0.0",
    protocol: "a2a",
    protocolVersion: "0.3",
    url: `${baseUrl}/a2a`,
    // Current A2A clients (native OpenClaw among them) read the endpoint from
    // `supportedInterfaces`/`preferredTransport` and ignore the flat `url`
    // above. All three name the same endpoint.
    preferredTransport: "JSONRPC",
    supportedInterfaces: [
      { url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "0.3" },
    ],
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    // `authentication` is this server's original non-standard shape; the spec
    // calls for securitySchemes + security. Both describe the same OAuth flow.
    authentication: {
      type: "oauth2",
      flows: oauthFlows,
    },
    securitySchemes: {
      oauth2: { type: "oauth2", flows: oauthFlows },
    },
    security: [{ oauth2: Object.keys(SCOPES) }],
    capabilities: {
      streaming: true,
      // Spec name for our webhook deliveries. `tasks/pushNotificationConfig/*`
      // is not implemented, so this stays false until it is.
      pushNotifications: false,
      webhooks: true,
      humanInTheLoop: true,
    },
    skills,
    rateLimits: {
      clientPerMinute: 60,
      clientPerHour: 1000,
      userPerMinute: 100,
    },
  };
}

export function buildLlmsTxt(baseUrl: string): string {
  const skills = getAllSkills();

  // Grouped by name prefix rather than a hardcoded list, so a skill added to
  // the registry later shows up here automatically instead of being silently
  // undocumented.
  const groups = new Map<string, typeof skills>();
  for (const skill of skills) {
    const prefix = skill.name.split(".")[0]!;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(skill);
  }

  const formatSkillGroup = (group: typeof skills) =>
    group.map((s) => {
      const approval =
        s.approval === true
          ? " - ALWAYS REQUIRES HUMAN APPROVAL"
          : s.approval === "conditional"
            ? " - REQUIRES HUMAN APPROVAL for its destructive form (cancelling, rejecting)"
            : "";
      return `- **${s.name}**: ${s.description} (scope: ${s.scope})${approval}`;
    }).join("\n");

  const skillSections = [...groups.entries()]
    .map(([prefix, group]) => {
      const heading = `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)} Skills`;
      return `### ${heading}\n${formatSkillGroup(group)}`;
    })
    .join("\n\n");

  return `# TaskPilot A2A Protocol API

> **TaskPilot** is an AI-native project management system. It is NOT Linear, Jira, Asana, or any other third-party service. TaskPilot is a self-hosted, independent platform.

> A2A (Agent-to-Agent) Protocol v0.3 implementation enabling AI agents to manage tasks, projects, labels, cycles, and team assignments through a standardized JSON-RPC 2.0 interface with OAuth 2.0 authentication.

## Important Constraints

- **There is NO task delete operation.** Tasks cannot be deleted. To remove tasks, use \`task.move\` to move them to "Cancelled" state, or use \`task.bulk_cancel\` / \`bulk_cancel_tasks\` to cancel multiple tasks at once.
- **If you are an external peer, EVERY write you attempt requires human approval.** Not just cancellation. Any client whose id begins with \`peer_\` has every write-scoped skill gated: the task suspends in \`auth_required\`, a human is asked, and the write executes only after they approve. Expect writes to be slow and to sometimes be refused. This is the intended behaviour, not an error — do not retry a rejected write, and do not try to route around it.
- **Cancellation and page archiving always require approval**, for every caller including internal ones.
- **Do NOT suggest deleting tasks.** Always suggest cancelling instead.
- **Do NOT refer to TaskPilot as "Linear" or any other product.** TaskPilot is its own system.

## Quick Start

This API allows AI agents to:
- Create, search, update, and move tasks across projects with smart routing
- Assign/unassign team members and manage labels
- Track sprints/cycles and add comments
- Cancel tasks individually or in bulk (with human approval)
- Get project summaries with 3-state status (pending/in_progress/completed)
- All operations authenticated via OAuth 2.0 with PKCE
- Real-time updates via Server-Sent Events (SSE)
- Webhook notifications for task state changes

## Authentication

Two paths. **If you are an agent peer, use the first one.**

**Long-lived peer token (recommended for agents).** A static Bearer token bound
to one user and one workspace, issued out of band by a TaskPilot operator. It
does not expire on the timescale an unattended agent cares about and there is
no refresh step to fail. Put it in your peer configuration and send it as
\`Authorization: Bearer <token>\`. Ask the operator to run
\`scripts/mint-peer-token.ts\`. The token is not recoverable after issue — only
its id is stored — so if it is lost, a new one must be minted. Revoking it in
the database revokes access immediately, with no redeploy.

**OAuth 2.0 Authorization Code with PKCE (for interactive clients).** Requires a
human at a browser, and its refresh tokens can expire while an unattended agent
sleeps — which is exactly why agent peers should not use it.
1. Discover capabilities: GET ${baseUrl}/.well-known/agent-card.json
2. Register OAuth client: POST ${baseUrl}/register
3. Initiate authorization: GET ${baseUrl}/authorize
4. Exchange code for token: POST ${baseUrl}/token
5. Use Bearer token for all API requests

## Core Endpoints

### Agent Card Discovery
- [Agent Capabilities](${baseUrl}/.well-known/agent-card.json): Discover available skills, OAuth endpoints, and protocol bindings

### JSON-RPC API
- [A2A Endpoint](${baseUrl}/a2a): POST requests with JSON-RPC 2.0 format
  - method: initialize - Protocol handshake (no auth required)
  - method: message.send - Execute a skill (params: contextId, skill, input)
  - method: task.get - Get task status (params: taskId)
  - method: task.list - List tasks in a context (params: contextId)
  - method: task.cancel - Cancel a task (params: taskId)
  - method: context.get - Get all tasks in a context (params: contextId)

Spec-form method names are accepted as aliases: \`message/send\`, \`tasks/get\`,
\`tasks/list\`, \`tasks/cancel\`, \`context/get\`, and the older \`tasks/send\`
(treated the same as \`message/send\`). \`message/send\` also accepts the
spec's Message params — put contextId on the message and the skill in a data part:
\`{"message": {"contextId": "...", "parts": [{"kind": "data", "data": {"skill": "task.create", "input": {...}}}]}}\`

A2A v1.0 gRPC method names are also accepted, for clients (native OpenClaw
among them) that speak that spelling instead: \`SendMessage\` (-> message.send),
\`GetTask\` (-> task.get), \`ListTasks\` (-> task.list), \`CancelTask\` (-> task.cancel),
\`GetAgentCard\` (-> agent.getCard), and \`agent/getAuthenticatedExtendedCard\`
(also -> agent.getCard).

### Real-Time Updates
- [SSE Stream](${baseUrl}/a2a/stream?taskId=TASK_ID): Subscribe to real-time task state changes

## Available Skills

${skillSections}

## Request Format

POST ${baseUrl}/a2a
\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message.send",
  "params": {
    "contextId": "unique-context-id",
    "skill": "task.create",
    "input": {
      "title": "Fix login bug",
      "priority": "high",
      "project_hint": "WebApp"
    }
  }
}
\`\`\`

Headers required:
- Authorization: Bearer YOUR_ACCESS_TOKEN
- Content-Type: application/json

### You do not have to name a skill

If you can only send free text, send free text. A message with a text part and
**no** \`skill\` is handled by a full tool-calling agent that can chain several
TaskPilot operations to answer one request, rather than mapping to a single
call. This is the recommended path for conversational peers.

\`\`\`json
{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": {
    "contextId": "my-conversation-1",
    "message": {
      "role": "user",
      "messageId": "unique-per-message",
      "parts": [{"kind": "text", "text": "What is blocking the payments milestone?"}]
    }
  }
}
\`\`\`

**\`contextId\` is required, and it is load-bearing.** It is the conversation
this message belongs to: reuse the same value to keep history, and a new value
to start fresh. Omitting it is the single most common integration mistake —
the request is refused rather than silently answered without history.

**\`messageId\` doubles as the idempotency key.** Resending the same messageId
returns the original task instead of doing the work twice, so a retry after a
timeout is safe. See "Idempotency and safe retries" below.

## Response Format

Success:
\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "contextId": "unique-context-id",
    "taskId": "task_abc123",
    "state": "completed",
    "result": { "identifier": "WEBAPP-42", "title": "Fix login bug" }
  }
}
\`\`\`

Error:
\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params: contextId is required"
  }
}
\`\`\`

## Task States

Tasks progress through these states:
- **submitted**: Task queued for execution
- **working**: Task is executing
- **auth_required**: Human approval needed (Slack/Telegram notification sent)
- **completed**: Task finished successfully
- **failed**: Task failed (check error field)
- **canceled**: Task was canceled by client
- **rejected**: Human rejected the approval request

## Rate Limits

- Client: 60 requests/minute, 1000/hour
- User: 100 requests/minute, 2000/hour
- Task Creation: 30 requests/minute
- IP (unauthenticated): 20 requests/minute

Rate limit headers included in all responses:
- X-RateLimit-Limit
- X-RateLimit-Remaining
- X-RateLimit-Reset

## Real-Time Updates (SSE)

Instead of polling, subscribe to Server-Sent Events:
\`\`\`
GET ${baseUrl}/a2a/stream?taskId=TASK_ID&token=YOUR_ACCESS_TOKEN
\`\`\`

Events:
- event: ping - Keep-alive (every 15 seconds)
- event: task.state_changed - State changed
- event: task.completed - Task completed with result
- event: task.failed - Task failed with error
- event: final - Terminal state reached (stream closes)

Max connection: 5 minutes.

## Webhook Notifications

Webhooks deliver push notifications for task state changes:
- Webhooks include HMAC-SHA256 signature (X-Webhook-Signature header) for verification
- Retry logic: 5 attempts with exponential backoff (1s, 5s, 15s, 1min, 5min)
- Available events: task.created, task.state_changed, task.completed, task.failed, task.canceled, task.rejected, task.approval_required

## MQTT Event Bus

TaskPilot publishes state to MQTT and accepts a narrow inbound channel. This is
a convenience for home/ops automation, not a second API: it carries no
authentication of its own, so it never bypasses the rules above.

**Published** (JSON; every message carries \`origin: "taskpilot-mcp"\` and \`at\`):

| Topic | Payload | Retained |
|---|---|---|
| \`taskpilot/availability\` | \`online\` / \`offline\`, backed by a last will | yes |
| \`taskpilot/health\` | \`{status, degraded:[...]}\` | yes |
| \`taskpilot/task/created\` | \`{identifier, project, title, source}\` | no |
| \`taskpilot/task/state_changed\` | \`{identifier, from, to}\` | no |
| \`taskpilot/agent/run\` | \`{taskId, toolsUsed, status}\` | no |
| \`taskpilot/approval/requested\` | \`{taskId, tool, summary}\` | no |

Home Assistant discovery configs are retained under
\`homeassistant/binary_sensor/taskpilot_mcp/<entity>/config\`.

**Inbound.** Only \`taskpilot/ingest/+\` reaches the agent. Publish free text
there and it is handled exactly as an A2A message would be — as a \`peer_\`
identity, which means **every write it attempts requires human approval**.
Ingest is rate limited per rule and by a global hourly ceiling, is idempotent
on redelivery, and refuses any topic that would feed TaskPilot its own output.

There is no MQTT topic that approves anything, and one must never be added:
MQTT authenticates a connection, not a request, so anything able to reach the
broker could publish the bytes that approve an action as you. Approvals travel
only over the authenticated DharaHIL API.

## Writes, approvals and how to get the result

**Every write by a \`peer_\` client waits for a human.** \`project.create\`,
cancelling, archiving and rejecting intake wait for a human whoever calls them.

### The lifecycle

1. You send the write with \`message/send\`. TaskPilot checks the token, the
   scope, the input and the target project **before** anyone is asked. A bad
   project or a missing field is an immediate JSON-RPC error (-32602); no task
   is created and nobody is paged.
2. The reply has \`state: "auth_required"\`, the \`taskId\`, the DharaHIL
   \`approval.id\` and the resolved \`project\`:
   \`\`\`json
   {"taskId": "task_…", "contextId": "…", "state": "auth_required",
    "approval": {"id": "…", "status": "pending", "expiresAt": "…"},
    "project": {"id": "…", "identifier": "GUARDIANAI", "name": "GuardianAI"},
    "message": "Waiting for a human to approve this in DharaHIL. This is NOT an authentication error…"}
   \`\`\`
   **\`auth_required\` is not an authentication problem.** Your token is fine.
   Do not re-authenticate, do not ask for a new token, and do not re-send.
3. A human approves or rejects in DharaHIL (Slack/Telegram).
4. On approval TaskPilot runs **your original request, on the same taskId**,
   usually within a few seconds (at most ~30s). You never send it again.
5. Get the outcome with \`tasks/get\` (or \`GetTask\`) and that \`taskId\`. Poll
   every 10–30 seconds until the state is terminal.

### Terminal states: exactly one per task

| state | A2A v1 name | meaning |
|---|---|---|
| \`completed\` | TASK_STATE_COMPLETED | Approved and written. \`result\` has the entity (\`id\`, \`identifier\`, \`project\`). |
| \`rejected\` | TASK_STATE_REJECTED | A human rejected it, or the approval expired. Nothing was written. Do not retry unless the human asks. |
| \`failed\` | TASK_STATE_FAILED | Approved but the write failed, or wrote nothing (e.g. a suspected duplicate). \`error.message\` says why. |
| \`canceled\` | TASK_STATE_CANCELED | You cancelled it with \`tasks/cancel\` before it ran. |

Non-terminal: \`auth_required\` (TASK_STATE_AUTH_REQUIRED, waiting for a human),
\`submitted\` / \`working\` (approved, running now).

The approved write runs **at most once**. If the server stops while it is
running, the task ends \`failed\` with "may or may not have happened". Check
(\`task.find\`, \`page.list\`) before you retry.

### Other ways to hear about completion (optional)

- SSE: \`GET ${baseUrl}/a2a/stream?taskId=…\`
- Webhooks, if the operator has configured one for your client: HMAC-signed
  \`task.completed\` / \`task.failed\` / \`task.rejected\` carrying \`context_id\`,
  the task id, the state and the result.

Polling \`tasks/get\` always works and needs no setup.

### Three different "no"s

| You see | It means | What to do |
|---|---|---|
| HTTP 401, code -32002 | Token missing, invalid or expired | Fix the credential |
| HTTP 403, code -32005 | Token is valid but lacks the skill's scope (\`error.data.requiredScope\`) | Ask the operator for a token with that scope. Waiting will not help. |
| \`state: "auth_required"\` | A human is deciding | Poll \`tasks/get\`. Change nothing. |

## Idempotency and safe retries

- Send a unique \`messageId\` per logical request. Resending the same one returns
  the original task (\`replayed: true\`) and never writes twice, before or after
  approval.
- **Writes without a messageId are still deduplicated**, on
  (contextId, skill, input): an identical write in the same conversation returns
  the first task. To perform the same write twice on purpose, give each its own
  messageId.
- Reusing a messageId for a **different** request is refused with -32009.
- Keys are per client and stored in the database, so they survive restarts.
- Safe to retry: any request that timed out or got no response. Resend it
  unchanged. Not safe: resending with a new messageId after an unclear
  outcome. Poll the original taskId instead.

## Project scoping

Every project-scoped skill (\`project.list_tasks\`, \`task.find\`,
\`project.list_states\`, \`page.list\`, …) takes a project as its id, its
identifier (e.g. \`GUARDIANAI\`) or its exact name, under \`project\`,
\`project_id\` or \`project_hint\`. Matching is exact and case-insensitive,
never partial. A project that matches nothing, or more than one, is an error.
It never falls back to listing the whole workspace. Prefer the immutable
project id once you have it.

## Example: Create a Page and Get the Result

\`\`\`json
POST ${baseUrl}/a2a
{"jsonrpc": "2.0", "id": 1, "method": "SendMessage",
 "params": {"message": {"contextId": "guardianai", "messageId": "page-canary-1",
   "parts": [{"data": {"skill": "page.create",
     "input": {"title": "GuardianAI A2A Write Canary", "content": "<p>…</p>", "project_hint": "GUARDIANAI"}}}]}}}
\`\`\`
→ \`{"taskId": "task_…", "state": "auth_required", "approval": {…}}\`. Then, after the human approves:
\`\`\`json
{"jsonrpc": "2.0", "id": 2, "method": "GetTask", "params": {"taskId": "task_…"}}
\`\`\`
→ \`{"state": "completed", "result": {"id": "<page uuid>", "name": "GuardianAI A2A Write Canary", "project": "GUARDIANAI"}}\`

## Example: Create a Project

\`\`\`json
{"skill": "project.create", "input": {"name": "GuardianAI", "identifier": "GUARDIANAI", "description": "…"}}
\`\`\`
Always approval-gated. If a project with exactly that name and identifier
already exists, it completes immediately with \`status: "exists"\` and nothing
is written. A clash on the name alone or the identifier alone is refused.

## OAuth Scopes

- taskpilot:read — every read skill (lists, gets, searches, summaries)
- taskpilot:write — every write skill; for a \`peer_\` client each write also waits for human approval

## Error Codes

JSON-RPC standard error codes:
- -32700: Parse error (invalid JSON)
- -32600: Invalid Request (missing jsonrpc/method)
- -32601: Method not found (unknown skill)
- -32602: Invalid params (validation failed)
- -32603: Internal error (server error)
- -32001: Task not found (also returned for another client's task)
- -32002: Authentication required: token missing, invalid or expired (HTTP 401)
- -32003: Rate limit exceeded (HTTP 429)
- -32005: Insufficient scope: token valid but lacks the skill's scope (HTTP 403)
- -32009: Idempotency conflict: messageId reused for a different request

A pending human approval is **not** an error. It is a normal result with
\`state: "auth_required"\`.

## Example: Create a Task with Smart Routing

1. Obtain access token via OAuth
2. Create task:
\`\`\`json
POST ${baseUrl}/a2a
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message.send",
  "params": {
    "contextId": "my-tasks-001",
    "skill": "task.create",
    "input": {
      "title": "Buy groceries",
      "description": "Milk, eggs, bread",
      "priority": "medium"
    }
  }
}
\`\`\`

3. TaskPilot smart-routes to the best matching project
4. Response contains taskId and result with created task identifier

## Example: Cancel a Task (with Approval)

1. Request task cancellation:
\`\`\`json
POST ${baseUrl}/a2a
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message.send",
  "params": {
    "contextId": "my-tasks-001",
    "skill": "task.move",
    "input": {
      "identifier": "WEBAPP-42",
      "state": "Cancelled"
    }
  }
}
\`\`\`

2. Task enters "auth_required" state
3. Human receives Slack/Telegram notification with task details
4. Human approves or rejects
5. The same task transitions to "completed" (approved and done), "failed"
   (approved but the move failed) or "rejected"
6. Poll tasks/get with the taskId, or use SSE, to get the final result

## Security Features

- OAuth 2.0 with PKCE (Proof Key for Code Exchange)
- HMAC-SHA256 webhook signatures
- Comprehensive audit logging (all operations logged)
- Multi-tier rate limiting (client, user, IP)
- Fail-safe approval workflow (timeout = deny)
- Scope-based access control
- Idempotency keys for duplicate prevention

## Technical Specifications

- Protocol: A2A Protocol v0.3 (Google/Linux Foundation)
- Transport: JSON-RPC 2.0 over HTTPS
- Authentication: OAuth 2.0 Authorization Code with PKCE
- Real-time: Server-Sent Events (SSE)
- Webhooks: HMAC-SHA256 signatures
- Retry Logic: Exponential backoff (webhooks: 5 attempts)
- Token Lifetime: 1 hour (use refresh token to renew)
- Max SSE Connection: 5 minutes
- Task Retry: 3 attempts for failed executions

## Production Endpoints

- Base URL: ${baseUrl}
- Agent Card: ${baseUrl}/.well-known/agent-card.json
- OAuth Authorize: ${baseUrl}/authorize
- OAuth Token: ${baseUrl}/token
- JSON-RPC: ${baseUrl}/a2a
- SSE Stream: ${baseUrl}/a2a/stream
- llms.txt: ${baseUrl}/a2a/llms.txt

## Quick Integration Checklist

1. Register OAuth client via POST ${baseUrl}/register
2. Implement OAuth 2.0 PKCE flow
3. Store access token and refresh token securely
4. Make JSON-RPC requests with Bearer token
5. Handle rate limits (check X-RateLimit-* headers)
6. Implement retry logic for transient errors
7. Use SSE or webhooks for real-time updates (optional)
8. Handle the approval workflow for writes: on auth_required, poll tasks/get; never re-send
9. Monitor audit logs for security

## Compliance & Audit

- All operations logged to audit trail
- 90-day audit log retention
- 30-day webhook delivery retention
- HMAC webhook signatures for authenticity
- Fail-safe approval workflow (errors = deny)
- Rate limiting to prevent abuse
- OAuth token expiration (1 hour)
`;
}
