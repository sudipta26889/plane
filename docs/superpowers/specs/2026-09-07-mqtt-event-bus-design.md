# MQTT Event Bus — Design

**Date:** 2026-09-07
**Status:** design — credential now working, topic tree enumerated
**Scope:** `apps/mcp` — the MCP/A2A server

## Credential: resolved

The broker rejected every credential including anonymous, and the client was
falsified as the cause — a deliberately wrong protocol version returned code 132
(`0x84`, Unsupported Protocol Version) while the correct version returned "not
authorised", proving the packets parsed. The user was subsequently created on
the broker and `CONNACK: accepted` now succeeds with the unchanged `.env`
password.

## The broker, measured

`homeassistant.lan:1883`, 12-second listen on `#`:

**1,241 messages across 1,115 topics — roughly 100 messages/second.**

| namespace | topics | nature |
|---|---|---|
| `homeassistant/` | 663 | discovery/config, not events |
| `espresense/` | 259 | BLE room presence, continuous |
| `frigate/` | 120 | camera — mixed signal and binary |
| `zigbee2mqtt/` | 68 | device state |
| `esphome/`, `room-assistant/`, `espnow-receiver/` | 5 | minor |

This makes the allowlist **existential rather than tidy**. At one LLM call per
ingested message, a wildcard subscribe would exhaust the budget in minutes.

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
frigate/events                object lifecycle JSON — 0 msgs in 25s, high signal
frigate/reviews               review items — 0 msgs in 25s, high signal
homeassistant/status          fires on HA restart only
zigbee2mqtt/bridge/state      bridge online/offline
```

**Explicitly excluded, each for a measured reason:**

| Excluded | Why |
|---|---|
| `frigate/+/+/snapshot` | **binary JPEG** (`JFIF` header), not text — useless to an LLM and costly to receive |
| `zigbee2mqtt/bridge/logging` | ~720 msg/hr of debug chatter |
| `homeassistant/#` | 663 topics of discovery config, not events |
| `espresense/#` | 259 topics of continuous presence telemetry |
| `#` | ~100 msg/sec |

The two Frigate event topics produced **nothing** in 25 seconds, which is the
point: they fire on a real occurrence rather than continuously. That is the
shape an ingest rule wants.

**Not yet verified:** no `frigate/events` payload was observed, because nothing
happened while listening. The rule that parses it must be written against a real
captured message, not against the schema from memory.

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

**Phase 3 — approval notification. NOT BUILDABLE, deferred.** DharaHIL cannot
publish to MQTT yet (confirmed). Until it can, the 30-second approval latency
stays and `pollHitlDecisions` keeps its 30s interval — dropping it to hourly
without an event source would make approvals *worse*, not better. Revisit only
when DharaHIL gains a publisher.

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

## Settled dependencies

Both are now resolved; kept here because the reasoning still explains the shape
of what shipped.

- **~~DharaHIL cannot publish to MQTT.~~** It can, as of 2026-09-07. It
  publishes telemetry only and deliberately accepts no approval over MQTT,
  since MQTT authenticates a connection rather than a request. So Phase 3
  shipped as a *notification*: `dharahil/last_decision/state` firing means "ask
  the authenticated API now" and its payload is never read as a decision. The
  30s poller is kept as the safety net rather than lengthened — it is cheap,
  and the notification path failing must make approvals late, not invisible.
- **~~The topic tree is unknown.~~** Enumerated against the real broker; the
  allowlist below is built from measured topics.

## Status as shipped (2026-09-07)

| Phase | State |
|---|---|
| 1–2 — publish, health, LWT, HA discovery | Done. Four retained topics verified on the real broker. |
| 3 — approval notification | Done, as a notification only (see above). |
| 4 — index freshness | Done, via Postgres LISTEN/NOTIFY rather than MQTT: NOTIFY delivers only on commit, so the listener can never read a row that does not exist yet. |
| 5 — inbound ingest | Done. Verified end to end: a write published to `taskpilot/ingest/+` suspended on the approval gate, was approved by a human in 17s, and only then executed. |

**Still deliberately unfinished:** no `frigate/events` payload has been observed
— nothing moved during a 3-minute capture. Those topics are subscribed and
logged (the `observe` handler) precisely so the parsing rule can be written
against a real message. Guessing the schema is the one thing this document says
not to do, so nothing parses them yet.

## What is actually buildable today

Phases 1, 2 and 4 — client + health, outbound events, and index freshness. Of
those, 1 and 2 need only a working credential; 4 additionally needs a publisher
in `apps/api` on work-item and page save.

The honest summary of value without Phase 3 and 5: MQTT buys **index freshness**
(10 minutes stale to seconds, and the end of re-hashing 5,908 pages on a timer)
and **visible health in the house**. The two headline wins — instant approvals
and the agent noticing things by itself — are both blocked, one on DharaHIL and
one on the credential.
