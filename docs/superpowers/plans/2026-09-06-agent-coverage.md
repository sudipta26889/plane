# Agent Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the TaskPilot agent the four surfaces it cannot touch today — pages, intake triage, work-item relations, and call notes — so it can organise what already exists instead of only creating work items.

**Architecture:** Each surface follows the pattern already established: a method on `TaskPilotClient` against the public REST API v1, a handler in `handlers.ts`, a skill in `skill-registry.ts` mapping the A2A skill name onto that handler, and a tool definition so MCP clients see it too. No new modules and no new dependencies — the grounded-routing work from the first plan supplies the intelligence these skills call into.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express, `pg`, vitest.

**Depends on:** [2026-09-06-grounded-routing.md](2026-09-06-grounded-routing.md), complete. `routeWorkItem`, `findDuplicate` and the Qdrant index are in place and used here.

**Spec:** [2026-09-06-taskpilot-agent-grounding-design.md](../specs/2026-09-06-taskpilot-agent-grounding-design.md), "New skills".

## Global Constraints

- Node ESM: every relative import ends in `.js`, even from `.ts` source.
- No new npm dependencies.
- Tests must not make network calls. Stub `fetch` with `vi.stubGlobal`, or test pure functions directly.
- Run tests from `apps/mcp` with `npx vitest run`. Verify hermeticity with `env -i PATH="$PATH" HOME="$HOME" npx vitest run`.
- Do not modify `vitest.setup.ts` or `vitest.config.ts`.
- Every new skill must declare its scope (`taskpilot:read` or `taskpilot:write`) and its approval flag in `skill-registry.ts`. A write skill that skips the scope check is a security defect.
- `taskpilot_vector_db` is ONE Qdrant collection shared by all 5 workspaces. Any vector search must be scoped by `project_id` to the caller's own projects, exactly as `routeWorkItem` does. Never filter on `workspace_id` against a workspace slug — the payload stores a UUID.
- There is no delete for work items. Removal means cancelling, which requires approval.
- Running scripts from the host needs `TASKPILOT_API_URL=http://localhost:4647`; the default `http://api:4647` is docker-internal.

## API contracts (verified against the source, not assumed)

| Surface | Endpoint | Shape |
|---|---|---|
| Pages list/create | `/api/v1/workspaces/{slug}/projects/{project_id}/pages/` | `PageSerializer`: `name`, `access`, `color`, `parent`, `labels`, `is_locked`, `external_id`, `external_source` |
| Page detail | `…/pages/{pk}/` | adds `description_html`, `description_json` |
| Page description | `…/pages/{pk}/description/` | PATCH |
| Page archive | `…/pages/{pk}/archive/` | POST archives, DELETE unarchives |
| Page versions | `…/pages/{pk}/versions/` | GET |
| Intake list/create | `…/projects/{project_id}/intake-issues/` | POST body `{ "issue": { name, description_html?, priority? } }` |
| Intake detail | `…/intake-issues/{issue_id}/` | GET, PATCH (triage), DELETE |
| Relations | `…/work-items/{issue_id}/relations/` | GET; POST `{ relation_type, issues: [uuid] }` |
| Call notes | `…/workspaces/{slug}/call-notes/upsert/`, `/lookup/`, `/history/` | workspace-scoped, no project segment |

`relation_type` is one of exactly: `blocking`, `blocked_by`, `duplicate`, `relates_to`, `start_before`, `start_after`, `finish_before`, `finish_after`.

---

### Task 1: Page client methods and read skills

**Files:**
- Modify: `apps/mcp/src/tools/taskpilot-client.ts`
- Modify: `apps/mcp/src/tools/handlers.ts`
- Modify: `apps/mcp/src/a2a/skill-registry.ts`
- Test: `apps/mcp/src/tools/__tests__/handlers.test.ts`

