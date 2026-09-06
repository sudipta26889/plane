# Agent Surface Audit — TaskPilot MCP/A2A

**Date:** 2026-09-07
**Scope:** every path in this repository that reaches an LLM.
**Method:** verification by execution. Each finding below is marked VERIFIED (a
call was made, or a test was watched fail then pass) or INFERRED (read only).
Nothing read-only is presented as proven.

---

## Phase 1 — Inventory

| Path | Entry point | Agentic or single call? | Tools | Memory | Auth/identity |
|---|---|---|---|---|---|
| A2A JSON-RPC | `POST /a2a` → `routes/a2a.ts:33` | **Single call.** One message maps to exactly one skill; no loop, no tool-choice iteration | 30 skills via `skill-registry.ts` | none | OAuth JWT, workspace-pinned |
| A2A free-text adapter | `a2a/intent.ts:90` | Single LLM call that *selects* a skill | picks 1 of 30 | none | inherits the A2A token |
| Project router | `routing/router.ts:249` | Single LLM call | none (it is given evidence) | Qdrant index as evidence | inherits the caller |
| MCP tools | `POST /mcp-server` → `routes/mcp.ts:146` | **Not agentic** — the *client* is the agent | same 30 tools | client-side | OAuth JWT |
| DharaHIL revise | `a2a/dharahil.ts:138` | Single LLM call | none | none | internal |
| Django AI assistant | `app/views/external/base.py:146,182` | Single LLM call | none | none | Django session/API key |

### 1.1 Which paths have an agent at all?

**VERIFIED: none of them.** There is no agentic loop anywhere in this repository.
Every path is a single provider call. `grep` for agent frameworks across both
`package.json` and the Python requirements returns nothing — no CrewAI,
LangChain, LangGraph, AutoGen or equivalent. The five LLM call sites are all
direct `openai` SDK `chat.completions.create` calls.

This is a defensible design for this system, but it has one hard consequence,
which is finding 1.3 below.

### 1.2 Agent framework and tool base class

**Not applicable, VERIFIED.** With no framework there is no `BaseTool` and no
`tools` field to fail Pydantic validation, so the "tool built on the wrong base
class kills the whole agent" failure mode cannot occur here. The analogous
check — does the advertised skill list match what can actually be dispatched —
is 1.3.

### 1.3 Does the manifest advertise what the message path cannot reach?

**VERIFIED — YES. 7 of 30 advertised skills are unreachable from a plain-text
message**, which is the only shape an A2A peer can send.

Ran all 30 skills through the real `resolveIntent` with a realistic user
message each, and validated the produced input against each tool's
`inputSchema.required`:

```
reachable=23  wrong-skill=0  missing-required-params=0  refused=7  of 30
```

Unreachable: `task.assign`, `task.unassign`, `cycle.assign`, `page.get`,
`page.update`, `page.archive`, `intake.triage`.

Root cause, verified by inspecting the model's raw replies: the model picks the
**correct** skill but returns confidence 0.2–0.4 because the required field is a
UUID or a user id it cannot know from text, and the 0.7 threshold then refuses.

```
"open the page about Siddhartha"  -> page.list    conf=0.40
"assign SUDIPTASCF-334 to Sudipta" -> task.assign  conf=0.30
"accept the first intake item"     -> intake.triage conf=0.20
```

The behaviour is right — it refuses rather than hallucinating a UUID. The
*capability* is advertised and undeliverable. Because there is no agentic loop,
a peer cannot do the lookup-then-act sequence that would supply the id.

### 1.4 What does an external peer get that the owner gets?

**Before this audit: no difference at all** beyond workspace scope. Both reached
the same 30 skills with the same gates. That was a finding, and it is fixed —
see Phase 4.

---

## Phase 2 — Verified by execution

### 2.1 Real end-to-end call per surface

**VERIFIED.** A2A `SendMessage` with `"how many projects are there?"` →
resolved to `project.list` → returned 8 real projects, `state: completed`,
**1.26s wall clock**. A tool was used; the answer was not from the prompt.

### 2.2 Agent constructs with its tools

