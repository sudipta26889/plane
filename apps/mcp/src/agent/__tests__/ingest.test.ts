import { describe, it, expect } from "vitest";
import {
  RULES,
  topicMatches,
  isSafeIngestTopic,
  isOwnMessage,
  idempotencyKeyFor,
  extractText,
  findRule,
} from "../ingest.js";

describe("loop prevention", () => {
  it("refuses our own output topics, which would otherwise recurse forever", () => {
    // Publishing taskpilot/task/created and then ingesting it would create a
    // task about creating a task, and that task would publish too.
    expect(isSafeIngestTopic("taskpilot/task/created")).toBe(false);
    expect(isSafeIngestTopic("taskpilot/agent/run")).toBe(false);
    expect(isSafeIngestTopic("taskpilot/health")).toBe(false);
  });

  it("allows only the deliberate ingest channel under our own prefix", () => {
    expect(isSafeIngestTopic("taskpilot/ingest/email")).toBe(true);
  });

  it("allows unrelated namespaces", () => {
    expect(isSafeIngestTopic("frigate/events")).toBe(true);
  });

  it("drops a message we published ourselves, independently of the topic guard", () => {
    // The second guard: one guard is a single point of failure and the failure
    // mode here is an infinite paid loop.
    expect(isOwnMessage(JSON.stringify({ origin: "taskpilot-mcp", a: 1 }))).toBe(true);
    expect(isOwnMessage(JSON.stringify({ origin: "frigate" }))).toBe(false);
    expect(isOwnMessage("not json")).toBe(false);
  });

  it("subscribes to no topic that would feed itself", () => {
    // Guards the allowlist itself, not just the runtime check.
    for (const rule of RULES) expect(isSafeIngestTopic(rule.topic)).toBe(true);
  });

  it("never subscribes to a multi-level wildcard", () => {
    // '#' on this broker is ~100 messages/second.
    for (const rule of RULES) expect(rule.topic).not.toContain("#");
  });
});

describe("DharaHIL notification, not instruction", () => {
  it("routes the decision topic to notify, never to the agent", () => {
    // If this ever became an agent rule, an MQTT publisher could describe a
    // decision and have it acted on. MQTT authenticates a connection, not a
    // request — the decision must come from the authenticated API.
    expect(findRule("dharahil/last_decision/state")?.handler).toBe("notify");
  });

  it("treats DharaHIL availability as its own state topic", () => {
    expect(findRule("dharahil/availability")?.handler).toBe("availability");
  });

  it("subscribes to no dharahil approve topic, which must never exist", () => {
    // DharaHIL's own documentation: "There is no dharahil/approve/<id> topic,
    // and one must never be added."
    expect(RULES.some((r) => r.topic.includes("approve"))).toBe(false);
  });

  it("gives no dharahil rule a path to the model", () => {
    for (const rule of RULES.filter((r) => r.topic.startsWith("dharahil/"))) {
      expect(rule.handler).not.toBe("agent");
    }
  });
});

describe("topicMatches", () => {
  it("matches a single-level wildcard", () => {
    expect(topicMatches("taskpilot/ingest/+", "taskpilot/ingest/email")).toBe(true);
    expect(topicMatches("taskpilot/ingest/+", "taskpilot/ingest/a/b")).toBe(false);
    expect(topicMatches("taskpilot/ingest/+", "taskpilot/ingest")).toBe(false);
  });

  it("matches exact topics", () => {
    expect(topicMatches("frigate/events", "frigate/events")).toBe(true);
    expect(topicMatches("frigate/events", "frigate/reviews")).toBe(false);
  });

  it("routes a topic to its rule", () => {
    expect(findRule("taskpilot/ingest/anything")?.handler).toBe("agent");
    expect(findRule("homeassistant/status")?.handler).toBe("rediscover");
    expect(findRule("frigate/events")?.handler).toBe("observe");
    expect(findRule("espresense/room")).toBeNull();
  });

  it("reaches the model on exactly one rule, and that rule carries a ceiling", () => {
    // Every message that reaches the agent costs an LLM call.
    const agentRules = RULES.filter((r) => r.handler === "agent");
    expect(agentRules).toHaveLength(1);
    expect(agentRules[0].perHour).toBeGreaterThan(0);
  });
});

describe("idempotencyKeyFor", () => {
  it("is stable for a redelivery of the same message", () => {
    // QoS 1 is at-least-once: the same event will arrive twice.
    const payload = JSON.stringify({ text: "check the door" });
    expect(idempotencyKeyFor("frigate/events", payload)).toBe(
      idempotencyKeyFor("frigate/events", payload),
    );
  });

  it("differs for different content on the same topic", () => {
    expect(idempotencyKeyFor("t", '{"text":"a"}')).not.toBe(idempotencyKeyFor("t", '{"text":"b"}'));
  });

  it("differs for the same content on different topics", () => {
    expect(idempotencyKeyFor("a", '{"x":1}')).not.toBe(idempotencyKeyFor("b", '{"x":1}'));
  });

  it("prefers a publisher-chosen id so a re-send with changed detail is still one event", () => {
    const a = idempotencyKeyFor("frigate/events", JSON.stringify({ id: "evt-1", score: 0.7 }));
    const b = idempotencyKeyFor("frigate/events", JSON.stringify({ id: "evt-1", score: 0.9 }));
    expect(a).toBe(b);
  });
});

describe("extractText", () => {
  it("pulls the obvious field", () => {
    expect(extractText('{"text":"hello"}')).toBe("hello");
    expect(extractText('{"title":"a title"}')).toBe("a title");
  });

  it("hands over the whole document rather than guessing an unpromised schema", () => {
    expect(extractText('{"a":1}')).toBe('{"a":1}');
  });

  it("passes plain text through", () => {
    expect(extractText("just words")).toBe("just words");
  });
});
