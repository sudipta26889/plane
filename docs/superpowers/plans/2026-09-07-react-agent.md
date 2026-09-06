# ReAct Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the A2A surface from one-tool-call-per-message into a real ReAct agent — it chains tool calls, remembers the conversation, keeps durable facts, and still cannot write without the approval gate.

**Architecture:** A bounded reason–act loop over native OpenAI tool calling. The model is handed all 30 skills as function definitions built from the schemas they already declare; it calls one or more, sees the results, and continues until it answers or hits a bound. Reads run freely. The first write needing approval **suspends** the run — the whole message array is persisted on the task, the task goes to `auth_required`, and the existing background poller resumes the loop from exactly that point once a human approves.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), `openai` SDK (already a dependency), `pg`, vitest. No new dependencies.

**Verified before planning:** the configured model (`gpt-oss-120b` via LiteLLM) returns `finish_reason: "tool_calls"` with a correct `find_tasks` call for a two-step request, in 0.7s. Native tool calling works; this plan does not need a text-parsed ReAct fallback.

## Global Constraints

- Node ESM: every relative import ends in `.js`, even from `.ts` source.
- No new npm dependencies.
- Tests must not make network calls. Stub `fetch`/the LLM, or test pure functions.
- Run tests from `apps/mcp` with `npx vitest run`; verify hermeticity with `env -i PATH="$PATH" HOME="$HOME" npx vitest run`.
- Do not modify `vitest.setup.ts` or `vitest.config.ts`.
- **The approval policy is not optional and must not be bypassed.** `requiresHumanApproval(mcpTool, args, clientId)` in `skill-registry.ts` is the single decision: destructive actions always, and ANY write by an external peer (`peer_` client id). The loop calls `executeToolCall`, which enforces it — never call a handler directly.
- Every write is audited. `executeToolCall` already does this; do not add a path that skips it.
- The vector index and every tool are workspace-scoped by the caller's own project list. The loop introduces no new data access.
- Bounds are mandatory: a loop with no iteration cap and no wall clock is a way to spend money and hold a connection forever.

## Measured facts this plan rests on

| Fact | Value |
|---|---|
| Tool-calling support | `finish_reason: tool_calls`, correct args, **0.7s** |
| One LLM call (routing/intent) | 1.3–2.0s |
| Calling peer's client timeout | 120s (`a2a-client.ts` in the inbox project) |
| Current LLM call budget | 30s, 1 retry |
| Skills available | 30, each with a JSON `inputSchema` |

A loop of 8 iterations at ~1s each plus tool execution fits inside the peer's 120s. The wall clock below is 90s so the agent gives up before the caller does.

---

### Task 1: Tool definitions from the registry

**Files:**
- Create: `apps/mcp/src/agent/tools.ts`
- Test: `apps/mcp/src/agent/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: `getAllSkills`, `getSkillDefinition` from `../a2a/skill-registry.js`; `getToolDefinitions` from `../tools/handlers.js`.
- Produces: `buildToolDefinitions(scopes: string[]): OpenAI.Chat.ChatCompletionTool[]`, `resolveToolName(fnName: string): SkillDefinition | undefined`.

The model must not be offered tools the caller's token cannot use — a write tool offered to a read-only token wastes an iteration and produces a scope error the model then has to reason about.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildToolDefinitions, resolveToolName } from "../tools.js";
import { getAllSkills } from "../../a2a/skill-registry.js";

describe("buildToolDefinitions", () => {
  it("offers every skill to a read+write caller", () => {
    const tools = buildToolDefinitions(["taskpilot:read", "taskpilot:write"]);
    expect(tools.length).toBe(getAllSkills().length);
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.parameters).toBeDefined();
    }
  });

  it("hides write tools from a read-only caller", () => {
    const tools = buildToolDefinitions(["taskpilot:read"]);
    const names = tools.map((t) => t.function.name);
    const writes = getAllSkills().filter((s) => s.scope === "taskpilot:write");
    for (const skill of writes) {
      expect(names, `${skill.mcpTool} must not be offered`).not.toContain(skill.mcpTool);
    }
    expect(tools.length).toBeGreaterThan(0);
  });

  it("uses the MCP tool name so results map straight back to a handler", () => {
    const tools = buildToolDefinitions(["taskpilot:read"]);
    const first = tools[0]!.function.name;
    expect(resolveToolName(first)?.mcpTool).toBe(first);
  });

  it("returns undefined for a name the model invented", () => {
    expect(resolveToolName("definitely_not_a_tool")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run src/agent/__tests__/tools.test.ts`, cannot resolve `../tools.js`.