**Not applicable** (no framework — 1.2). The equivalent risk is covered by 1.3,
which found a real gap.

### 2.3 Config-gated behaviour — absence proves nothing

**VERIFIED, and this caught a false negative of my own.** I first concluded a
destructive write had bypassed approval because the container logs showed
nothing — then realised I had rebuilt that container afterwards, wiping its
logs. Absence there proved nothing.

The persistent check found the real issue: `runApprovalLoop` (the MCP path)
writes no `a2a_approvals` row, and `logAuditEvent` is called from eleven places
**all on the A2A path** — `routes/mcp.ts` and `executeToolCall` had **zero**.

### 2.4 Does the confidence/refusal trigger actually fire?

**VERIFIED both directions.** Real short answers are accepted, non-answers
refused:

- accepted: `"what projects do I have?"` → `project.list`;
  `"find anything about GST filings"` → `task.find`; 23 of 30 skills resolved
  from short natural messages
- refused: `"hey, how is it going?"` → best guess 0.2, declined, nothing written

It does not over-refuse short *real* commands, which was the specific failure
mode to rule out.

### 2.5 Is failure distinguishable from an empty result?

**VERIFIED — mostly good, one deliberate fail-soft.**

- TaskPilot API with a bad key: **throws** `TaskPilot API error 403: Given API
  token is not valid`. A permission denial is *not* silently converted into an
  empty result.
- `findDuplicate` returns `null` on any failure — indistinguishable to the
  caller from "no duplicate found". It **does** log
  (`[dedupe] Skipped duplicate check: fetch failed`, verified by pointing the
  embedder at a dead port), so it meets the "visible in logs at minimum" bar.
  The blast radius is a missed duplicate, which creates an item — the status quo.

### 2.6 Timeout budget vs one real call

**VERIFIED — the budget was absurdly too large, the inverse of the usual bug.**

Both LLM call sites passed no timeout, so they used the SDK defaults:
`timeout=600000ms, maxRetries=2` — **up to 30 minutes for one call**. The A2A
task executor records `duration_ms` but enforces no budget. Meanwhile the
calling peer's client times out at 120s.

A hung LLM therefore held a connection long past anyone listening, then
completed work nobody received. Measured cost of a real call: **1.3–1.7s**.

### 2.7 Blocking calls on the event loop

**VERIFIED — measured, and NOT a problem.** `pbkdf2Sync` with 100,000
iterations appears at `smart-router.ts:23` and `dharahil.ts:119`. Measured:
**8.6ms per call**, and the smart-router one sits behind a 5-minute cache.
Reported here because it was worth measuring, not because it needs fixing.

---

## Phase 3 — Gap list

### Memory

- **VERIFIED: there is no durable memory on any path.** No memory module exists
  in `apps/mcp/src`. The Qdrant index holds work items and is used as *routing
  evidence*, not as recall. `context.get` returns tasks sharing a `contextId`,
  which is the closest thing.
- Since no path is agentic, memory could only ever be injected into the prompt,
  never fetched by a model deciding it needs it.
- There is exactly **one** recall path (the vector search), used by the router
  and dedupe, so the "copy-pasted retrieve-and-label logic drifts" risk does not
  apply.

### Tools

- **Can the agent reach its own primary datastore?** Yes for work items — 30
  skills over the REST API.
- **VERIFIED GAP: pages are not in the vector index.** Point counts by
  `entity_type`: `work_item = 440`, `page = 0`. So there is no semantic search
  over the 4,807 pages; `page.list` offers name/cursor paging only. A question
  like "find the page about X" has no cross-corpus equivalent of `find_tasks`.

### Write safety

- 16 write tools. **Before this audit only 4 were gated** and an external peer
  reached all 16 exactly as the owner did.
- Fixed in Phase 4.

### Tenancy

- **VERIFIED clean.** Points with an empty `project_id`: **0**, with a positive
  control confirming the filter matches (337 points for SUDIPTASCF, exactly the
  DB count for that project). The vector-store blackout failure mode — adding an
  owner filter while existing points predate the key — does not apply here.
- Both vector searches scope on `project_id` drawn from the caller's own
  project list; neither filters `workspace_id` against a slug.

