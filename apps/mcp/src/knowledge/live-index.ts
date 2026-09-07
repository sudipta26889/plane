import pg from "pg";
import { config } from "../config.js";
import { indexByIds } from "./index-sync.js";

/**
 * Keep the vector index fresh within seconds of a change.
 *
 * Before this, a new work item or page was unsearchable for up to ten minutes
 * and every timer tick re-hashed the whole corpus — 5,908 pages and 440 work
 * items — to discover nothing had changed.
 *
 * Postgres LISTEN/NOTIFY rather than MQTT, deliberately. Django would otherwise
 * need a broker client, signal handlers and a Celery hop, all in a fork that
 * merges upstream regularly. NOTIFY also has the property the naive version
 * gets wrong: notifications are delivered ONLY when the transaction commits, so
 * the listener can never read a row that does not exist yet.
 */

export const CHANNEL = "taskpilot_index";

// Bulk operations — a migration, an import, a cascade — would otherwise fire a
// re-index per row. Collecting for a moment turns a thousand notifications into
// one batch.
const DEBOUNCE_MS = 2_000;
const RECONNECT_MS = 5_000;

let client: pg.Client | null = null;
let timer: NodeJS.Timeout | null = null;
let lastError: string | null = null;
let connected = false;

const pendingWorkItems = new Set<string>();
const pendingPages = new Set<string>();

export interface IndexNotification {
  entity: "work_item" | "page";
  id: string;
}

/**
 * Parse a notification payload, rejecting anything malformed.
 *
 * The payload comes from a database trigger, but a bad one must not take the
 * listener down — losing the listener would silently return the system to
 * ten-minute staleness with nothing to show why.
 */
export function parseNotification(payload: string | undefined): IndexNotification | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (parsed?.entity !== "work_item" && parsed?.entity !== "page") return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    return { entity: parsed.entity, id: parsed.id };
  } catch {
    return null;
  }
}

async function flush(): Promise<void> {
  timer = null;
  const items = [...pendingWorkItems];
  const pages = [...pendingPages];
  pendingWorkItems.clear();
  pendingPages.clear();

  try {
    if (items.length) {
      const r = await indexByIds("work_item", items);
      console.log(`[live-index] work items: ${r.embedded} indexed, ${r.skipped} unchanged, ${r.removed} removed`);
    }
    if (pages.length) {
      const r = await indexByIds("page", pages);
      console.log(`[live-index] pages: ${r.embedded} indexed, ${r.skipped} unchanged, ${r.removed} removed`);
    }
  } catch (err: any) {
    // The periodic full sync is the safety net: a failure here means the row is
    // late, not lost.
    lastError = err?.message ?? "index failed";
    console.warn(`[live-index] ${lastError}`);
  }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => void flush(), DEBOUNCE_MS);
}

/**
 * A dedicated connection, not one from the pool: a pooled client would be
 * handed to someone else and the LISTEN registration lost with it.
 */
export async function startLiveIndex(): Promise<void> {
  if (!config.databaseUrl || !config.qdrantUrl || !config.embeddingUrl) return;

  try {
    client = new pg.Client({ connectionString: config.databaseUrl });

    // A dropped listener stops delivering notifications silently, which would
    // look exactly like "nothing has changed". Reconnect, and say so.
    client.on("error", (err) => {
      connected = false;
      lastError = err?.message ?? "connection lost";
      console.warn(`[live-index] connection lost: ${lastError}`);
      setTimeout(() => void startLiveIndex(), RECONNECT_MS);
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    connected = true;
    lastError = null;
    console.log(`[live-index] listening on ${CHANNEL}`);

    client.on("notification", (msg) => {
      const parsed = parseNotification(msg.payload);
      if (!parsed) return;
      (parsed.entity === "work_item" ? pendingWorkItems : pendingPages).add(parsed.id);
      schedule();
    });
  } catch (err: any) {
    connected = false;
    lastError = err?.message ?? "connect failed";
    console.warn(`[live-index] could not start: ${lastError}`);
    setTimeout(() => void startLiveIndex(), RECONNECT_MS);
  }
}

/** Status for /health, so a dead listener is visible rather than merely quiet. */
export function getLiveIndexStatus(): { ok: boolean; detail: string } {
  if (!config.qdrantUrl || !config.embeddingUrl) {
    return { ok: true, detail: "disabled (no index configured)" };
  }
  if (connected) return { ok: true, detail: `listening on ${CHANNEL}` };
  return { ok: false, detail: lastError ?? "not listening" };
}
