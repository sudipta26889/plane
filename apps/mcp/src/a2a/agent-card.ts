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
  const skillDocs = skills
    .map((s) => `- ${s.name}: ${s.description} (scope: ${s.scope})`)
    .join("\n");

  return `# TaskPilot A2A Protocol API

## Overview
TaskPilot is an AI-native project management agent. It exposes 18 skills via the A2A (Agent-to-Agent) protocol v0.3.

## Base URL
${baseUrl}/a2a

## Authentication
Type: oauth2 (Authorization Code with PKCE)

### Endpoints
- Authorization: ${baseUrl}/authorize
- Token: ${baseUrl}/token
- Agent Card: ${baseUrl}/.well-known/agent-card.json

### Scopes
- taskpilot:read — Read projects, tasks, members, labels, cycles
- taskpilot:write — Create/update/move tasks, assign, label

## JSON-RPC Methods
- initialize — Protocol handshake (no auth required)
- message.send — Execute a skill (params: contextId, skill, input)
- task.get — Get task status (params: taskId)
- task.list — List tasks in context (params: contextId)
- task.cancel — Cancel a task (params: taskId)
- context.get — List all tasks in context (params: contextId)

## Skills
${skillDocs}

## Example: message.send
\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message.send",
  "params": {
    "contextId": "my-context",
    "skill": "task.create",
    "input": { "title": "Fix login bug", "priority": "high" }
  }
}
\`\`\`

## Human-in-the-Loop
task.move to "Cancelled" state requires human approval via DharaHIL gateway.

## Error Codes
- -32700: Parse error
- -32600: Invalid request
- -32601: Method not found
- -32602: Invalid params
- -32603: Internal error
- -32002: Auth required
- -32003: Rate limited
- -32004: Approval required
`;
}