### Stale knowledge

- **The store cannot express "this was true until March."** Work items carry a
  state (`completed`, `cancelled`) and the index carries `state_group`, which is
  a coarse form of "no longer live", but there is no validity interval.
- A human *can* say "that changed" by editing the work item: the content hash
  covers the payload fields, so a state or project change re-syncs.
- No contradiction detection exists, so the string-similarity trap does not
  apply.
- Superseded points are **deleted** from the index (deletion reconciliation),
  which answers "what is true now" and discards "what did we believe then" —
  acceptable because Postgres soft-deletes and retains the history.

---

## Phase 4 — What was changed

Deployed and verified live.

1. **One audited approval policy for every write path.** `requiresHumanApproval`
   in `skill-registry.ts` is the single decision, used by both `executeToolCall`
   (MCP) and `protocol-handler` (A2A): destructive actions always need a human,
   and an **external peer needs one for any write**. The owner's routine writes
   stay ungated deliberately — a prompt per created task trains reflexive
   approval, which is worse than no gate.
2. **The write set is derived from the registry**, not hand-listed. Both listed
   the same 16 tools, but a hand-kept set is how a new tool ships ungated. A
   test asserts the derived set matches the declared scopes in both directions.
3. **The MCP path is audited.** `tool.executed`, `tool.failed`, and the approval
   outcome are all recorded; previously it wrote nothing.
4. **LLM calls bounded to 30s** with one retry, ~20× the measured cost and well
   inside the peer's 120s budget.

**Verified by execution:** with DharaHIL pointed at a dead host, a peer's
`add_label` is gated and fails closed ("The action was NOT executed"), while the
owner's identical call goes straight through to the handler. Positive and
negative control both present.

## Still open

1. **7 of 30 skills unreachable from plain text** (1.3). Needs a resolution
   step: accept human-readable references (page *name*, member *name*, intake
   position) and resolve them to ids server-side, since there is no agentic loop
   to do the lookup.
2. **No semantic search over pages** — 4,807 pages are name-searchable only.
3. **No durable memory** on any path.
4. **No validity intervals** — the store cannot say when a fact stopped being
   true.

---

## Phase 5 — After the ReAct agent (same day)

The audit's headline finding was that no path was agentic: one message mapped to
exactly one tool call, which is why 7 of 30 advertised skills were unreachable.
A bounded ReAct loop over native tool calling now exists. Re-measured:

**Chaining — VERIFIED live.** *"find the page called Siddhartha in PKM Notes and
summarise what it contains"* — refused outright before — now returns
`toolsUsed: ['page_list', 'list_projects', 'page_get']` and a summary. The
agent discovered a page UUID at runtime and used it, which is precisely what
plain text could not supply.

**Reachability — 7/7 recovered.** Every skill the audit proved unreachable now
plans a correct first step: `list_members` for assign/unassign, `list_cycles`
for the sprint, `page_list` for the page operations, `intake_list` for triage.

**Conversation memory — VERIFIED.** A second turn reading only *"which of them
has the most pages?"* resolved the pronoun against the previous turn's answer.

**Durable memory — now a real service.** The local facts table was replaced by
longmemory-hydrograph over MCP, which models supersession and contradiction —
closing the "cannot express that a fact stopped being true" gap this audit
opened. There is no local fallback, deliberately: `/health` probes it, so an
outage is visible rather than looking like an empty memory.

**A defect the loop introduced, found by running it.** Asked for a page outside
its workspace, the agent called `page_list` six times with identical arguments
and spent the whole iteration budget. The bound stopped it honestly, but the
budget was gone. The loop now refuses an identical repeat and tells the model
why. Fixed and covered by tests.

### Still open after Phase 5

1. **Page counting is wrong at scale.** `page_list` caps at 50 per project, so
   the agent answered "dozens of pages" for a project holding 3,394. It can
   find pages; it cannot count them.
2. **No semantic search over pages** — the index holds work items only
   (`work_item = 440`, `page = 0`).
3. **Revise-after-approval is refused** for agent runs rather than applied;
   rewriting approved arguments inside a saved transcript is unbuilt.