**Interfaces:**
- Consumes: `TaskPilotClient.request` (private helper already in the class).
- Produces on `TaskPilotClient`: `listPages(projectId, params?)`, `getPage(projectId, pageId)`, `createPage(projectId, data)`, `updatePageDescription(projectId, pageId, descriptionHtml)`, `archivePage(projectId, pageId)`, `listPageVersions(projectId, pageId)`.
- Produces handlers: `handleListPages`, `handleGetPage` registered as skills `page.list` (`taskpilot:read`) and `page.get` (`taskpilot:read`).

- [ ] **Step 1: Write the failing test**

Append to `apps/mcp/src/tools/__tests__/handlers.test.ts`:

```typescript
import { formatPageSummary } from "../handlers.js";

describe("formatPageSummary", () => {
  it("returns the fields an agent needs to act on a page", () => {
    const summary = formatPageSummary({
      id: "p1",
      name: "Q3 planning",
      external_source: "meetecho",
      external_id: "abc",
      is_locked: false,
      archived_at: null,
      updated_at: "2026-09-01T00:00:00Z",
    });
    expect(summary).toEqual({
      id: "p1",
      name: "Q3 planning",
      source: "meetecho",
      locked: false,
      archived: false,
      updated_at: "2026-09-01T00:00:00Z",
    });
  });

  it("marks an archived page as archived", () => {
    // archived_at is a date, not a boolean — a truthy check is the contract.
    const summary = formatPageSummary({ id: "p2", name: "Old", archived_at: "2026-08-01" });
    expect(summary.archived).toBe(true);
  });

  it("reports a page with no external source as locally authored", () => {
    const summary = formatPageSummary({ id: "p3", name: "Notes" });
    expect(summary.source).toBe("local");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/tools/__tests__/handlers.test.ts`
Expected: FAIL — `formatPageSummary` is not exported from `../handlers.js`.

- [ ] **Step 3: Add the client methods**

In `apps/mcp/src/tools/taskpilot-client.ts`, after the Labels section:

```typescript
  // --- Pages ---
  async listPages(projectId: string, params?: Record<string, string>): Promise<any[]> {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    const data = await this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${qs}`,
    );
    return Array.isArray(data) ? data : data.results || data;
  }

  async getPage(projectId: string, pageId: string): Promise<any> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${pageId}/`,
    );
  }

  async createPage(projectId: string, data: Record<string, unknown>): Promise<any> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/`,
      data,
    );
  }

  /** Description lives behind its own endpoint, not the page PATCH. */
  async updatePageDescription(
    projectId: string,
    pageId: string,
    descriptionHtml: string,
  ): Promise<any> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${pageId}/description/`,
      { description_html: descriptionHtml },
    );
  }

  async archivePage(projectId: string, pageId: string): Promise<any> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${pageId}/archive/`,
    );
  }

  async listPageVersions(projectId: string, pageId: string): Promise<any[]> {
    const data = await this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/pages/${pageId}/versions/`,
    );
    return Array.isArray(data) ? data : data.results || data;
  }
```

- [ ] **Step 4: Add the formatter and read handlers**

In `apps/mcp/src/tools/handlers.ts`, near the other helpers at the top:

```typescript
/** Trim a page to what an agent needs: identity, provenance, and whether it can be edited. */
export function formatPageSummary(page: any) {
  return {
    id: page.id,
    name: page.name || "",
    // MeetEcho writes most pages; a locally authored one has no external source.
    source: page.external_source || "local",
    locked: Boolean(page.is_locked),
    archived: Boolean(page.archived_at),
    updated_at: page.updated_at,
  };
}
```

And with the other handlers:

```typescript
async function handleListPages(args: any, client: TaskPilotClient, workspace: string) {
  const projects = await client.listProjects();
  const project = args.project_hint
    ? projects.find(
        (p: any) =>
          p.identifier?.toLowerCase() === args.project_hint.toLowerCase() ||
          p.name?.toLowerCase() === args.project_hint.toLowerCase(),
      )
    : null;

  if (args.project_hint && !project) {
    return { error: `No project matching '${args.project_hint}'. Available: ${projects.map((p: any) => p.identifier).join(", ")}` };
  }

  const targets = project ? [project] : projects;
  const pages: any[] = [];
  for (const target of targets) {
    const found = await client.listPages(String(target.id));
    for (const page of found.slice(0, 50)) {
      pages.push({ ...formatPageSummary(page), project: target.identifier });
    }
  }

  return { pages: pages.slice(0, 100), count: pages.length };
}

async function handleGetPage(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.page_id || !args.project_id) {
    return { error: "Both project_id and page_id are required" };
  }
  const page = await client.getPage(args.project_id, args.page_id);
  return {
    ...formatPageSummary(page),
    description_html: page.description_html || "",
  };
}
```

Register both in the `HANDLERS` map: `page_list: handleListPages, page_get: handleGetPage`.

- [ ] **Step 5: Add tool definitions**

Add to the `TOOLS` array in `handlers.ts`:

```typescript
  {
    name: "page_list",
    description: "List pages (documents) in a project, or across all projects. Pages are documents, not tasks.",
    inputSchema: {
      type: "object",
      properties: {
        project_hint: { type: "string", description: "Project name or identifier to limit to (optional)" },
      },
    },
  },
  {
    name: "page_get",
    description: "Get one page including its content.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        page_id: { type: "string", description: "Page UUID" },
      },
      required: ["project_id", "page_id"],
    },
  },
```

- [ ] **Step 6: Register the skills**

In `apps/mcp/src/a2a/skill-registry.ts`, add to `SKILL_REGISTRY`:

```typescript
  "page.list":            { name: "page.list",            mcpTool: "page_list",        scope: "taskpilot:read",  approval: false, description: "List pages (documents) in a project or across projects" },
  "page.get":             { name: "page.get",             mcpTool: "page_get",         scope: "taskpilot:read",  approval: false, description: "Get one page including its content" },
```

- [ ] **Step 7: Run the tests**

Run: `cd apps/mcp && npx tsc --noEmit && env -i PATH="$PATH" HOME="$HOME" npx vitest run`
Expected: tsc exits 0; all tests pass including the 3 new `formatPageSummary` cases.

Note: `agent-card.test.ts` asserts `card.skills.length` is 19. Adding skills changes that count — update the assertion to the new total in the same commit, and do not weaken it to a `toBeGreaterThan`; the exact count is what catches an accidental registry edit.

- [ ] **Step 8: Commit**

```bash
git add apps/mcp/src/tools/ apps/mcp/src/a2a/skill-registry.ts apps/mcp/src/a2a/__tests__/agent-card.test.ts
git commit -m "feat(a2a): add page read skills"
```

---

### Task 2: Page write skills

**Files:**
- Modify: `apps/mcp/src/tools/handlers.ts`
- Modify: `apps/mcp/src/a2a/skill-registry.ts`
- Test: `apps/mcp/src/tools/__tests__/handlers.test.ts`

**Interfaces:**
- Consumes: the client methods from Task 1.
- Produces skills `page.create` (`taskpilot:write`), `page.update` (`taskpilot:write`), `page.archive` (`taskpilot:write`, `approval: true`).

MeetEcho owns most page content, writing through `external_id`/`external_source`. The agent must not silently overwrite a synced page, so `page.update` refuses one that carries an external source unless `force` is passed, and `page.archive` requires approval because archiving removes a page from view.

- [ ] **Step 1: Write the failing test**

Append to `apps/mcp/src/tools/__tests__/handlers.test.ts`:

```typescript
import { canAgentEditPage } from "../handlers.js";

describe("canAgentEditPage", () => {
  it("allows editing a locally authored page", () => {
    expect(canAgentEditPage({ id: "p1" }, false)).toEqual({ allowed: true });
  });

  it("refuses a page owned by an external system", () => {
    // MeetEcho re-syncs these; our edit would be silently overwritten.
    const verdict = canAgentEditPage({ id: "p2", external_source: "meetecho" }, false);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("meetecho");
  });

  it("allows an external page when the caller forces it", () => {
    expect(canAgentEditPage({ id: "p2", external_source: "meetecho" }, true).allowed).toBe(true);
  });

  it("refuses a locked page even when forced", () => {
    // is_locked is an explicit human decision, not a sync artifact.
    expect(canAgentEditPage({ id: "p3", is_locked: true }, true).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mcp && npx vitest run src/tools/__tests__/handlers.test.ts`
Expected: FAIL — `canAgentEditPage` is not exported.

- [ ] **Step 3: Implement**

In `handlers.ts`:

```typescript
/**
 * Whether the agent may write to a page. Two different refusals: a locked page
 * is an explicit human decision and is never overridable, while an
 * externally-synced page is refusable-but-forceable, since the owning system
 * would overwrite our edit on its next sync.
 */
export function canAgentEditPage(page: any, force: boolean): { allowed: boolean; reason?: string } {
  if (page.is_locked) {
    return { allowed: false, reason: "Page is locked. Unlock it in TaskPilot first." };
  }
  if (page.external_source && !force) {
    return {
      allowed: false,
      reason: `Page is synced from ${page.external_source} and edits would be overwritten on its next sync. Pass force: true to edit anyway.`,
    };
  }
  return { allowed: true };
}

async function handleCreatePage(args: any, client: TaskPilotClient, workspace: string) {
  if (!args.title) return { error: "title is required" };

  const decision = await routeWorkItem(
    { workspace, title: args.title, description: args.content, projectHint: args.project_hint },
    client,
  );

  if (!decision.projectId) {
    return {
      status: "undecided",
      reason: decision.reason,
      candidates: decision.candidates.map((c) => c.identifier),
      hint: "Pass project_hint to say where this page belongs.",
    };
  }

  const project = decision.candidates.find((c) => c.id === decision.projectId);
  const page = await client.createPage(decision.projectId, {
    name: args.title,
    ...(args.content ? { description_html: `<p>${args.content}</p>` } : {}),
  });

  return {
    id: page.id,
    name: page.name,
    project: project?.identifier || "",
    routing: { confidence: decision.confidence, reason: decision.reason, source: decision.source },
  };
}

async function handleUpdatePage(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.project_id || !args.page_id || !args.content) {
    return { error: "project_id, page_id and content are required" };
  }

  const page = await client.getPage(args.project_id, args.page_id);
  const verdict = canAgentEditPage(page, Boolean(args.force));
  if (!verdict.allowed) return { error: verdict.reason };

  await client.updatePageDescription(args.project_id, args.page_id, args.content);
  return { id: args.page_id, name: page.name, status: "updated" };
}

async function handleArchivePage(args: any, client: TaskPilotClient, _workspace: string) {
  if (!args.project_id || !args.page_id) {
    return { error: "project_id and page_id are required" };
  }
  await client.archivePage(args.project_id, args.page_id);
  return { id: args.page_id, status: "archived" };
}
```

Register `page_create: handleCreatePage, page_update: handleUpdatePage, page_archive: handleArchivePage` in `HANDLERS`, and add each to `WRITE_TOOLS` so the scope check applies.

- [ ] **Step 4: Add tool definitions and skills**

Tool definitions follow the shape used in Task 1. Skills:

```typescript
  "page.create":          { name: "page.create",          mcpTool: "page_create",      scope: "taskpilot:write", approval: false, description: "Create a page, routed to the right project" },
  "page.update":          { name: "page.update",          mcpTool: "page_update",      scope: "taskpilot:write", approval: false, description: "Replace a page's content. Refuses externally-synced pages unless forced" },
  "page.archive":         { name: "page.archive",         mcpTool: "page_archive",     scope: "taskpilot:write", approval: true,  description: "Archive a page (requires human approval)" },
```

- [ ] **Step 5: Run the tests and commit**

```bash
cd apps/mcp && npx tsc --noEmit && env -i PATH="$PATH" HOME="$HOME" npx vitest run
git add apps/mcp/src/tools/handlers.ts apps/mcp/src/a2a/skill-registry.ts apps/mcp/src/a2a/__tests__/agent-card.test.ts
git commit -m "feat(a2a): add page write skills, refusing externally-synced pages"
```

---

### Task 3: Intake triage skills

**Files:**
- Modify: `apps/mcp/src/tools/taskpilot-client.ts`
- Modify: `apps/mcp/src/tools/handlers.ts`
- Modify: `apps/mcp/src/a2a/skill-registry.ts`
- Test: `apps/mcp/src/tools/__tests__/handlers.test.ts`

**Interfaces:**
- Produces on the client: `listIntakeIssues(projectId)`, `updateIntakeIssue(projectId, issueId, data)`.
- Produces skills `intake.list` (`taskpilot:read`) and `intake.triage` (`taskpilot:write`).

This closes the loop opened by the first plan: uncertain items are filed into Intake, and until now only a human could clear them.

- [ ] **Step 1: Write the failing test**

```typescript
import { intakeStatusName } from "../handlers.js";

describe("intakeStatusName", () => {
  it("maps TaskPilot's numeric intake status to a name", () => {
    expect(intakeStatusName(-2)).toBe("pending");
    expect(intakeStatusName(-1)).toBe("rejected");
    expect(intakeStatusName(0)).toBe("snoozed");
    expect(intakeStatusName(1)).toBe("accepted");
    expect(intakeStatusName(2)).toBe("duplicate");
  });

  it("reports an unknown status rather than guessing", () => {
    expect(intakeStatusName(99)).toBe("unknown(99)");
  });
});
```

- [ ] **Step 2: Verify it fails, then implement**

Run: `cd apps/mcp && npx vitest run src/tools/__tests__/handlers.test.ts` — FAIL, not exported.

**Before writing the mapping, confirm the numbers.** Read the intake status constants in `apps/api/taskpilot/db/models/intake.py` and use what is actually defined there. If they differ from the test above, fix the test to match the source — the source is the contract, and a mapping invented here would mislabel every triaged item.

```typescript
/** TaskPilot stores intake status as a small int; agents need the name. */
export function intakeStatusName(status: number): string {
  switch (status) {
    case -2: return "pending";
    case -1: return "rejected";
    case 0: return "snoozed";
    case 1: return "accepted";
    case 2: return "duplicate";
    default: return `unknown(${status})`;
  }
}
```

Client methods:

```typescript
  // --- Intake ---
  async listIntakeIssues(projectId: string): Promise<any[]> {
    const data = await this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/intake-issues/`,
    );
    return Array.isArray(data) ? data : data.results || data;
  }

  async updateIntakeIssue(projectId: string, issueId: string, data: any): Promise<any> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/intake-issues/${issueId}/`,
      data,
    );
  }
```

