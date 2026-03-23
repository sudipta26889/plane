# TaskPilot A2A Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add A2A v0.3 protocol to TaskPilot's MCP server — agent card discovery, async task execution wrapping existing MCP handlers, DharaHIL HITL for critical actions (both MCP and A2A), Redis rate limiting, HMAC webhooks, SSE streaming, and audit logging.

**Architecture:** A2A lives in `apps/mcp/src/a2a/` alongside existing MCP code. The A2A `task-executor` wraps `executeToolCall()` from `handlers.ts` — no handler duplication. DharaHIL HITL is shared: critical actions (cancel task) require approval regardless of protocol. Rate limiting uses Redis (already configured). 6 new PostgreSQL tables for tasks, history, approvals, webhooks, deliveries, and audit logs.

**Tech Stack:** TypeScript, Express, PostgreSQL (pg), Redis (ioredis), DharaHIL gateway API

**Spec:** `docs/superpowers/specs/2026-03-23-a2a-protocol-design.md`

---

### Task 1: Types, Config, and Database Schema

**Files:**
- Create: `apps/mcp/src/a2a/types.ts`
- Modify: `apps/mcp/src/config.ts`
- Modify: `apps/mcp/src/db.ts`
- Test: `apps/mcp/src/a2a/__tests__/types.test.ts`

- [ ] **Step 1: Write the types test**

```typescript
// apps/mcp/src/a2a/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import {
  A2A_TASK_STATES,
  TERMINAL_STATES,
  isTerminalState,
  isValidTransition,
} from "../types.js";

describe("A2A types", () => {
  it("defines all task states", () => {
    expect(A2A_TASK_STATES).toContain("submitted");
    expect(A2A_TASK_STATES).toContain("working");
    expect(A2A_TASK_STATES).toContain("completed");
    expect(A2A_TASK_STATES).toContain("failed");
    expect(A2A_TASK_STATES).toContain("auth_required");
    expect(A2A_TASK_STATES).toContain("canceled");
    expect(A2A_TASK_STATES).toContain("rejected");
  });

  it("identifies terminal states", () => {
    expect(isTerminalState("completed")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
    expect(isTerminalState("canceled")).toBe(true);
    expect(isTerminalState("rejected")).toBe(true);
    expect(isTerminalState("submitted")).toBe(false);
    expect(isTerminalState("working")).toBe(false);
    expect(isTerminalState("auth_required")).toBe(false);
  });

  it("validates state transitions", () => {
    expect(isValidTransition("submitted", "working")).toBe(true);
    expect(isValidTransition("submitted", "canceled")).toBe(true);
    expect(isValidTransition("working", "completed")).toBe(true);
    expect(isValidTransition("working", "failed")).toBe(true);
    expect(isValidTransition("submitted", "auth_required")).toBe(true);
    expect(isValidTransition("auth_required", "submitted")).toBe(true);
    expect(isValidTransition("auth_required", "rejected")).toBe(true);
    expect(isValidTransition("completed", "working")).toBe(false);
    expect(isValidTransition("failed", "submitted")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create types.ts**

```typescript
// apps/mcp/src/a2a/types.ts
export const A2A_TASK_STATES = [
  "submitted",
  "working",
  "completed",
  "failed",
  "auth_required",
  "canceled",
  "rejected",
] as const;

export type A2aTaskState = (typeof A2A_TASK_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<A2aTaskState> = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

const VALID_TRANSITIONS: Record<string, A2aTaskState[]> = {
  submitted: ["working", "auth_required", "canceled", "failed"],
  working: ["completed", "failed"],
  auth_required: ["submitted", "rejected", "canceled"],
};

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state as A2aTaskState);
}

export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to as A2aTaskState);
}

export interface A2aTask {
  id: number;
  task_id: string;
  context_id: string;
  client_id: string;
  user_id: string;
  workspace_slug: string;
  skill: string;
  input: Record<string, any>;
  state: A2aTaskState;
  state_reason: string | null;
  result: any | null;
  error: any | null;
  requires_approval: boolean;
  idempotency_key: string | null;
  retry_count: number;
  max_retries: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

// Standard JSON-RPC + A2A error codes
export const A2A_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_REQUIRED: -32002,
  RATE_LIMITED: -32003,
  APPROVAL_REQUIRED: -32004,
} as const;

export interface A2aJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, any>;
}

