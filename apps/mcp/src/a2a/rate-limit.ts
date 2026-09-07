import Redis from "ioredis";
import { config } from "../config.js";

export const RATE_LIMITS = {
  client_per_minute: 60,
  client_per_hour: 1000,
  user_per_minute: 100,
  user_per_hour: 2000,
  task_create_per_minute: 30,
  ip_per_minute: 20,
} as const;

const WINDOW_TTL: Record<string, number> = {
  minute: 60,
  hour: 3600,
};

export function getRateLimitKey(scope: string, id: string, window: string): string {
  return `a2a:rl:${scope}:${id}:${window}`;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export function buildRateLimitHeaders(result: { limit: number; remaining: number; resetAt: number }): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetAt),
  };
  if (result.remaining <= 0) {
    const retryAfter = Math.max(0, result.resetAt - Math.floor(Date.now() / 1000));
    headers["Retry-After"] = String(retryAfter);
  }
  return headers;
}

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(config.redisUrl);
    // ioredis emits 'error' on connection drops, and an EventEmitter 'error'
    // with no listener crashes the process. This client sits on the
    // authenticated path of every A2A call, so without this a Redis blip takes
    // the server down rather than degrading it.
    redisClient.on("error", (err) => {
      console.warn("[rate-limit] Redis error:", err.message);
    });
  }
  return redisClient;
}

async function checkSingleLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  const ttl = await redis.ttl(key);
  const resetAt = Math.floor(Date.now() / 1000) + Math.max(ttl, 0);
  const remaining = Math.max(0, limit - count);
  return { allowed: count <= limit, limit, remaining, resetAt };
}

export async function checkRateLimit(
  clientId: string | null,
  userId: string | null,
  ipAddress: string,
  isTaskCreate: boolean = false,
): Promise<RateLimitResult> {
  const redis = getRedis();
  let strictest: RateLimitResult = { allowed: true, limit: 0, remaining: Infinity, resetAt: 0 };

  const checks: Array<{ key: string; limit: number; window: string }> = [];

  if (clientId) {
    checks.push({ key: getRateLimitKey("client", clientId, "minute"), limit: RATE_LIMITS.client_per_minute, window: "minute" });
    checks.push({ key: getRateLimitKey("client", clientId, "hour"), limit: RATE_LIMITS.client_per_hour, window: "hour" });
  }

  if (userId) {
    checks.push({ key: getRateLimitKey("user", userId, "minute"), limit: RATE_LIMITS.user_per_minute, window: "minute" });
    checks.push({ key: getRateLimitKey("user", userId, "hour"), limit: RATE_LIMITS.user_per_hour, window: "hour" });
  }

  if (isTaskCreate && clientId) {
    checks.push({ key: getRateLimitKey("task_create", clientId, "minute"), limit: RATE_LIMITS.task_create_per_minute, window: "minute" });
  }

  if (!clientId && !userId) {
    checks.push({ key: getRateLimitKey("ip", ipAddress, "minute"), limit: RATE_LIMITS.ip_per_minute, window: "minute" });
  }

  for (const { key, limit, window } of checks) {
    const result = await checkSingleLimit(redis, key, limit, WINDOW_TTL[window]);
    if (!result.allowed || result.remaining < strictest.remaining) {
      strictest = result;
    }
  }

  if (strictest.limit === 0 && checks.length > 0) {
    strictest = await checkSingleLimit(redis, checks[0].key, checks[0].limit, WINDOW_TTL[checks[0].window]);
  }

  return strictest;
}

/**
 * Consume one unit of an arbitrary quota.
 *
 * Exposed for callers outside the A2A request path — MQTT ingest, which needs
 * a per-rule limit and a global hourly ceiling — so they reuse this module's
 * Redis client and its 'error' listener rather than opening their own.
 */
export async function consumeQuota(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  return await checkSingleLimit(getRedis(), key, limit, windowSeconds);
}