Handlers: `handleListIntake` returns each queued item with `intakeStatusName(status)`; `handleTriageIntake` takes `project_id`, `issue_id` and `decision` of `accept` or `reject`, maps it to the numeric status, and PATCHes. Register `intake_list` (read) and `intake_triage` (write, in `WRITE_TOOLS`).

- [ ] **Step 3: Run the tests and commit**

```bash
cd apps/mcp && npx tsc --noEmit && env -i PATH="$PATH" HOME="$HOME" npx vitest run
git add apps/mcp/src/tools/ apps/mcp/src/a2a/skill-registry.ts apps/mcp/src/a2a/__tests__/agent-card.test.ts
git commit -m "feat(a2a): add intake list and triage skills"
```

---

### Task 4: Work-item relations

**Files:**
- Modify: `apps/mcp/src/tools/taskpilot-client.ts`
- Modify: `apps/mcp/src/tools/handlers.ts`
- Modify: `apps/mcp/src/a2a/skill-registry.ts`
- Test: `apps/mcp/src/tools/__tests__/handlers.test.ts`

**Interfaces:**
- Produces on the client: `listRelations(projectId, issueId)`, `createRelation(projectId, issueId, relationType, issueIds)`.
- Produces skills `relation.list` (`taskpilot:read`) and `relation.add` (`taskpilot:write`).

