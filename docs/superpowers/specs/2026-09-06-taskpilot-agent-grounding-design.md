# TaskPilot Agent Grounding — Design

**Date:** 2026-09-06
**Status:** Approved for planning
**Scope:** `apps/mcp` — the MCP + A2A server

## Goal

The TaskPilot A2A agent must file work into the right place every time, and when it
cannot tell, it must say so rather than guess. It also has to reach the parts of
TaskPilot it currently cannot touch at all: pages, intake, relations and call notes.

Success is measured, not asserted: routing accuracy is replayed against the 439
work items that already exist, whose real projects are ground truth.

## Non-goals

- **Cross-workspace routing.** One workspace per A2A connection, as today. The
  OAuth access token pins `workspace_slug` ([a2a/auth.ts](../../../apps/mcp/src/a2a/auth.ts)) and that
  stays. A conversation with Mitra files into one workspace.
- **Modules and cycles as routing dimensions.** Both tables are empty (0 rows).
  Routing targets projects, not sprints.
- **Owning page content.** MeetEcho writes the pages. TaskPilot reads and files
  them; it does not become the source of truth for their text.

## Measured facts this design rests on

Taken from the live instance on 2026-09-06, not assumed:

| Fact | Value |
|---|---|
| Workspaces / projects | 5 / 16 |
| Work items | 439 (432 in `for-ai`) |
| Pages | 4,807 |
| Modules / cycles | 0 / 0 |
| Embedding model | `BAAI/bge-visualized-m3`, 1024-dim, CPU, 300s idle unload |
| Warm embed latency | 0.11s |
| Batch throughput | 64 texts in 6.9s (~9/sec) |
| Cold start after unload | 10.5s |
| Qdrant | up at `nuc.lan:6333`; `taskpilot_vector_db` does not exist yet |
| `meetecho_vector_db_pkm` | 6,364 points, 1024-dim, cosine |
| pgvector | 0.8.2 available, DB user is superuser — **not used**, see below |

Two consequences follow directly:

**The 439-item backfill takes ~47 seconds.** It is not expensive. Earlier drafts of
this design treated it as the dominant cost; measurement disproved that.

**The embedding model is not a free choice.** Vectors are only comparable within
one model, even at equal dimensions. Reading `meetecho_vector_db_pkm` requires
embedding queries with exactly `bge-visualized-m3`. Any model swap forfeits 4,807
free page vectors and forces TaskPilot to embed and continuously re-sync every page
itself.

## Architecture

Five units, each independently testable.

### 1. `knowledge/qdrant.ts` — vector store client

Thin wrapper over Qdrant's REST API using `fetch`: `ensureCollection`, `upsert`,
`search`, `deleteByFilter`. No new npm dependency — the four operations needed are
about 40 lines, and `@qdrant/js-client-rest` would earn its place only if we needed
more.

**Why Qdrant rather than pgvector**, which is available and installable here: Qdrant
is already running with the page vectors we want to reuse, and it keeps the index out
of Django's database entirely. pgvector would mean a new table in a schema Django owns
via migrations, plus a `CREATE EXTENSION`, to build an index that already exists
elsewhere.

Two collections, deliberately different in role:

- **`taskpilot_vector_db`** (from `QDRANT_COLLECTION_NAME`, created by us, 1024-dim,
  cosine) — **TaskPilot owns it. Work items only.** Payload:
  `{ entity_type: "work_item", issue_id, project_id, workspace_id, identifier,
  state_group, updated_at, content_hash }`.
- **`meetecho_vector_db_pkm`** (existing) — **read-only.** Page routing and dedupe
  search here instead of re-embedding pages.

`taskpilot_tasks` (768-dim, 2 points) is a dead false start, incompatible with this
embedder. Leave it untouched.

#### The page join

A hit in the PKM collection identifies a PKM node, not a TaskPilot page. They join
on source identity:

```
pages.external_source  ==  PKM source_system   (whatsapp|manual|sms|neo1|meetecho|slack|inbox)
pages.external_id      ==  PKM node id
```

Verified: page counts grouped by `external_source` sum to exactly 4,807 across those
seven sources, and the `external_id` formats match the PKM URIs (`slack:digest:2026-08-21`
against `/slack/slack:digest:2026-08-24`). The PKM collection holds 6,364 points, so
some nodes have no corresponding page; those hits simply miss, which is harmless.

**Implementation task:** confirm the exact payload field names in the PKM collection
by scrolling one point. `pkm_search` output suggests `node_id`, `source_system`,
`uri`, `title`, `occurred_at`, but this was not verified directly.

### 2. `knowledge/context.ts` — instance snapshot

A Redis-cached (5 min TTL) description of one workspace, assembled once per routing
decision rather than re-fetched per call:

