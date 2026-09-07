# MQTT Event Bus — Design

**Date:** 2026-09-07
**Status:** design, blocked on a working credential
**Scope:** `apps/mcp` — the MCP/A2A server

## The blocker, first

`homeassistant.lan:1883` is reachable and speaks MQTT, but **rejects every
credential tried**, including anonymous:

```
anonymous (no creds)         not authorised
configured user+password     not authorised
username only                not authorised
```

`MQTT_USERNAME=a2a_agents_mqtt_user` and its password are clean in `.env` — no
quotes, no stray whitespace. So the user does not exist on the broker yet, or
its password differs. On Home Assistant's Mosquitto add-on, MQTT users are
either Home Assistant users (Settings → People → Users) or entries in the
add-on's `logins:` config. Nothing below can be implemented or verified until a
`CONNACK: accepted` is achievable.

The rest of this design does not depend on the credential, but its
**verification does** — no phase should be called done on reading alone.

## Why MQTT, in terms of measured problems

Not "an event bus would be nice". Each item below is something observed in this
codebase this week.

### 1. Two pollers, both wasteful, both adding latency

| Poller | Interval | Cost |
|---|---|---|
| `pollHitlDecisions` (`a2a/background.ts`) | 30s | Up to **30s** between tapping Approve and the write happening. Queries Postgres every tick forever, including all night. |
| `syncKnowledgeIndex` | 10 min | A new work item or page is **not searchable for up to 10 minutes**. Every cycle re-hashes the whole corpus — 5,908 pages and 440 work items — to discover that nothing changed. |

MQTT replaces polling with notification: DharaHIL publishes a decision, the
resume happens immediately; Django publishes a work-item change, that one row is
re-indexed. Approval latency goes from ≤30s to ~instant, and the index goes from
≤10 minutes stale to seconds.

### 2. The agent can only be asked, never told

Everything the agent does today starts with an inbound A2A or MCP request. The
broker is a Home Assistant broker, so it already carries the household's real
events — sensors, cameras, bridges. Subscribing turns TaskPilot from a thing you
query into a thing that notices: a camera event, a delivery, a failed backup
becomes a routed, deduplicated work item through machinery that already exists
(`routeWorkItem`, `findDuplicate`, the Intake fallback).

This is the part that makes the system meaningfully better rather than merely
faster.

### 3. Degradation is invisible where you actually look

`/health` reports honestly, but only when polled. Publishing health transitions
to MQTT puts "the agent's LLM endpoint is down" on the same dashboard as
everything else in the house — the failure mode that already cost months of
silently degraded routing.

## Architecture

One long-lived client in `apps/mcp`, `agent/mqtt.ts`, owning connect,
reconnect-with-backoff, subscribe, and publish. It follows the pattern already
used for Redis and longmemory: **no silent fallback**, and `/health` probes it,
so an outage is visible rather than looking like an absence of events.

```
                    ┌────────────── inbound (allowlisted topics only)
 sensors / bridges ─┤
 DharaHIL ──────────┤   apps/mcp  agent/mqtt.ts ──► ingest → routeWorkItem
 Django (post_save) ┘                     │              → findDuplicate
                                          │              → Intake fallback
                                          └─► publish ──► taskpilot/#
```

### Topic layout

Outbound, namespaced so nothing collides with Home Assistant's tree:

```
taskpilot/task/created        {identifier, project, title, source}
taskpilot/task/state_changed  {identifier, from, to}
taskpilot/agent/run           {taskId, toolsUsed, status}
taskpilot/approval/requested  {taskId, tool, summary}
taskpilot/health              {status, degraded:[...]}      retained
```

Inbound, an **explicit allowlist** — never a wildcard subscribe. A Home
Assistant broker is extremely chatty and `#` would flood the process and the
LLM budget alike.

```
taskpilot/ingest/+            deliberate "make a task of this" channel
<curated HA topics>           configured per topic, one rule each
```

## The five decisions that matter