This is what turns duplicate detection into an action: instead of refusing to create, the agent can link the new item to the one it duplicates.

- [ ] **Step 1: Write the failing test**

```typescript
import { RELATION_TYPES, isValidRelationType } from "../handlers.js";

describe("relation types", () => {
  it("accepts every type the API defines", () => {
    for (const type of [
      "blocking", "blocked_by", "duplicate", "relates_to",
      "start_before", "start_after", "finish_before", "finish_after",
    ]) {
      expect(isValidRelationType(type)).toBe(true);
    }
  });

  it("rejects a type the API would refuse", () => {
    // Sending an invalid type would fail server-side with an opaque 400.
    expect(isValidRelationType("duplicates")).toBe(false);
    expect(isValidRelationType("")).toBe(false);
  });

  it("exposes the list so the tool description can enumerate it", () => {
    expect(RELATION_TYPES).toContain("duplicate");
    expect(RELATION_TYPES.length).toBe(8);
  });
});
```

- [ ] **Step 2: Verify it fails, then implement**

```typescript
/** Exactly the values IssueRelationCreateSerializer accepts. */
export const RELATION_TYPES = [
  "blocking", "blocked_by", "duplicate", "relates_to",
  "start_before", "start_after", "finish_before", "finish_after",
] as const;

export function isValidRelationType(type: string): boolean {
  return (RELATION_TYPES as readonly string[]).includes(type);
}
```