- [ ] **Step 3: Implement**

Map each registry skill to its MCP tool definition (which already carries `description` and `inputSchema`) into OpenAI's function shape, filtered by scope. `resolveToolName` looks the skill up by `mcpTool`.

- [ ] **Step 4: Green, then commit** — `git commit -m "feat(agent): build tool definitions from the skill registry"`

---

### Task 2: Conversation and durable memory

**Files:**
- Create: `apps/mcp/src/agent/memory.ts`
- Modify: `apps/mcp/src/db.ts` (two tables in `initA2aDatabase`)
- Test: `apps/mcp/src/agent/__tests__/memory.test.ts`

**Interfaces:**
- Produces: `recordTurn(contextId, message)`, `loadConversation(contextId, limit)`, `rememberFact(userId, workspace, fact, source)`, `recallFacts(userId, workspace, limit)`, `formatMemoryForPrompt(facts)`.

Two tables, following the existing `CREATE TABLE IF NOT EXISTS` pattern:

```sql
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
CREATE INDEX IF NOT EXISTS idx_a2a_conversations_context ON a2a_conversations(context_id, created_at);

CREATE TABLE IF NOT EXISTS a2a_memory (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  workspace_slug VARCHAR(255) NOT NULL,
  fact TEXT NOT NULL,
  source VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  superseded_at TIMESTAMPTZ,
  superseded_by INT
);
CREATE INDEX IF NOT EXISTS idx_a2a_memory_owner ON a2a_memory(user_id, workspace_slug, superseded_at);
```

`superseded_at` rather than deletion: the audit found the store could say when a fact was written but never when it stopped being true. Invalidating keeps "what did we believe then" answerable.

**Facts are injected into the system prompt, not fetched by a tool.** A tool only fires when the model decides it needs one, and memory matters most when nothing in the question advertises that the answer is remembered.

- [ ] **Step 1: Write the failing test** — cover `formatMemoryForPrompt` (pure): renders facts as lines, returns an empty string for none, and truncates a long set to a bounded size.
- [ ] **Step 2: Watch it fail.**
- [ ] **Step 3: Implement**, including the tables.
- [ ] **Step 4: Green, then commit.**

---

### Task 3: Loop state, so a run can suspend and resume

**Files:**
- Create: `apps/mcp/src/agent/state.ts`
- Modify: `apps/mcp/src/db.ts` (one table)
- Test: `apps/mcp/src/agent/__tests__/state.test.ts`

**Interfaces:**
- Produces: `saveRunState(taskId, state)`, `loadRunState(taskId)`, `clearRunState(taskId)`, and the type `AgentRunState = { messages: any[]; iteration: number; pendingToolCall: { id: string; name: string; args: Record<string, any> } | null }`.

```sql
CREATE TABLE IF NOT EXISTS a2a_agent_runs (
  task_id VARCHAR(255) PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

The whole message array is persisted because resuming needs the model's own reasoning so far — replaying only the user's text would lose the tool results the pending write was based on.

- [ ] Steps 1–4 as above. Test the round trip and that `loadRunState` on an unknown task returns null rather than throwing.

---

### Task 4: The loop

**Files:**
- Create: `apps/mcp/src/agent/loop.ts`
- Test: `apps/mcp/src/agent/__tests__/loop.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, `executeToolCall` from `../tools/handlers.js`, `requiresHumanApproval` from `../a2a/skill-registry.js`, `getLlmConfig`.
- Produces: `runAgent(input: { text: string; contextId: string; auth: AuthContext; taskId: string; resumeFrom?: AgentRunState }): Promise<AgentResult>` where `AgentResult = { status: "completed"; answer: string; toolsUsed: string[] } | { status: "needs_approval"; toolCall: {...} } | { status: "failed"; error: string }`.