### 1. Whose identity does an MQTT message act as?

**A message from a topic is not a person.** It must map to a credential and pass
through the same policy every other caller does — `requiresHumanApproval`,
scope checks, audit. The mapping is configuration, not inference:

```
MQTT_INGEST_IDENTITY=peer_mqtt:for-ai
```

A `peer_` client id means every write it attempts is gated, which is already the
rule for external peers. **An MQTT topic must never become an ungated write
path**, and the audit trail must show `peer_mqtt` as the actor.

### 2. Feedback loops

TaskPilot publishes `taskpilot/task/created`; if an ingest rule ever matched
that namespace, it would create a task about creating a task, forever.
Mitigations, both required: inbound subscriptions may never include the
`taskpilot/` prefix except `taskpilot/ingest/`, and every published message
carries `origin: "taskpilot-mcp"` which the ingest path drops.

### 3. Duplicate delivery

MQTT QoS 1 is at-least-once: the same event **will** arrive twice sometimes.
The A2A path already has an idempotency key; ingest reuses it, deriving the key
from the topic plus a message id or content hash, so a redelivery is a no-op
rather than a second work item.

### 4. Volume and cost

Every ingested message that reaches the agent costs an LLM call. An allowlist is
not enough on its own — a chatty sensor could still bankrupt the budget. Each
ingest rule carries a rate limit, and a global ceiling on agent-invoking
ingests per hour, refusing beyond it and saying so.

### 5. Ordering and the existing pollers

MQTT is a notification, not a guarantee. The pollers stay as a **safety net at a
much longer interval** (10 min → 1 hour for approvals, 10 min → 6 hours for the
index), rather than being deleted. If the broker drops a message the system is
late, not wrong. Deleting the poller would trade a 30-second latency for an
unbounded one.

## Phasing

Ordered so each phase is independently useful and independently verifiable.

**Phase 1 — client + health.** `agent/mqtt.ts`, connect/reconnect/backoff, a
`/health` probe, and the retained `taskpilot/health` publish. Smallest possible
change that proves the credential, the library choice and the reconnect
behaviour. Nothing depends on it yet.

**Phase 2 — outbound events.** Publish task lifecycle and agent runs. Read-only
with respect to TaskPilot's own data: it cannot break anything, and it gives the
household something to react to immediately.

**Phase 3 — approval notification.** DharaHIL decisions arrive by event; the
poller drops to an hourly safety net. Removes the 30-second approval latency.
*Depends on DharaHIL being able to publish — verify before planning the work.*

**Phase 4 — index freshness.** Django publishes work-item and page changes on
save; the MCP server re-indexes that row. The 10-minute full pass becomes a
6-hour reconciliation. Requires touching `apps/api`, so it is deliberately last
among the internal phases.

**Phase 5 — inbound ingest.** The allowlist, the identity mapping, the rate
limits, the loop guards. Most valuable and most dangerous; it goes last because
it is the only phase that lets the outside world cause writes.

## What could go wrong, and the guard for each

| Risk | Guard |
|---|---|
| An MQTT topic becomes an ungated write path | Ingest acts as a `peer_` identity; every write gated and audited |
| Feedback loop | `taskpilot/` excluded from ingest; `origin` marker dropped |
| Duplicate delivery creates duplicate work | Idempotency key derived from topic + message id |
| A chatty sensor drains the LLM budget | Per-rule rate limit plus a global hourly ceiling |
| Broker outage looks like "nothing happened" | `/health` probes MQTT; pollers remain as the safety net |
| HA topic flood | Explicit allowlist, never `#` |

## Dependency question to settle before Phase 3 and 5

- **Can DharaHIL publish to MQTT?** If not, Phase 3 is not buildable and the
  30-second approval latency stays.
- **What is actually on the broker?** The topic tree could not be enumerated
  because the credential is rejected. Phase 5's allowlist cannot be written
  without it — the rules must be built from real topics, not imagined ones.