Client:

```typescript
  // --- Relations ---
  async listRelations(projectId: string, issueId: string): Promise<any> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/work-items/${issueId}/relations/`,
    );
  }

  async createRelation(
    projectId: string,
    issueId: string,
    relationType: string,
    issueIds: string[],
  ): Promise<any> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace}/projects/${projectId}/work-items/${issueId}/relations/`,
      { relation_type: relationType, issues: issueIds },
    );
  }
```

`handleAddRelation` resolves both work items by identifier via `getIssueByIdentifier`, validates the relation type with `isValidRelationType` and returns the valid list when it fails, then calls `createRelation`.

- [ ] **Step 3: Run the tests and commit**

```bash
cd apps/mcp && npx tsc --noEmit && env -i PATH="$PATH" HOME="$HOME" npx vitest run
git add apps/mcp/src/tools/ apps/mcp/src/a2a/skill-registry.ts apps/mcp/src/a2a/__tests__/agent-card.test.ts
git commit -m "feat(a2a): add work-item relation skills"
```

---

### Task 5: Call notes

**Files:**
- Modify: `apps/mcp/src/tools/taskpilot-client.ts`
- Modify: `apps/mcp/src/tools/handlers.ts`
- Modify: `apps/mcp/src/a2a/skill-registry.ts`
- Test: `apps/mcp/src/tools/__tests__/handlers.test.ts`

**Interfaces:**
- Produces on the client: `lookupCallNote(params)`, `upsertCallNote(data)`, `callNoteHistory(params)`.
- Produces skills `callnote.lookup` (`taskpilot:read`) and `callnote.upsert` (`taskpilot:write`).

Call notes are workspace-scoped, with no project segment in the path.

**Correction, found during implementation:** this plan originally said the upsert
handler should route with `routeWorkItem`. That is wrong against the source. All
three endpoints are POST-only and the upsert body is
`{phone, category, details_html, caller_name?}`, where `category` is exactly one
of `home_automation | export | event | prodevs` — the server maps that enum to a
hardcoded project itself. There is no project field to route to. The agent
supplies the enum from call context instead.

- [ ] **Step 1: Read the endpoint contract first**

The three endpoints are in `apps/api/taskpilot/api/urls/call_note.py` and their views. Read the serializer to learn the exact request body before writing the client methods — this is a fork-specific feature with no upstream documentation, and guessing the shape will produce opaque 400s.

Record the actual field names in your report.

- [ ] **Step 2: Write the failing test, implement, and commit**

Test the pure parts (parameter validation, the shape the handler returns). Follow the pattern of the previous tasks. Do not write a test that asserts a request body you have not verified against the serializer.

