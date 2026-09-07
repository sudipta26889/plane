import mqtt, { type MqttClient } from "mqtt";
import { config } from "../config.js";

/**
 * MQTT client for the event bus.
 *
 * Publishing only, for now: inbound ingest is a later phase because it is the
 * only path that lets the outside world cause writes. The broker carries about
 * 100 messages/second across 1,115 topics, so nothing here ever subscribes to a
 * wildcard — at one LLM call per ingested message that would exhaust the budget
 * in minutes.
 *
 * Follows the same rule as Redis and longmemory in this codebase: no silent
 * fallback. If the broker is unreachable, publishes are dropped with a log and
 * /health says so, rather than the absence of events looking like the absence
 * of anything to report.
 */

const CONNECT_TIMEOUT_MS = 10_000;
// Publishing must never delay the request that triggered it. A slow broker
// drops the message rather than holding a user's call open.
const PUBLISH_TIMEOUT_MS = 3_000;

let client: MqttClient | null = null;
let lastError: string | null = null;

export function isConfigured(): boolean {
  return Boolean(config.mqttHost && config.mqttUsername);
}

/** Topics this server owns. Everything it publishes lives under `taskpilot/`. */
/** Availability, backed by the broker's Last Will. */
export const AVAILABILITY_TOPIC = "taskpilot/availability";

/**
 * Home Assistant discovery entities.
 *
 * One entity per question someone would actually ask, not one per metric:
 * "is it running?" and "is it degraded?". What is broken rides along as an
 * attribute rather than becoming a third entity.
 */
export const ENTITIES = {
  availability: {
    component: "binary_sensor",
    name: "TaskPilot Agent",
    device_class: "connectivity",
    state_topic: AVAILABILITY_TOPIC,
    payload_on: "online",
    payload_off: "offline",
  },
  degraded: {
    component: "binary_sensor",
    name: "TaskPilot Agent Degraded",
    device_class: "problem",
    state_topic: "taskpilot/health",
    value_template: "{{ 'ON' if value_json.status == 'degraded' else 'OFF' }}",
    json_attributes_topic: "taskpilot/health",
  },
} as const;

export type EntityKey = keyof typeof ENTITIES;

export const TOPIC = {
  taskCreated: "taskpilot/task/created",
  taskStateChanged: "taskpilot/task/state_changed",
  agentRun: "taskpilot/agent/run",
  approvalRequested: "taskpilot/approval/requested",
  health: "taskpilot/health",
} as const;

/**
 * Connect lazily and keep the connection. `mqtt.connect` reconnects on its own,
 * so this is called once and the client handles drops.
 */
function getClient(): MqttClient | null {
  if (!isConfigured()) return null;
  if (client) return client;

  client = mqtt.connect(`mqtt://${config.mqttHost}:${config.mqttPort}`, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    // Identifies this publisher on the broker, and keeps a restarted server
    // from colliding with its own previous session.
    clientId: `taskpilot-mcp-${process.pid}`,
    connectTimeout: CONNECT_TIMEOUT_MS,
    reconnectPeriod: 5_000,
    clean: true,
    // The Last Will is the reason to prefer this over a polling health check:
    // if the process dies — crash, OOM, severed socket — the BROKER publishes
    // "offline" on our behalf. Agent-down detection with no watchdog and no
    // polling. A graceful shutdown never exercises this, so it must be tested
    // by killing the connection rather than by calling our own shutdown.
    will: {
      topic: AVAILABILITY_TOPIC,
      payload: Buffer.from("offline"),
      qos: 1,
      retain: true,
    },
  });

  client.on("connect", () => {
    lastError = null;
    // This fires on CONNACK, not on the TCP handshake, and the client raises
    // `error` for a non-zero return code — so this log cannot claim a
    // connection the broker refused.
    console.log(`[mqtt] connected to ${config.mqttHost}:${config.mqttPort}`);
    client?.publish(AVAILABILITY_TOPIC, "online", { qos: 1, retain: true });
    void publishDiscovery();
  });

  // An 'error' listener is mandatory: this is an EventEmitter, and an unhandled
  // 'error' would crash the process — the exact bug this codebase already had
  // twice with ioredis.
  client.on("error", (err) => {
    lastError = err?.message ?? "unknown error";
    console.warn(`[mqtt] ${lastError}`);
  });

  client.on("offline", () => {
    lastError = "broker offline";
  });

  return client;
}

/**
 * Publish, never throwing.
 *
 * Every caller is on a request path that must succeed whether or not the house
 * is listening, so a failed publish is logged and swallowed. `/health` is what
 * makes a persistent outage visible.
 */
