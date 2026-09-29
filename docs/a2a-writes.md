# A2A writes: approval lifecycle, operations and rollback

Operator notes for `taskpilot-mcp`, the server behind both MCP (`POST /mcp-server`)
and A2A (`POST /a2a`). The **peer-facing** contract (lifecycle, error codes,
idempotency, payload examples) is generated from the skill registry and served
live at `https://taskpilot-mcp.sudiptadhara.in/a2a/llms.txt`. This page does
not repeat it.

## How an approval-gated write completes

```
peer ── message/send ──▶ validate token, scope, input, project   (failure ⇒ error, no task)
                         create a2a_tasks row  state=auth_required
                         POST DharaHIL /v1/requests               (failure ⇒ task failed, never stranded)
     ◀── {taskId, state: auth_required, approval.id, project, message}

human approves in Slack/Telegram
                         approval worker (every 30s, and at once on the MQTT
                         dharahil/last_decision notice) reads the decision:
                           claim a2a_approvals row  WHERE status='pending'      (once)
                           auth_required → submitted → working                 (compare-and-set)
                           run the stored input via executeToolCall
                           working → completed | failed
peer ── tasks/get(taskId) ──▶ {state, result | error, approval}
```

Exactly-once rests on two database guards, not on process state:
the conditional `UPDATE a2a_approvals … AND status='pending'` and the
compare-and-set in `transitionState` (`… WHERE state = <state just read>`).
Duplicate DharaHIL notices, overlapping ticks and two server processes all
lose to whichever claimed first. Duplicate sends are stopped by
`uq_a2a_tasks_client_idempotency` (unique on `client_id, idempotency_key`).

Execution is **at most once**. The stranded-task sweep (`failStrandedTasks`,
every 30s) never re-runs a write. It fails tasks nothing will ever finish:

- `auth_required` with no approval row, after 10 minutes
- `submitted`/`working`, after 30 minutes (the server died mid-write; the
  reason tells the peer to check before retrying)

## Scopes

Tokens are minted per peer with `apps/mcp/scripts/mint-peer-token.ts`
(`peer_*` client ids). `taskpilot:read` covers every read skill and
`taskpilot:write` covers every write skill. A `peer_*` client's writes always
go through DharaHIL. There is no OAuth refresh step and no client secret
involved.

## Health

`GET /health` includes two new entries:

- `dharahil`: the gateway's `/healthz` answers (skipped when `DHARAHIL_ENABLED` is not `true`)
- `approvalWorker`: the approval poll ran within the last 90s without error. This is the resumption path itself, not just the HTTP listener.

Structured log lines to grep: `"evt":"a2a.transition"` (every state change,
with task id, from, to and reason) and `"evt":"a2a.idempotency"` (hit or
miss). Neither carries request content.

## Deploy

```bash
cd /mnt/projects/TaskPilot
# keep the running image for rollback
docker tag "$(docker inspect -f '{{.Image}}' taskpilot-mcp)" taskpilot-mcp:rollback-$(date +%Y%m%d-%H%M)
docker compose up -d --build mcp
docker logs --since 2m taskpilot-mcp | grep -E "listening|Database initialized|Background tasks"
curl -s https://taskpilot-mcp.sudiptadhara.in/health | jq '.dependencies.approvalWorker, .dependencies.dharahil'
curl -s https://taskpilot-mcp.sudiptadhara.in/.well-known/agent-card.json | jq '[.skills[].id] | length'
```

Startup creates `uq_a2a_tasks_client_idempotency` if it is missing. If
existing rows ever violate it, startup fails loudly (`process.exit(1)`) and the
old container keeps running. Find the offending rows with
`SELECT client_id, idempotency_key, count(*) FROM a2a_tasks WHERE idempotency_key IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1`.

## Rollback

```bash
docker tag taskpilot-mcp:rollback-<stamp> taskpilot-mcp:latest   # or: git checkout <prev> && docker compose up -d --build mcp
docker compose up -d --no-build mcp
```

No schema change needs reverting. The new index and the extra allowed
transition (`auth_required → failed`) are both harmless to the old code.

## GuardianAI as a TaskPilot target

| | |
|---|---|
| Project | `GuardianAI`, identifier `GUARDIANAI` |
| Project id (immutable, prefer this) | `1ba49ea0-c0c2-46eb-abc8-691906234eae` |
| Workspace slug | the peer token's workspace (`TASKPILOT_WORKSPACE_SLUG`) |
| Code repository | not recorded in TaskPilot; the project holds the program plan page and the `GUARDIANAI-n` tickets |