```bash
cd apps/mcp && npx tsc --noEmit && env -i PATH="$PATH" HOME="$HOME" npx vitest run
git add apps/mcp/src/tools/ apps/mcp/src/a2a/skill-registry.ts apps/mcp/src/a2a/__tests__/agent-card.test.ts
git commit -m "feat(a2a): add call-note lookup and upsert skills"
```

---

### Task 6: Refresh the agent card, llms.txt and the intent menu

**Files:**
- Modify: `apps/mcp/src/a2a/agent-card.ts` (`buildLlmsTxt`)
- Test: `apps/mcp/src/a2a/__tests__/agent-card.test.ts`

**Interfaces:** consumes the skill registry from Tasks 1–5.

`buildAgentCard` and the intent adapter both read `getAllSkills()`, so they pick up the new skills automatically — but `buildLlmsTxt` groups skills by hardcoded name prefixes (`task.`, `label.`, `comment.`, `cycle.`, `project.`) and would silently omit every new one.

- [ ] **Step 1: Write the failing test**

```typescript
it("documents every registered skill in llms.txt", () => {
  const txt = buildLlmsTxt("https://example.com");
  for (const skill of getAllSkills()) {
    expect(txt, `llms.txt is missing ${skill.name}`).toContain(skill.name);
  }
});
```

Import `getAllSkills` from `../skill-registry.js` in the test.

- [ ] **Step 2: Verify it fails**

Expected: FAIL naming the first page/intake/relation/call-note skill, because the prefix groups do not cover them.

- [ ] **Step 3: Implement**

Replace the hardcoded prefix filters in `buildLlmsTxt` with grouping derived from the registry, so a skill added later cannot be silently undocumented:

```typescript
  const groups = new Map<string, typeof skills>();
  for (const skill of skills) {
    const prefix = skill.name.split(".")[0]!;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(skill);
  }
```

Render each group with its existing `formatSkillGroup` helper under a heading derived from the prefix. Keep every other section of the document unchanged — the existing tests assert on many of them.

- [ ] **Step 4: Run the tests and commit**

```bash
cd apps/mcp && npx tsc --noEmit && env -i PATH="$PATH" HOME="$HOME" npx vitest run
git add apps/mcp/src/a2a/
git commit -m "feat(a2a): derive llms.txt skill groups from the registry"
```

---

### Task 7: Verify the new skills against the live instance

**Files:** none — this is a verification task.

The unit tests cover pure functions; nothing so far proves the endpoints accept what the client sends. Every previous plan in this project had at least one bug that only a live run exposed.

- [ ] **Step 1: Exercise the read skills**

From `apps/mcp`, with `TASKPILOT_API_URL=http://localhost:4647`, call `page_list` and `intake_list` through `executeToolCall` with a real workspace and a token from `getOrCreateApiToken`. Confirm `page_list` returns pages from the `meetecho` workspace, which holds 4,807 of them.

- [ ] **Step 2: Exercise one write path end to end**

Create a page in a test project, update its description, read it back and confirm the content changed, then archive it. Use a project you are willing to leave a test page in, and say in your report exactly what you created so it can be cleaned up.

- [ ] **Step 3: Confirm the refusals actually refuse**

Attempt `page_update` against a page whose `external_source` is `meetecho` without `force`. It must refuse. This is the guard that protects 4,700+ synced pages from being silently overwritten, so verify it rather than trusting the unit test.

- [ ] **Step 4: Record the results**

Put the verbatim output of each call in your report, including the refusal.

---

## Definition of done

- `npx tsc --noEmit` exits 0 and `env -i … npx vitest run` passes in `apps/mcp`.
- Every skill in `SKILL_REGISTRY` appears in `llms.txt` (Task 6's test enforces this).
- Every write skill is in `WRITE_TOOLS` and declares `taskpilot:write`.
- The live verification in Task 7 is recorded, including a refused edit of an externally-synced page.
- `.env` ↔ `.env.example` parity holds (no new env vars are expected in this plan; confirm anyway).