// Reuse AuthContext from handlers.ts — move the interface here and import in both places
export interface AuthContext {
  userId: string;
  workspaceSlug: string;
  clientId: string;
  scopes: string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 5: Update config.ts with DharaHIL fields**

Add after the existing `jwtSecret` field in `apps/mcp/src/config.ts`:

```typescript
// DharaHIL (Human-in-the-Loop)
dharahilBaseUrl: process.env.DHARAHIL_BASE_URL || "",
dharahilApiKey: process.env.DHARAHIL_API_KEY || "",
dharahilTenantId: process.env.DHARAHIL_TENANT_ID || "",
dharahilAppId: process.env.DHARAHIL_APP_ID || "",
dharahilEnabled: process.env.DHARAHIL_ENABLED === "true",

// A2A max wait for MCP HITL (ms)
mcpHitlTimeoutMs: parseInt(process.env.MCP_HITL_TIMEOUT_MS || "60000", 10),
```

- [ ] **Step 6: Add A2A tables to db.ts**

Add a new `initA2aDatabase()` function in `apps/mcp/src/db.ts` and call it from `initDatabase()`. Contains all 6 CREATE TABLE statements and indexes from the spec. See spec section "Database Schema" for exact SQL.

- [ ] **Step 7: Run all existing tests to verify nothing breaks**

Run: `cd apps/mcp && npx vitest run`
Expected: All tests pass (existing + new types test)

- [ ] **Step 8: Commit**

```bash
git add apps/mcp/src/a2a/types.ts apps/mcp/src/a2a/__tests__/types.test.ts apps/mcp/src/config.ts apps/mcp/src/db.ts
git commit -m "feat(a2a): add types, config, and database schema for A2A protocol"
```

---

### Task 2: Skill Registry

**Files:**
- Create: `apps/mcp/src/a2a/skill-registry.ts`
- Test: `apps/mcp/src/a2a/__tests__/skill-registry.test.ts`

- [ ] **Step 1: Write the skill registry test**

```typescript
// apps/mcp/src/a2a/__tests__/skill-registry.test.ts
import { describe, it, expect } from "vitest";
import {
  getSkillDefinition,
  getAllSkills,
  isCriticalAction,
} from "../skill-registry.js";

describe("Skill Registry", () => {
  it("maps all 18 A2A skills to MCP tools", () => {
    const skills = getAllSkills();
    expect(skills.length).toBe(18);
  });

  it("resolves task.create to create_task", () => {
    const skill = getSkillDefinition("task.create");
    expect(skill).toBeDefined();
    expect(skill!.mcpTool).toBe("create_task");
    expect(skill!.scope).toBe("taskpilot:write");
    expect(skill!.approval).toBe(false);
  });

  it("resolves project.list to list_projects", () => {
    const skill = getSkillDefinition("project.list");
    expect(skill).toBeDefined();
    expect(skill!.mcpTool).toBe("list_projects");
    expect(skill!.scope).toBe("taskpilot:read");
  });

  it("returns undefined for unknown skills", () => {
    expect(getSkillDefinition("nonexistent")).toBeUndefined();
  });

  it("identifies task.move to Cancelled as critical", () => {
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "Cancelled" })).toBe(true);
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "cancelled" })).toBe(true);
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "In Progress" })).toBe(false);
    expect(isCriticalAction("create_task", { title: "test" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/skill-registry.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement skill-registry.ts**

```typescript
// apps/mcp/src/a2a/skill-registry.ts
export interface SkillDefinition {
  name: string;
  mcpTool: string;
  scope: "taskpilot:read" | "taskpilot:write";
  approval: boolean | "conditional";
  description: string;
}

const SKILL_REGISTRY: Record<string, SkillDefinition> = {
  "task.create":          { name: "task.create",          mcpTool: "create_task",      scope: "taskpilot:write", approval: false, description: "Create a new task with smart project routing" },
  "task.update":          { name: "task.update",          mcpTool: "update_task",      scope: "taskpilot:write", approval: false, description: "Update task fields" },
  "task.find":            { name: "task.find",            mcpTool: "find_tasks",       scope: "taskpilot:read",  approval: false, description: "Search tasks by query" },
  "task.get":             { name: "task.get",             mcpTool: "get_task",         scope: "taskpilot:read",  approval: false, description: "Get task details by identifier" },
  "task.move":            { name: "task.move",            mcpTool: "move_task",        scope: "taskpilot:write", approval: "conditional", description: "Change task state" },
  "task.summarize":       { name: "task.summarize",       mcpTool: "get_task_summary", scope: "taskpilot:read",  approval: false, description: "Get project summary with 3-state status" },
  "task.assign":          { name: "task.assign",          mcpTool: "assign_task",      scope: "taskpilot:write", approval: false, description: "Assign a user to a task" },
  "task.unassign":        { name: "task.unassign",        mcpTool: "unassign_task",    scope: "taskpilot:write", approval: false, description: "Remove user assignment" },
  "label.add":            { name: "label.add",            mcpTool: "add_label",        scope: "taskpilot:write", approval: false, description: "Add a label to a task" },
  "label.remove":         { name: "label.remove",         mcpTool: "remove_label",     scope: "taskpilot:write", approval: false, description: "Remove a label from a task" },
  "comment.add":          { name: "comment.add",          mcpTool: "add_comment",      scope: "taskpilot:write", approval: false, description: "Add a comment to a task" },
  "cycle.assign":         { name: "cycle.assign",         mcpTool: "assign_to_cycle",  scope: "taskpilot:write", approval: false, description: "Add task to a sprint/cycle" },
  "project.list":         { name: "project.list",         mcpTool: "list_projects",    scope: "taskpilot:read",  approval: false, description: "List all projects" },
  "project.list_states":  { name: "project.list_states",  mcpTool: "list_states",      scope: "taskpilot:read",  approval: false, description: "List workflow states" },
  "project.list_members": { name: "project.list_members", mcpTool: "list_members",     scope: "taskpilot:read",  approval: false, description: "List project members" },
  "project.list_labels":  { name: "project.list_labels",  mcpTool: "list_labels",      scope: "taskpilot:read",  approval: false, description: "List available labels" },
  "project.list_cycles":  { name: "project.list_cycles",  mcpTool: "list_cycles",      scope: "taskpilot:read",  approval: false, description: "List sprints/cycles" },
  "project.list_tasks":   { name: "project.list_tasks",   mcpTool: "list_tasks",       scope: "taskpilot:read",  approval: false, description: "List tasks with filters" },
};

export function getSkillDefinition(skillName: string): SkillDefinition | undefined {
  return SKILL_REGISTRY[skillName];
}

export function getAllSkills(): SkillDefinition[] {
  return Object.values(SKILL_REGISTRY);
}

/**
 * Check if an MCP tool call with given args is a critical action requiring HITL.
 * Shared between MCP and A2A protocols.
 */
export function isCriticalAction(mcpTool: string, args: Record<string, any>): boolean {
  if (mcpTool === "move_task" && typeof args.state === "string") {
    return args.state.toLowerCase() === "cancelled";
  }
  return false;
}

/**
 * Check if an A2A skill + input requires approval.
 * Returns true if the skill has conditional approval and the input matches critical rules.
 */
export function requiresApproval(skillName: string, input: Record<string, any>): boolean {
  const skill = SKILL_REGISTRY[skillName];
  if (!skill) return false;
  if (skill.approval === true) return true;
  if (skill.approval === "conditional") {
    return isCriticalAction(skill.mcpTool, input);
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/skill-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/skill-registry.ts apps/mcp/src/a2a/__tests__/skill-registry.test.ts
git commit -m "feat(a2a): add skill registry mapping 18 A2A skills to MCP tools"
```

---

### Task 3: Audit Logging

**Files:**
- Create: `apps/mcp/src/a2a/audit-log.ts`
- Test: `apps/mcp/src/a2a/__tests__/audit-log.test.ts`

- [ ] **Step 1: Write audit log test**

```typescript
// apps/mcp/src/a2a/__tests__/audit-log.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildAuditEntry } from "../audit-log.js";

describe("Audit Log", () => {
  it("builds an audit entry with all fields", () => {
    const entry = buildAuditEntry({
      userId: "user-1",
      clientId: "client-1",
      ipAddress: "127.0.0.1",
      operation: "task.created",
      taskId: "task-1",
      skill: "task.create",
      success: true,
      metadata: { duration_ms: 42 },
    });
    expect(entry.user_id).toBe("user-1");
    expect(entry.operation).toBe("task.created");
    expect(entry.success).toBe(true);
    expect(entry.metadata).toEqual({ duration_ms: 42 });
  });

  it("builds a failure entry with error details", () => {
    const entry = buildAuditEntry({
      userId: "user-1",
      clientId: "client-1",
      ipAddress: "127.0.0.1",
      operation: "auth.failure",
      success: false,
      errorCode: "invalid_token",
      errorMessage: "Token expired",
    });
    expect(entry.success).toBe(false);
    expect(entry.error_code).toBe("invalid_token");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/audit-log.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement audit-log.ts**

Contains `buildAuditEntry()` (pure function) and `logAuditEvent()` (inserts into `a2a_audit_logs` via `db.query`). The test covers the pure function; DB insertion is tested in integration tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/audit-log.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/audit-log.ts apps/mcp/src/a2a/__tests__/audit-log.test.ts
git commit -m "feat(a2a): add audit logging module"
```

---

### Task 4: Rate Limiting (Redis)

**Files:**
- Create: `apps/mcp/src/a2a/rate-limit.ts`
- Test: `apps/mcp/src/a2a/__tests__/rate-limit.test.ts`

- [ ] **Step 1: Write rate limit test**

Test the pure logic: `getRateLimitKey()` function that constructs Redis keys, and `RATE_LIMITS` constant validation. The actual Redis INCR/EXPIRE logic is tested in integration tests.

```typescript
// apps/mcp/src/a2a/__tests__/rate-limit.test.ts
import { describe, it, expect } from "vitest";
import { getRateLimitKey, RATE_LIMITS } from "../rate-limit.js";

describe("Rate Limiting", () => {
  it("generates correct Redis keys for client", () => {
    expect(getRateLimitKey("client", "cli-123", "minute")).toBe("a2a:rl:client:cli-123:minute");
  });

  it("generates correct Redis keys for user", () => {
    expect(getRateLimitKey("user", "user-456", "hour")).toBe("a2a:rl:user:user-456:hour");
  });

  it("generates correct Redis keys for IP", () => {
    expect(getRateLimitKey("ip", "1.2.3.4", "minute")).toBe("a2a:rl:ip:1.2.3.4:minute");
  });

  it("defines all rate limit tiers", () => {
    expect(RATE_LIMITS.client_per_minute).toBe(60);
    expect(RATE_LIMITS.client_per_hour).toBe(1000);
    expect(RATE_LIMITS.user_per_minute).toBe(100);
    expect(RATE_LIMITS.user_per_hour).toBe(2000);
    expect(RATE_LIMITS.task_create_per_minute).toBe(30);
    expect(RATE_LIMITS.ip_per_minute).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/rate-limit.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement rate-limit.ts**

Uses `ioredis` (already a dependency in `package.json`). Exports:
- `RATE_LIMITS` constant
- `getRateLimitKey(scope, id, window)` — pure function
- `checkRateLimit(redis, clientId, userId, ipAddress, isTaskCreate)` — performs multi-tier check using Redis INCR + EXPIRE, returns `{ allowed: boolean, limit: number, remaining: number, resetAt: number }`
- `buildRateLimitHeaders(result)` — returns object of HTTP headers

Redis key pattern: `a2a:rl:{scope}:{id}:{window}` with TTL = 60s for minute windows, 3600s for hour windows.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/rate-limit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/rate-limit.ts apps/mcp/src/a2a/__tests__/rate-limit.test.ts
git commit -m "feat(a2a): add Redis-based rate limiting"
```

---

### Task 5: DharaHIL Client

**Files:**
- Create: `apps/mcp/src/a2a/dharahil.ts`
- Test: `apps/mcp/src/a2a/__tests__/dharahil.test.ts`

- [ ] **Step 1: Write DharaHIL client test**

```typescript
// apps/mcp/src/a2a/__tests__/dharahil.test.ts
import { describe, it, expect } from "vitest";
import {
  buildApprovalRequest,
  interpretDecision,
} from "../dharahil.js";

describe("DharaHIL Client", () => {
  it("builds an approval request for task cancellation", () => {
    const req = buildApprovalRequest({
      toolName: "move_task",
      toolArgs: { identifier: "PROJ-42", state: "Cancelled" },
      userId: "user-1",
      taskId: "task-1",
      contextSummary: 'Cancel task PROJ-42: "Fix bug"',
    });
    expect(req.tool_name).toBe("move_task");
    expect(req.context.risk_level).toBe("MEDIUM");
    expect(req.context.tags).toContain("cancel");
    expect(req.context.idempotency_key).toContain("task_move_PROJ-42");
  });

  it("interprets APPROVED decision", () => {
    const result = interpretDecision({ action: "APPROVED" });
    expect(result.shouldProceed).toBe(true);
    expect(result.shouldReject).toBe(false);
  });

  it("interprets REJECTED decision", () => {
    const result = interpretDecision({ action: "REJECTED", reason: "No" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(true);
    expect(result.reason).toBe("No");
  });

  it("interprets EXPIRED as rejection", () => {
    const result = interpretDecision({ action: "EXPIRED" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(true);
  });

  it("interprets REVISE_REQUESTED as rejection for task operations", () => {
    const result = interpretDecision({ action: "REVISE_REQUESTED" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(true);
  });

  it("interprets ERROR as rejection (fail-closed)", () => {
    const result = interpretDecision({ action: "ERROR" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/dharahil.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement dharahil.ts**

Exports:
- `buildApprovalRequest(params)` — pure function, builds DharaHIL request body
- `interpretDecision(decision)` — pure function, returns `{ shouldProceed, shouldReject, reason }`
- `submitApproval(request)` — HTTP POST to `${config.dharahilBaseUrl}/v1/requests`, returns `{ requestId, expiresAt }`
- `pollForDecision(requestId, expiresAt, timeoutMs?)` — polls GET `/v1/requests/{id}` every 3 seconds until decision or timeout
- `runApprovalLoop(params, timeoutMs?)` — combines submit + poll, returns decision

The pure functions (`buildApprovalRequest`, `interpretDecision`) are tested with unit tests. The HTTP functions (`submitApproval`, `pollForDecision`) are tested in integration tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/dharahil.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/dharahil.ts apps/mcp/src/a2a/__tests__/dharahil.test.ts
git commit -m "feat(a2a): add DharaHIL HITL client for approval workflows"
```

---

### Task 6: DharaHIL Integration into MCP executeToolCall

**Files:**
- Modify: `apps/mcp/src/tools/handlers.ts` (lines 58-79, `executeToolCall` function)
- Test: `apps/mcp/src/a2a/__tests__/mcp-hitl.test.ts`

- [ ] **Step 1: Write MCP HITL test**

```typescript
// apps/mcp/src/a2a/__tests__/mcp-hitl.test.ts
import { describe, it, expect } from "vitest";
import { isCriticalAction } from "../skill-registry.js";

describe("MCP HITL critical action detection", () => {
  it("detects move_task to Cancelled as critical", () => {
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "Cancelled" })).toBe(true);
  });

  it("is case-insensitive for state matching", () => {
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "CANCELLED" })).toBe(true);
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "cancelled" })).toBe(true);
  });

  it("does not flag non-cancel moves", () => {
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "Done" })).toBe(false);
    expect(isCriticalAction("move_task", { identifier: "X-1", state: "In Progress" })).toBe(false);
  });

  it("does not flag non-move tools", () => {
    expect(isCriticalAction("create_task", { title: "test" })).toBe(false);
    expect(isCriticalAction("update_task", { identifier: "X-1", title: "new" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (reuses skill-registry tests)

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/mcp-hitl.test.ts`
Expected: PASS (uses already-implemented `isCriticalAction`)

- [ ] **Step 3: Modify executeToolCall in handlers.ts**

Add HITL check after scope validation, before calling the handler:

```typescript
// In executeToolCall(), after line 73 (handler lookup), before line 76 (API token):
import { isCriticalAction } from "../a2a/skill-registry.js";
import { runApprovalLoop } from "../a2a/dharahil.js";
import { config } from "../config.js";

// Inside executeToolCall, after `if (!handler) throw`:
if (config.dharahilEnabled && isCriticalAction(name, args)) {
  const decision = await runApprovalLoop({
    toolName: name,
    toolArgs: args,
    userId: auth.userId,
    taskId: `mcp_${Date.now()}`,
    contextSummary: `MCP: ${name} with args ${JSON.stringify(args)}`,
  }, config.mcpHitlTimeoutMs);

  if (!decision.shouldProceed) {
    throw new Error(`Action requires approval: ${decision.reason || "Rejected or timed out"}`);
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `cd apps/mcp && npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/tools/handlers.ts apps/mcp/src/a2a/__tests__/mcp-hitl.test.ts
git commit -m "feat(a2a): add DharaHIL HITL check to MCP executeToolCall for critical actions"
```

---

### Task 7: Webhooks

**Files:**
- Create: `apps/mcp/src/a2a/webhooks.ts`
- Test: `apps/mcp/src/a2a/__tests__/webhooks.test.ts`

- [ ] **Step 1: Write webhook test**

```typescript
// apps/mcp/src/a2a/__tests__/webhooks.test.ts
import { describe, it, expect } from "vitest";
import { signPayload, buildWebhookPayload, WEBHOOK_EVENTS } from "../webhooks.js";

describe("Webhooks", () => {
  it("signs payload with HMAC-SHA256", () => {
    const signature = signPayload('{"test":true}', "secret-key");
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("produces deterministic signatures", () => {
    const sig1 = signPayload('{"a":1}', "key");
    const sig2 = signPayload('{"a":1}', "key");
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different secrets", () => {
    const sig1 = signPayload('{"a":1}', "key1");
    const sig2 = signPayload('{"a":1}', "key2");
    expect(sig1).not.toBe(sig2);
  });

  it("builds webhook payload for task.completed event", () => {
    const payload = buildWebhookPayload("task.completed", {
      task_id: "t-1",
      context_id: "ctx-1",
      skill: "task.create",
      state: "completed",
      result: { id: "123" },
      created_at: new Date("2026-01-01"),
      completed_at: new Date("2026-01-01"),
    });
    expect(payload.event).toBe("task.completed");
    expect(payload.task.id).toBe("t-1");
    expect(payload.task.state).toBe("completed");
    expect(payload.timestamp).toBeDefined();
  });

  it("defines all webhook events", () => {
    expect(WEBHOOK_EVENTS).toContain("task.created");
    expect(WEBHOOK_EVENTS).toContain("task.state_changed");
    expect(WEBHOOK_EVENTS).toContain("task.completed");
    expect(WEBHOOK_EVENTS).toContain("task.failed");
    expect(WEBHOOK_EVENTS).toContain("task.canceled");
    expect(WEBHOOK_EVENTS).toContain("task.rejected");
    expect(WEBHOOK_EVENTS).toContain("task.approval_required");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/webhooks.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement webhooks.ts**

Exports:
- `WEBHOOK_EVENTS` — array of event type strings
- `signPayload(payload, secret)` — HMAC-SHA256, returns `sha256=<hex>`
- `buildWebhookPayload(event, task)` — builds the webhook JSON body
- `deliverWebhook(config, payload)` — fire-and-forget HTTP POST with signature header
- `queueWebhookDeliveries(db, taskId, event, taskData)` — looks up matching webhook configs, inserts delivery records, fires each
- Retry backoff constants: `[1000, 5000, 15000, 60000, 300000]`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/webhooks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/webhooks.ts apps/mcp/src/a2a/__tests__/webhooks.test.ts
git commit -m "feat(a2a): add HMAC-signed webhook delivery system"
```

---

### Task 8: Task Executor (State Machine + MCP Handler Wrapper)

**Files:**
- Create: `apps/mcp/src/a2a/task-executor.ts`
- Test: `apps/mcp/src/a2a/__tests__/task-executor.test.ts`

- [ ] **Step 1: Write task executor test**

Test the pure state transition logic. DB operations are mocked.

```typescript
// apps/mcp/src/a2a/__tests__/task-executor.test.ts
import { describe, it, expect } from "vitest";
import { isValidTransition } from "../types.js";
import { mapSkillInputToMcpArgs } from "../task-executor.js";

describe("Task Executor", () => {
  it("maps A2A skill input to MCP tool args (pass-through)", () => {
    const result = mapSkillInputToMcpArgs("task.create", {
      title: "Buy milk",
      project_hint: "Shopping",
    });
    expect(result).toEqual({ title: "Buy milk", project_hint: "Shopping" });
  });

  it("state transitions follow the state machine", () => {
    // Valid transitions
    expect(isValidTransition("submitted", "working")).toBe(true);
    expect(isValidTransition("working", "completed")).toBe(true);
    expect(isValidTransition("working", "failed")).toBe(true);
    expect(isValidTransition("auth_required", "submitted")).toBe(true);
    expect(isValidTransition("auth_required", "rejected")).toBe(true);
    expect(isValidTransition("submitted", "canceled")).toBe(true);
    expect(isValidTransition("auth_required", "canceled")).toBe(true);

    // Invalid transitions (terminal states cannot transition)
    expect(isValidTransition("completed", "working")).toBe(false);
    expect(isValidTransition("failed", "submitted")).toBe(false);
    expect(isValidTransition("canceled", "submitted")).toBe(false);
    expect(isValidTransition("rejected", "submitted")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** (will fail on `mapSkillInputToMcpArgs` import)

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/task-executor.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement task-executor.ts**

Core logic:
- `mapSkillInputToMcpArgs(skill, input)` — maps A2A skill input to MCP tool args (currently pass-through since names match)
- `createA2aTask(db, params)` — inserts into `a2a_tasks`, records initial state in `a2a_task_history`
- `transitionState(db, taskId, newState, reason?)` — validates transition, updates `a2a_tasks`, inserts `a2a_task_history`
- `executeA2aTask(db, task, auth)` — the main execution function:
  1. Transition to `working`
  2. Call `executeToolCall(skill.mcpTool, args, auth)` from `handlers.ts`
  3. On success: transition to `completed`, store result
  4. On error: increment retry, retry or transition to `failed`
  5. Queue webhooks, log audit

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/task-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/task-executor.ts apps/mcp/src/a2a/__tests__/task-executor.test.ts
git commit -m "feat(a2a): add task executor with state machine wrapping MCP handlers"
```

---

### Task 9: A2A Auth

**Files:**
- Create: `apps/mcp/src/a2a/auth.ts`
- Test: `apps/mcp/src/a2a/__tests__/auth.test.ts`

- [ ] **Step 1: Write auth test**

```typescript
// apps/mcp/src/a2a/__tests__/auth.test.ts
import { describe, it, expect } from "vitest";
import { hasRequiredScope } from "../auth.js";

describe("A2A Auth", () => {
  it("checks scope presence", () => {
    expect(hasRequiredScope(["taskpilot:read", "taskpilot:write"], "taskpilot:read")).toBe(true);
    expect(hasRequiredScope(["taskpilot:read"], "taskpilot:write")).toBe(false);
    expect(hasRequiredScope([], "taskpilot:read")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/auth.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement auth.ts**

Reuses `validateAccessToken` from `../utils/tokens.js`. Exports:
- `hasRequiredScope(scopes, required)` — checks if scope array contains required scope
- `authenticateA2aRequest(req)` — extracts Bearer token from `Authorization` header or `token` query param, calls `validateAccessToken`, returns `A2aAuthContext` or throws

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/auth.ts apps/mcp/src/a2a/__tests__/auth.test.ts
git commit -m "feat(a2a): add A2A auth module reusing MCP OAuth tokens"
```

---

### Task 10: Agent Card & llms.txt

**Files:**
- Create: `apps/mcp/src/a2a/agent-card.ts`
- Test: `apps/mcp/src/a2a/__tests__/agent-card.test.ts`

- [ ] **Step 1: Write agent card test**

```typescript
// apps/mcp/src/a2a/__tests__/agent-card.test.ts
import { describe, it, expect } from "vitest";
import { buildAgentCard, buildLlmsTxt } from "../agent-card.js";

describe("Agent Card", () => {
  it("builds valid agent card JSON", () => {
    const card = buildAgentCard("https://mcp.taskpilot.sudiptadhara.in");
    expect(card.name).toBe("TaskPilot");
    expect(card.protocol).toBe("a2a");
    expect(card.protocolVersion).toBe("0.3");
    expect(card.url).toBe("https://mcp.taskpilot.sudiptadhara.in/a2a");
    expect(card.skills.length).toBe(18);
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.webhooks).toBe(true);
    expect(card.capabilities.humanInTheLoop).toBe(true);
    expect(card.authentication.type).toBe("oauth2");
  });

  it("includes all skills with names and descriptions", () => {
    const card = buildAgentCard("https://example.com");
    for (const skill of card.skills) {
      expect(skill.name).toBeDefined();
      expect(skill.description).toBeDefined();
    }
  });

  it("builds llms.txt with auth and skills documentation", () => {
    const txt = buildLlmsTxt("https://mcp.taskpilot.sudiptadhara.in");
    expect(txt).toContain("TaskPilot A2A Protocol");
    expect(txt).toContain("task.create");
    expect(txt).toContain("message.send");
    expect(txt).toContain("oauth2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/agent-card.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement agent-card.ts**

Exports:
- `buildAgentCard(baseUrl)` — returns the Agent Card JSON object per spec
- `buildLlmsTxt(baseUrl)` — returns plain-text documentation string

Uses `getAllSkills()` from `skill-registry.ts` to populate skills list.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/agent-card.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/agent-card.ts apps/mcp/src/a2a/__tests__/agent-card.test.ts
git commit -m "feat(a2a): add agent card and llms.txt discovery endpoints"
```

---

### Task 11: SSE Streaming

**Files:**
- Create: `apps/mcp/src/a2a/sse.ts`
- Test: `apps/mcp/src/a2a/__tests__/sse.test.ts`

- [ ] **Step 1: Write SSE test**

```typescript
// apps/mcp/src/a2a/__tests__/sse.test.ts
import { describe, it, expect } from "vitest";
import { formatSseEvent, SSE_MAX_CONNECTION_MS, SSE_PING_INTERVAL_MS } from "../sse.js";

describe("SSE", () => {
  it("formats SSE event correctly", () => {
    const result = formatSseEvent("task.completed", { taskId: "t-1", state: "completed" });
    expect(result).toBe('event: task.completed\ndata: {"taskId":"t-1","state":"completed"}\n\n');
  });

  it("formats ping event", () => {
    const result = formatSseEvent("ping", { timestamp: "2026-01-01T00:00:00Z" });
    expect(result).toContain("event: ping");
  });

  it("has 5-minute max connection", () => {
    expect(SSE_MAX_CONNECTION_MS).toBe(5 * 60 * 1000);
  });

  it("has 15-second ping interval", () => {
    expect(SSE_PING_INTERVAL_MS).toBe(15 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/sse.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement sse.ts**

Exports:
- `SSE_MAX_CONNECTION_MS` = 300000 (5 minutes)
- `SSE_PING_INTERVAL_MS` = 15000 (15 seconds)
- `formatSseEvent(event, data)` — formats as SSE text
- `SseManager` class — manages active SSE connections per taskId, provides `addListener(taskId, res)`, `notify(taskId, event, data)`, `removeListener(taskId, res)`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/sse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/sse.ts apps/mcp/src/a2a/__tests__/sse.test.ts
git commit -m "feat(a2a): add SSE streaming for real-time task updates"
```

---

### Task 12: Protocol Handler (JSON-RPC Dispatch)

**Files:**
- Create: `apps/mcp/src/a2a/protocol-handler.ts`
- Test: `apps/mcp/src/a2a/__tests__/protocol-handler.test.ts`

- [ ] **Step 1: Write protocol handler test**

```typescript
// apps/mcp/src/a2a/__tests__/protocol-handler.test.ts
import { describe, it, expect } from "vitest";
import { validateJsonRpcRequest, A2A_METHODS } from "../protocol-handler.js";

describe("Protocol Handler", () => {
  it("validates a correct JSON-RPC request", () => {
    const result = validateJsonRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects missing jsonrpc field", () => {
    const result = validateJsonRpcRequest({ id: 1, method: "initialize" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("jsonrpc");
  });

  it("rejects missing method", () => {
    const result = validateJsonRpcRequest({ jsonrpc: "2.0", id: 1 });
    expect(result.valid).toBe(false);
  });

  it("defines all A2A methods", () => {
    expect(A2A_METHODS).toContain("initialize");
    expect(A2A_METHODS).toContain("message.send");
    expect(A2A_METHODS).toContain("task.get");
    expect(A2A_METHODS).toContain("task.list");
    expect(A2A_METHODS).toContain("task.cancel");
    expect(A2A_METHODS).toContain("context.get");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/protocol-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement protocol-handler.ts**

Central dispatch for A2A JSON-RPC methods. Exports:
- `A2A_METHODS` — array of supported method names
- `validateJsonRpcRequest(body)` — validates structure
- `handleA2aRequest(body, auth, context)` — dispatches to method handlers:
  - `initialize` → returns capabilities (no auth)
  - `message.send` → validates skill, checks scope, checks idempotency key (if `params.idempotencyKey` provided, query `a2a_tasks` by key — if found, return existing task), checks approval, creates task, executes inline or async
  - `task.get` → queries `a2a_tasks` by taskId
  - `task.list` → queries `a2a_tasks` by contextId
  - `task.cancel` → transitions non-terminal tasks to `canceled`
  - `context.get` → queries `a2a_tasks` by contextId (same as task.list)
  - `webhook.configure` → inserts/updates `a2a_webhook_configs`

Each method handler calls audit logging and rate limiting.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mcp && npx vitest run src/a2a/__tests__/protocol-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/a2a/protocol-handler.ts apps/mcp/src/a2a/__tests__/protocol-handler.test.ts
git commit -m "feat(a2a): add JSON-RPC protocol handler with method dispatch"
```

---

### Task 13: Express Route and Server Integration

**Files:**
- Create: `apps/mcp/src/routes/a2a.ts`
- Modify: `apps/mcp/src/index.ts`

- [ ] **Step 1: Create A2A Express router**

`apps/mcp/src/routes/a2a.ts` — Express router handling:
- `GET /.well-known/agent-card.json` → calls `buildAgentCard(config.baseUrl)`
- `POST /a2a` → calls `authenticateA2aRequest` (except for `initialize`), `checkRateLimit`, `handleA2aRequest`, sets rate limit headers
- `GET /a2a/stream` → SSE endpoint, authenticates via `token` query param, sets up SSE connection
- `GET /a2a/llms.txt` → returns `buildLlmsTxt(config.baseUrl)` as `text/plain`

Reads `req.ip` for rate limiting. Uses `setCorsHeaders` from existing utils.

- [ ] **Step 2: Mount A2A router in index.ts**

Add to `apps/mcp/src/index.ts` after existing route mounts:

```typescript
import a2aRouter from "./routes/a2a.js";

// A2A protocol endpoints
app.use(a2aRouter);
```

- [ ] **Step 3: Run all tests**

Run: `cd apps/mcp && npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/src/routes/a2a.ts apps/mcp/src/index.ts
git commit -m "feat(a2a): mount A2A routes — agent card, JSON-RPC, SSE, llms.txt"
```

---

### Task 14: Background Polling for HITL Decisions

**Files:**
- Modify: `apps/mcp/src/index.ts`

- [ ] **Step 1: Add background polling interval**

In `apps/mcp/src/index.ts`, after server starts listening, set up a `setInterval` that runs every 30 seconds:
1. Query `a2a_tasks` where `state = 'auth_required'`
2. For each, query `a2a_approvals` for the matching `dharahil_request_id`
3. Call DharaHIL `GET /v1/requests/{id}` to check for decision
4. If APPROVED → transition to `submitted`, then execute immediately
5. If REJECTED/EXPIRED → transition to `rejected`
6. Check `expires_at` — if past, auto-reject
7. Log audit events for each decision

Also add a webhook retry processor to the same interval:
1. Query `a2a_webhook_deliveries` where `status = 'pending'` and `next_retry_at <= NOW()` and `attempts < 5`
2. Re-attempt delivery via `deliverWebhook()`
3. On success: update `status = 'delivered'`
4. On failure: increment `attempts`, set `next_retry_at` based on exponential backoff `[1s, 5s, 15s, 1min, 5min]`
5. If `attempts >= 5`: update `status = 'failed'`

Also add a cleanup interval (every 24 hours):
1. Delete `a2a_tasks` + `a2a_task_history` older than 90 days in terminal state
2. Delete `a2a_audit_logs` older than 90 days
3. Delete `a2a_webhook_deliveries` older than 30 days
4. Delete `a2a_approvals` older than 90 days

- [ ] **Step 2: Run all tests**

Run: `cd apps/mcp && npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/src/index.ts
git commit -m "feat(a2a): add background HITL polling and data retention cleanup"
```

---

### Task 15: Docker Rebuild and End-to-End Smoke Test

**Files:**
- No new files — testing existing build

- [ ] **Step 1: Rebuild MCP container**

Run: `cd /mnt/projects/TaskPilot && docker compose -f docker-compose-local.yml build mcp`
Expected: Build succeeds (TypeScript compiles cleanly)

- [ ] **Step 2: Restart MCP service**

Run: `docker compose -f docker-compose-local.yml up -d mcp`
Expected: Container starts, logs show `[mcp] TaskPilot MCP Server listening on port 4650`

- [ ] **Step 3: Verify agent card discovery**

Run: `curl -s http://localhost:4650/.well-known/agent-card.json | jq .name`
Expected: `"TaskPilot"`

Run: `curl -s http://localhost:4650/.well-known/agent-card.json | jq '.skills | length'`
Expected: `18`

- [ ] **Step 4: Verify A2A initialize (no auth)**

```bash
curl -s -X POST http://localhost:4650/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | jq .
```

Expected: Returns capabilities with `protocolVersion: "0.3"`, skills list, streaming/webhooks/HITL capabilities.

- [ ] **Step 5: Verify llms.txt**

Run: `curl -s http://localhost:4650/a2a/llms.txt | head -5`
Expected: Plain text starting with "TaskPilot A2A Protocol"

- [ ] **Step 6: Verify A2A message.send with auth** (reuse existing JWT from previous testing)

Create a valid JWT token (same process as previous MCP testing), then:

```bash
curl -s -X POST http://localhost:4650/a2a \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"message.send","params":{"contextId":"test-ctx","skill":"project.list","input":{}}}' | jq .
```

Expected: Returns task with `state: "completed"` and result containing project list.

- [ ] **Step 7: Verify task.get**

```bash
curl -s -X POST http://localhost:4650/a2a \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":3,"method":"task.get","params":{"taskId":"<taskId-from-step-6>"}}' | jq .
```

Expected: Returns task with full details including state, result, timestamps.

- [ ] **Step 8: Verify existing MCP tools still work**

```bash
curl -s -X POST http://localhost:4650/mcp-server \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
```

Expected: `18` (all existing MCP tools unchanged)

- [ ] **Step 9: Verify rate limit headers present**

```bash
curl -s -D - -X POST http://localhost:4650/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' 2>&1 | grep -i ratelimit
```

Expected: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers present.

- [ ] **Step 10: Commit any fixes**

If any issues found during smoke testing, fix and commit.

---

### Task 16: Run Full Test Suite

- [ ] **Step 1: Run all unit tests**

Run: `cd apps/mcp && npx vitest run`
Expected: All tests pass (existing 12 + new ~50 A2A tests)

- [ ] **Step 2: Verify test count**

Expected minimum test files:
- `src/tools/__tests__/handlers.test.ts` (existing)
- `src/a2a/__tests__/types.test.ts`
- `src/a2a/__tests__/skill-registry.test.ts`
- `src/a2a/__tests__/audit-log.test.ts`
- `src/a2a/__tests__/rate-limit.test.ts`
- `src/a2a/__tests__/dharahil.test.ts`
- `src/a2a/__tests__/mcp-hitl.test.ts`
- `src/a2a/__tests__/webhooks.test.ts`
- `src/a2a/__tests__/task-executor.test.ts`
- `src/a2a/__tests__/auth.test.ts`
- `src/a2a/__tests__/agent-card.test.ts`
- `src/a2a/__tests__/sse.test.ts`
- `src/a2a/__tests__/protocol-handler.test.ts`

- [ ] **Step 3: Final commit**

```bash
git commit --allow-empty -m "chore(a2a): all A2A protocol implementation complete and tested"
```