- Projects with `identifier`, `name`, and `description`. **The descriptions are the
  routing rules** — they already read as such ("all task related to finance will go
  here", "Phone call-note work items for ProDevs … land here"). They are the highest
  signal available and the current router ignores them.
- States, labels, members per project.
- TaskPilot's own semantics, so the agent stops inventing behaviour: there is no
  delete, cancellation requires approval, Intake exists, cycles and modules are unused.

This is the "aware of all features" half of the goal, and it replaces the three-field
prompt the current router builds.

### 3. `routing/router.ts` — decisions that carry confidence

Replaces `routeTask` in [tools/smart-router.ts](../../../apps/mcp/src/tools/smart-router.ts).

Input: `{ title, description, entityType, projectHint? }`. Steps:

1. Explicit `projectHint` that matches a project name or identifier wins outright.
2. Embed `title + description`. **The current router reads the title only** — the
   description is the richer signal and is discarded today.
3. Retrieve top-K neighbours from the appropriate collection.
4. Ask the LLM to choose among projects, given project descriptions **and the
   neighbours' projects as evidence** ("14 of the 20 most similar items live in
   SUDIPTASCF").
5. Return `{ projectId, confidence, reason, candidates[] }`.

Below the confidence threshold it returns `undecided`. **The `"No match … using first
project"` fallback at [smart-router.ts:238](../../../apps/mcp/src/tools/smart-router.ts#L238) is deleted, not
softened.** That line is the single largest source of silent misfiling today.

The existing Redis routing cache is keyed on the exact lowercased title, which both
misses trivial rewordings and risks collisions across unrelated items. Re-key it on
the content hash of title + description, and store the confidence alongside so a
cached low-confidence decision does not read back as certain.

### 4. `routing/dedupe.ts` — attach instead of duplicating

Embed the candidate, retrieve top-K within the chosen project and across the
workspace, then rerank with `rerank-large` (already served by the same LiteLLM
endpoint). Above threshold, return `{ duplicate_of, score, reason }`.

The caller decides what that means: comment on the existing item, link a relation, or
update it. Updates are DharaHIL-gated (see below).

### 5. New skills

Following the existing `skill-registry.ts` → `handlers.ts` → `taskpilot-client.ts`
pattern, all against the public REST API v1:

| Area | Endpoints |
|---|---|
| Pages | `/pages/`, `/pages/:pk/`, `/pages/:pk/description/`, `/pages/:pk/archive/`, `/pages/:pk/versions/` |
| Intake | `/intake-issues/`, `/intake-issues/:issue_id/` |
| Relations | sub-issue parenting and `blocks`/`duplicates` links |
| Call notes | `/call-notes/upsert/`, `/lookup/`, `/history/` |

Call-note routing must respect the convention already encoded in the project
descriptions — ProDevs, GrihaTEK and RitualRhythms each declare that their call notes
land in that project.

## Behaviour when confidence is low

Two mechanisms, matched to blast radius. Both already exist; neither is invented here.

- **New items → Intake.** TaskPilot's own unsorted bucket, visible in the UI with
  accept/reject. Nothing is lost and nothing is misfiled.
- **Updates to existing items or pages → DharaHIL.** A wrong guess here corrupts real
  data, so it asks first via the approval loop in
  [a2a/dharahil.ts](../../../apps/mcp/src/a2a/dharahil.ts), reusing the machinery already wired for
  critical actions.

## Failure behaviour

| Failure | Response |
|---|---|
| Qdrant unreachable | Fall back to description-only LLM routing, **cap confidence below the threshold** so everything ambiguous reaches Intake rather than being guessed |
| Embedding server down | Same as above |
| LLM unreachable | Everything ambiguous goes to Intake |
| PKM collection missing or reshaped | Page dedupe degrades to title matching; page routing still works from project descriptions |
| Index stale | A duplicate is missed. A miss, never a misfile. |

The invariant: every path that could once silently pick the wrong project now has an
honest place to put the item instead.

## Cold start

`bge-visualized-m3` unloads after 300s idle and costs 10.5s to reload. The background
loop in [a2a/background.ts](../../../apps/mcp/src/a2a/background.ts) already runs on a timer; it embeds a
throwaway string every ~4 minutes so the model stays resident. Cost: ~0.1s of CPU per
interval, and the model holds RAM on `nuc.lan` continuously instead of freeing itself
between bursts.

## Environment variables

Already present in `.env`, and **all four are missing from `.env.example`** — parity
is currently broken and must be restored in the same change, per the repo's env-sync
rule:

| Key | Value / purpose |
|---|---|
| `QDRANT_URL` | `http://nuc.lan:6333` |
| `QDRANT_API_KEY` | secret; placeholder only in `.env.example` |
| `QDRANT_COLLECTION_NAME` | `taskpilot_vector_db` |
| `EMBEDDING_DIRECT_URL` | `http://nuc.lan:18081/embed` |

Also needs adding: the `mcp` service in `docker-compose.yml` uses `env_file: .env`, so
it inherits these, but the Portainer stack env must be updated to match. New keys for
the thresholds (routing confidence, dedupe similarity) go through the same sync.

## Testing

**Routing eval — the headline number.** The 439 existing work items are a labelled
dataset: each one's real project is ground truth. Replay every item's title and
description through the router and report top-1 accuracy, undecided rate, and
misroute rate, with the current router as the baseline. Thresholds are then tuned
against that curve rather than picked by feel. Committed as a script so it can be
re-run when the corpus grows.

**Unit tests**, following the existing vitest setup in `apps/mcp/src/a2a/__tests__/`:

- Router returns `undecided` rather than a project when confidence is below threshold.
- Qdrant/embedding/LLM outages each cap confidence and land items in Intake.
- Dedupe returns `duplicate_of` above threshold and `null` below it.
- The PKM node → page join maps correctly, and misses cleanly when no page exists.
- Each new skill enforces its scope and its approval flag.

## Open questions

1. **PKM payload field names** — needs one scroll of `meetecho_vector_db_pkm` to
   confirm. Blocks the page path; nothing else.
2. **Confidence and similarity thresholds** — deliberately unset here. They come out
   of the eval in the first implementation phase, not out of a guess in the spec.
