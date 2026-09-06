import Redis from "ioredis";
import { db } from "./db.js";
import { config } from "./config.js";
import { getLlmConfig } from "./tools/smart-router.js";
import { getIndexSyncStatus } from "./a2a/background.js";

/**
 * Real dependency checks behind /health.
 *
 * Every dependency here has a fallback somewhere in the codebase: the router
 * drops to neighbour evidence without the LLM, dedupe is skipped without Qdrant,
 * routing confidence is capped without embeddings. Those fallbacks keep the
 * server answering, which is exactly how a dead LLM endpoint went unnoticed for
 * months. This endpoint exists so the degradation is visible from outside:
 * anything unhealthy makes /health return 503 instead of quietly coping.
 */

export interface DependencyStatus {
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  status: "ok" | "degraded";
  server: string;
  dependencies: Record<string, DependencyStatus>;
}

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;

let cached: { report: HealthReport; at: number } | null = null;

/** Roll individual probes up: one failure degrades the whole server. */
export function summarize(dependencies: Record<string, DependencyStatus>): "ok" | "degraded" {
  return Object.values(dependencies).every((dependency) => dependency.ok) ? "ok" : "degraded";
}

async function probe(name: string, fn: () => Promise<string>): Promise<DependencyStatus> {
  try {
    return { ok: true, detail: await fn() };
  } catch (err: any) {
    return { ok: false, detail: err?.message ? String(err.message).slice(0, 200) : `${name} failed` };
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response;
}

export async function checkDependencies(force = false): Promise<HealthReport> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;

  const [database, llm, qdrant, redis, embeddings] = await Promise.all([
    probe("database", async () => {
      await db.query("SELECT 1");
      return "reachable";
    }),

    // The check that would have caught the dead IP: prove the configured base
    // URL answers AND the key is accepted, not merely that a value is set.
    probe("llm", async () => {
      const llmConfig = await getLlmConfig();
      if (!llmConfig.apiKey) throw new Error("LLM_API_KEY is not configured");
      await getJson(`${llmConfig.baseUrl.replace(/\/$/, "")}/v1/models`, {
        Authorization: `Bearer ${llmConfig.apiKey}`,
      });
      return `${llmConfig.baseUrl} (${llmConfig.model})`;
    }),

    probe("qdrant", async () => {
      if (!config.qdrantUrl) throw new Error("QDRANT_URL is not configured");
      const headers: Record<string, string> = {};
      if (config.qdrantApiKey) headers["api-key"] = config.qdrantApiKey;
      await getJson(
        `${config.qdrantUrl.replace(/\/$/, "")}/collections/${config.qdrantCollection}`,
        headers,
      );
      return `${config.qdrantCollection} present`;
    }),

    // Redis backs both the project cache and A2A rate limiting, so it is on
    // the routing hot path and the authenticated path. It was the one
    // dependency with a fallback and no probe.
    probe("redis", async () => {
      const client = new Redis(config.redisUrl, {
        lazyConnect: true,
        connectTimeout: PROBE_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
      });
      client.on("error", () => {});
      try {
        await client.connect();
        await client.ping();
        return "reachable";
      } finally {
        client.disconnect();
      }
    }),

    probe("embeddings", async () => {
      if (!config.embeddingUrl) throw new Error("EMBEDDING_DIRECT_URL is not configured");
      // EMBEDDING_DIRECT_URL points at /embed; the server's health lives at /health.
      const base = config.embeddingUrl.replace(/\/embed\/?$/, "");
      await getJson(`${base}/health`);
      return `${base} reachable`;
    }),
  ]);

  // Not a probe: the index sync reports its own last outcome, so a job that
  // fails every tick surfaces here instead of only in the logs.
  const dependencies = { database, llm, qdrant, redis, embeddings, indexSync: getIndexSyncStatus() };
  const report: HealthReport = {
    status: summarize(dependencies),
    server: "taskpilot-mcp",
    dependencies,
  };

  cached = { report, at: Date.now() };
  return report;
}

/**
 * Public view of a health report: which dependencies exist and whether each is
 * up, without the detail strings. Those carry internal hostnames, the model
 * name, the collection name, and raw connection errors including internal IPs
 * — fine for an authenticated operator, not for an endpoint on the same public
 * host as the agent card.
 */
export function redactHealthReport(report: HealthReport): HealthReport {
  const dependencies: Record<string, DependencyStatus> = {};
  for (const [name, status] of Object.entries(report.dependencies)) {
    dependencies[name] = { ok: status.ok, detail: status.ok ? "ok" : "unavailable" };
  }
  return { ...report, dependencies };
}

let lastStatus: "ok" | "degraded" | null = null;

/**
 * Periodic check that shouts on transitions. /health only speaks when polled;
 * this puts the change in the log at the moment it happens.
 */
export async function reportHealthTransitions() {
  const report = await checkDependencies(true);

  if (report.status !== lastStatus) {
    const broken = Object.entries(report.dependencies)
      .filter(([, dependency]) => !dependency.ok)
      .map(([name, dependency]) => `${name}: ${dependency.detail}`);

    if (report.status === "degraded") {
      console.error(`[health] DEGRADED — ${broken.join("; ")}`);
      console.error("[health] Routing quality is reduced while this persists.");
    } else if (lastStatus !== null) {
      console.log("[health] Recovered — all dependencies reachable");
    }
    lastStatus = report.status;
  }
}
