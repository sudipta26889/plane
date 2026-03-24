import { getAllSkills } from "./skill-registry.js";

export function buildAgentCard(baseUrl: string) {
  const skills = getAllSkills().map((skill) => ({
    name: skill.name,
    description: skill.description,
    requiresApproval: skill.approval === "conditional" ? "conditional" : skill.approval,
  }));

  return {
    name: "TaskPilot",
    description: "AI-native project management agent — create, track, and manage tasks across projects",
    version: "1.0.0",
    protocol: "a2a",
    protocolVersion: "0.3",
    url: `${baseUrl}/a2a`,
    authentication: {
      type: "oauth2",
      flows: {
        authorizationCode: {
          authorizationUrl: `${baseUrl}/authorize`,
          tokenUrl: `${baseUrl}/token`,
          scopes: {
            "taskpilot:read": "Read projects, tasks, members, labels, cycles",
            "taskpilot:write": "Create/update/move tasks, assign, label",
          },
        },
      },
    },
    capabilities: {
      streaming: true,
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

  const taskSkills = skills.filter((s) => s.name.startsWith("task."));
  const labelSkills = skills.filter((s) => s.name.startsWith("label."));
  const commentSkills = skills.filter((s) => s.name.startsWith("comment."));
  const cycleSkills = skills.filter((s) => s.name.startsWith("cycle."));
  const projectSkills = skills.filter((s) => s.name.startsWith("project."));

  const formatSkillGroup = (group: typeof skills) =>
    group.map((s) => {
      const approval = s.approval === "conditional" ? " - REQUIRES HUMAN APPROVAL for cancellation" : "";
      return `- **${s.name}**: ${s.description} (scope: ${s.scope})${approval}`;
    }).join("\n");

  return `# TaskPilot A2A Protocol API

> A2A (Agent-to-Agent) Protocol v0.3 implementation enabling AI agents to manage tasks, projects, labels, cycles, and team assignments through a standardized JSON-RPC 2.0 interface with OAuth 2.0 authentication.

## Quick Start

This API allows AI agents to:
- Create, search, update, and move tasks across projects with smart routing
- Assign/unassign team members and manage labels
- Track sprints/cycles and add comments
- Get project summaries with 3-state status (pending/in_progress/completed)
- All operations authenticated via OAuth 2.0 with PKCE
- Real-time updates via Server-Sent Events (SSE)
- Webhook notifications for task state changes

## Authentication

OAuth 2.0 Authorization Code flow with PKCE is required:
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

### Real-Time Updates
- [SSE Stream](${baseUrl}/a2a/stream?taskId=TASK_ID): Subscribe to real-time task state changes

## Available Skills

### Task Operations
${formatSkillGroup(taskSkills)}

### Label Management
${formatSkillGroup(labelSkills)}

### Comments
${formatSkillGroup(commentSkills)}

### Cycles / Sprints
${formatSkillGroup(cycleSkills)}

### Project Discovery
${formatSkillGroup(projectSkills)}

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

## Human-in-the-Loop Approvals

Some actions require human approval (currently: cancelling a task via task.move):
1. Task enters **auth_required** state
2. Human receives notification via Slack/Telegram (DharaHIL gateway)
3. Human can: APPROVE (execute), REJECT (deny), or REVISE (request changes)
4. Timeout based on risk level (set by DharaHIL gateway)
5. If timeout: Task auto-rejected (fail-safe)

## OAuth Scopes

- taskpilot:read — Read projects, tasks, members, labels, cycles
- taskpilot:write — Create/update/move tasks, assign, label

## Error Codes

JSON-RPC standard error codes:
- -32700: Parse error (invalid JSON)
- -32600: Invalid Request (missing jsonrpc/method)
- -32601: Method not found (unknown skill)
- -32602: Invalid params (validation failed)
- -32603: Internal error (server error)
- -32002: Authentication required (invalid token)
- -32003: Rate limit exceeded
- -32004: Approval required (HITL)

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
5. Task transitions to "completed" (if approved) or "rejected"
6. Poll via task.get or use SSE to get final result

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
8. Handle approval workflow for cancellation operations
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
