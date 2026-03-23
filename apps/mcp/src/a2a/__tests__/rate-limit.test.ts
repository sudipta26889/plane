import { describe, it, expect } from "vitest";
import { getRateLimitKey, RATE_LIMITS, buildRateLimitHeaders } from "../rate-limit.js";

describe("Rate Limiting", () => {
  it("generates correct Redis keys for client", () => {
    expect(getRateLimitKey("client", "cli-123", "minute")).toBe("a2a:rl:client:cli-123:minute");
  });

  it("generates correct Redis keys for user", () => {
    expect(getRateLimitKey("user", "user-456", "hour")).toBe("a2a:rl:user:user-456:hour");
  });

  it("generates correct Redis keys for IP", () => {
    expect(getRateLimitKey("ip", "1.2.3.4", "minute")).toBe("a2a:rl:ip:1.2.3.4:minute");
  });

  it("defines all rate limit tiers", () => {
    expect(RATE_LIMITS.client_per_minute).toBe(60);
    expect(RATE_LIMITS.client_per_hour).toBe(1000);
    expect(RATE_LIMITS.user_per_minute).toBe(100);
    expect(RATE_LIMITS.user_per_hour).toBe(2000);
    expect(RATE_LIMITS.task_create_per_minute).toBe(30);
    expect(RATE_LIMITS.ip_per_minute).toBe(20);
  });

  it("builds rate limit headers", () => {
    const headers = buildRateLimitHeaders({ limit: 60, remaining: 57, resetAt: 1711180800 });
    expect(headers["X-RateLimit-Limit"]).toBe("60");
    expect(headers["X-RateLimit-Remaining"]).toBe("57");
    expect(headers["X-RateLimit-Reset"]).toBe("1711180800");
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("builds rate limit headers with Retry-After when exhausted", () => {
    const headers = buildRateLimitHeaders({ limit: 60, remaining: 0, resetAt: 1711180860 });
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(headers["Retry-After"]).toBeDefined();
  });
});
