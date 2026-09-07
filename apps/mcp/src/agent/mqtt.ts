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
  });

  client.on("connect", () => {
    lastError = null;
    console.log(`[mqtt] connected to ${config.mqttHost}:${config.mqttPort}`);
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
