import { config } from "../config.js";

/**
 * Client for the longmemory-hydrograph MCP server — the agent's durable memory.
 *
 * This replaces what would otherwise be a local facts table. That table could
 * record when a fact was written but never when it stopped being true; this
 * service models supersession and contradictions directly, which is the gap the
 * agent-surface audit left open.
 *
 * There is deliberately NO local fallback. A fallback that quietly serves an
 * empty store would make "the agent remembers nothing" look identical to "the
 * agent has nothing to remember" — the exact silent-degradation shape that hid
 * a dead LLM endpoint in this codebase for months. When memory is unreachable,
 * calls fail, the loop proceeds without memory, and /health says so.
 */

// Recall is on the request path, ahead of the model call, so it must not eat the
// whole budget. Ingest is fire-and-forget and gets the same ceiling.
const TIMEOUT_MS = 15_000;

/** Recall modes the server accepts. Anything else is rejected with -32602. */
export type RecallMode = "strict" | "historical" | "associative" | "world_grounded";

export function isConfigured(): boolean {
  return Boolean(config.longmemoryUrl && config.longmemoryApiKey);
}

/**
 * The server answers MCP over SSE: `event: message` followed by `data: {...}`.
 * A plain JSON.parse of the body fails, so pull the data lines out first.
 */
export function parseSseJson(body: string): any | null {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      return JSON.parse(trimmed.slice(5).trim());
    } catch {
      // keep scanning; a non-JSON data line is not fatal
    }
  }
  return null;
}

/** Pull the text payload out of an MCP tool result. */
export function extractToolText(payload: any): string {
  const content = payload?.result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!isConfigured()) throw new Error("LONGMEMORY_URL/LONGMEMORY_API_KEY are not configured");

  const response = await fetch(config.longmemoryUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${config.longmemoryApiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`longmemory ${name} failed: HTTP ${response.status}`);
  }

  const payload = parseSseJson(await response.text());
  if (payload?.error) {
    throw new Error(`longmemory ${name} error: ${payload.error.message ?? "unknown"}`);
  }
  return extractToolText(payload);
}

/** Recall memories relevant to a query. Returns "" when nothing is found. */
export async function recall(query: string, mode: RecallMode = "strict"): Promise<string> {
  return callTool("longmemory_recall", { query, mode });
}

/** Store an observation. Fire-and-forget: a memory write must never fail a user's request. */
export async function ingest(text: string, source = "taskpilot-a2a"): Promise<void> {
  try {
    await callTool("longmemory_ingest", { text, source });
  } catch (err: any) {
    console.warn(`[longmemory] ingest skipped: ${err.message}`);
  }
}

/**
 * Recall for prompt injection, bounded.
 *
 * Injected rather than exposed only as a tool: a tool fires when the model
 * already suspects the answer is remembered, and memory matters most when
 * nothing in the question advertises that.
 */
const MAX_INJECTED_CHARS = 2000;

export async function recallForPrompt(query: string): Promise<string> {
  if (!isConfigured()) return "";
  try {
    const text = await recall(query, "strict");
    if (!text.trim()) return "";
    return text.slice(0, MAX_INJECTED_CHARS);
  } catch (err: any) {
    // Degraded, and visible: /health probes the same service.
    console.warn(`[longmemory] recall unavailable: ${err.message}`);
    return "";
  }
}

/** Liveness probe for /health. Throws on failure so the probe reports it. */
export async function ping(): Promise<string> {
  if (!isConfigured()) throw new Error("LONGMEMORY_URL/LONGMEMORY_API_KEY are not configured");

  const response = await fetch(config.longmemoryUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${config.longmemoryApiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "taskpilot-mcp", version: "1.0" } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = parseSseJson(await response.text());
  const server = payload?.result?.serverInfo;
  if (!server?.name) throw new Error("no serverInfo in initialize response");
  return `${server.name} ${server.version ?? ""}`.trim();
}