export async function publish(
  topic: string,
  payload: Record<string, unknown>,
  opts: { retain?: boolean } = {},
): Promise<void> {
  const c = getClient();
  if (!c) return;

  const body = JSON.stringify({
    ...payload,
    // Marks our own traffic so a future ingest rule can drop it and avoid a
    // feedback loop where publishing an event creates a task about the event.
    origin: "taskpilot-mcp",
    at: new Date().toISOString(),
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("publish timed out")), PUBLISH_TIMEOUT_MS);
      c.publish(topic, body, { qos: 0, retain: Boolean(opts.retain) }, (err) => {
        clearTimeout(timer);
        err ? reject(err) : resolve();
      });
    });
  } catch (err: any) {
    lastError = err?.message ?? "publish failed";
    console.warn(`[mqtt] publish to ${topic} failed: ${lastError}`);
  }
}

/** Liveness for /health. Throws on failure so the probe reports it. */
export async function ping(): Promise<string> {
  if (!isConfigured()) throw new Error("MQTT_HOST/MQTT_USERNAME are not configured");

  const c = getClient();
  if (!c) throw new Error("client unavailable");
  if (c.connected) return `${config.mqttHost}:${config.mqttPort} connected`;

  // Not yet connected: wait briefly rather than reporting a cold start as an
  // outage, since the client connects lazily on first use.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(lastError ?? "not connected")),
      CONNECT_TIMEOUT_MS,
    );
    c.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return `${config.mqttHost}:${config.mqttPort} connected`;
}

/**
 * Announce entities to Home Assistant so they self-register.
 *
 * Retained, so a restarting Home Assistant re-reads them without waiting for
 * this process to restart too. Grouped under one device block so they appear
 * as one thing rather than two loose sensors.
 */
export async function publishDiscovery(): Promise<void> {
  const c = getClient();
  if (!c) return;

  const device = {
    identifiers: ["taskpilot_mcp"],
    name: "TaskPilot Agent",
    manufacturer: "TaskPilot",
    model: "MCP/A2A server",
  };

  for (const key of Object.keys(ENTITIES) as EntityKey[]) {
    const entity = ENTITIES[key];
    const topic = `homeassistant/${entity.component}/taskpilot_mcp/${key}/config`;
    const payload = {
      ...entity,
      unique_id: `taskpilot_mcp_${key}`,
      object_id: `taskpilot_${key}`,
      device,
      // Every entity except availability itself is unknown when we are down.
      ...(key === "availability" ? {} : { availability_topic: AVAILABILITY_TOPIC }),
    };

    try {
      await new Promise<void>((resolve, reject) => {
        c.publish(topic, JSON.stringify(payload), { qos: 1, retain: true }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    } catch (err: any) {
      console.warn(`[mqtt] discovery for ${key} failed: ${err.message}`);
    }
  }
}

/**
 * Publish an entity's state by key.
 *
 * Throws on an unknown key rather than silently creating an entity nothing
 * announced — a typo here should be loud.
 */
export async function publishEntityState(key: EntityKey, value: string): Promise<void> {
  if (!(key in ENTITIES)) {
    throw new Error(`Unknown MQTT entity "${key}". Declare it in ENTITIES first.`);
  }
  await publish(ENTITIES[key].state_topic, { state: value }, { retain: true });
}

/**
 * Subscribe to an explicit list of topics.
 *
 * Never a wildcard beyond a single `+` level named by a caller: this broker
 * carries ~100 messages/second across 1,115 topics, and `#` would flood the
 * process and the model budget alike. The handler is called per message; it
 * must not throw, and this logs and continues if it does, since one bad
 * message must not tear down the subscription.
 */
export async function subscribe(
  topics: string[],
  handler: (topic: string, payload: string) => void | Promise<void>,
): Promise<void> {
  const c = getClient();
  if (!c) return;

  const attach = () => {
    c.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        lastError = err.message;
        console.warn(`[mqtt] subscribe failed: ${err.message}`);
        return;
      }
      console.log(`[mqtt] subscribed to ${topics.length} ingest topic(s)`);
    });
  };

  // Subscriptions do not survive a reconnect with `clean: true`, so re-attach
  // on every connect rather than only the first. Without this, a broker blip
  // silently ends ingest and looks exactly like "nothing happened".
  c.on("connect", attach);
  if (c.connected) attach();

  c.on("message", (topic, payload) => {
    void (async () => {
      try {
        await handler(topic, payload.toString());
      } catch (err: any) {
        console.warn(`[mqtt] ingest handler for ${topic} threw: ${err?.message}`);
      }
    })();
  });
}

/** Graceful shutdown: say offline ourselves rather than leaving it to the will. */
export async function shutdown(): Promise<void> {
  const c = client;
  if (!c) return;
  await new Promise<void>((resolve) => {
    c.publish(AVAILABILITY_TOPIC, "offline", { qos: 1, retain: true }, () => resolve());
  });
  c.end();
  client = null;
}