```typescript
const MAX_ITERATIONS = 8;
const WALL_CLOCK_MS = 90_000;
```

Both bounds are required. Eight iterations at ~1s of model time plus tool execution sits inside the caller's 120s, and the wall clock makes the agent give up before the caller does rather than finishing work nobody is listening for.

The loop:
1. Build messages: system prompt + injected memory + prior conversation + the user's text (or `resumeFrom.messages`).
2. Call the model with the scope-filtered tools.
3. `finish_reason === "stop"` → return the answer.
4. For each tool call: if `requiresHumanApproval(name, args, auth.clientId)` and it has not already been approved, persist state and return `needs_approval`. Otherwise `executeToolCall`, append the result as a `tool` message, and continue.
5. Hitting either bound returns what it has with an explicit note that it stopped early — never silently truncate.

- [ ] **Step 1: Write the failing tests.** These are the important ones and must not touch the network — stub the LLM client. Cover:
  - a single tool call then a final answer → `completed`, `toolsUsed` names the tool
  - two chained calls (find → comment) → both execute in order, second sees the first's result
  - a write needing approval → returns `needs_approval` **without executing it**, and the persisted state contains the pending call
  - `MAX_ITERATIONS` reached → returns with the stopped-early note, does not loop forever
  - a tool the model invented → fed back as an error message the model can recover from, not a crash
- [ ] **Step 2: Watch them fail. Step 3: Implement. Step 4: Green, commit.**

---

### Task 5: Wire the loop into message.send, keeping the old path as fallback

**Files:**
- Modify: `apps/mcp/src/a2a/protocol-handler.ts`
- Test: extend `apps/mcp/src/a2a/__tests__/protocol-handler.test.ts`

An explicit `skill` in the params still dispatches directly — that path is exact and callers depend on it. Free text now goes to the agent loop rather than the single-shot intent adapter. If the loop fails, fall back to `resolveIntent` so behaviour never regresses to worse than today.

- [ ] Steps 1–4. Test that explicit-skill params still bypass the loop entirely.

---

### Task 6: Resume after approval

**Files:**
- Modify: `apps/mcp/src/a2a/background.ts`
- Modify: `apps/mcp/src/a2a/task-executor.ts`
- Test: extend the background tests

When the poller sees an approval for a task with saved run state, it reloads the state and calls `runAgent` with `resumeFrom`, marking the pending tool call approved so it executes rather than suspending again. On rejection, clear the state and fail the task with the human's reason.

- [ ] Steps 1–4. Test that a resumed run does not re-request approval for the same call — the double-prompt bug this codebase already fixed once.

---

### Task 7: Verify against the live instance

**Files:** none — verification.

Every plan in this project has had a defect that only a live run exposed.

- [ ] **Step 1:** the two-step read that fails today — *"open the page about Siddhartha and tell me what it says"* — must now chain `page.list` → `page.get` and answer. Record the tool sequence.
- [ ] **Step 2:** *"find the ITR-3 task and add a comment saying it is done"* as a peer must suspend for approval with the comment **not** written, and complete correctly after approval.
- [ ] **Step 3:** conversation memory — ask a follow-up ("what about the other one?") in the same `contextId` and confirm it resolves against the prior turn.
- [ ] **Step 4:** re-run the skill-reachability sweep from the audit. The 7 previously unreachable skills should now be reachable via chaining. Record the new number.
- [ ] **Step 5:** confirm a read-only token is never offered a write tool.

## Definition of done

- `npx tsc --noEmit` clean; `env -i … npx vitest run` green.
- The two-step requests in Task 7 work end to end.
- A peer's mid-chain write still suspends for approval and is audited.
- Reachability improves measurably from 23/30, recorded honestly whatever it is.
