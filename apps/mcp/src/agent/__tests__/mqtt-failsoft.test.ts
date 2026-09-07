import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Deliberately NOT mocked, unlike the sibling test file.
 *
 * `publish` swallows its own errors so a broker outage cannot fail a user's
 * request. That same error handling will just as happily swallow a genuine bug
 * in the publish path — a typo, a bad import, an undefined variable — and
 * everything will look healthy while nothing is ever published.
 *
 * A mocked failure proves only that a stubbed callback was invoked. These tests
 * run the real module: once with the integration switched off, and once against
 * 192.0.2.1 (TEST-NET-1, reserved as unroutable by RFC 5737), so the fail-soft
 * path is genuinely executed rather than simulated.
 */

async function freshModule() {
  vi.resetModules();
  return await import("../mqtt.js");
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("publish is genuinely fail-soft", () => {
  it("no-ops silently when the integration is disabled", async () => {
    vi.stubEnv("MQTT_HOST", "");
    vi.stubEnv("MQTT_USERNAME", "");
    const { publish, TOPIC, isConfigured } = await freshModule();

    expect(isConfigured()).toBe(false);
    // Must resolve, not throw, and must not hang waiting on a client it never made.
    await expect(publish(TOPIC.taskCreated, { identifier: "X-1" })).resolves.toBeUndefined();
  });

  it("survives an unroutable broker without throwing or hanging", async () => {
    // 192.0.2.1 is TEST-NET-1: guaranteed not to route anywhere.
    vi.stubEnv("MQTT_HOST", "192.0.2.1");
    vi.stubEnv("MQTT_PORT", "1883");
    vi.stubEnv("MQTT_USERNAME", "nobody");
    vi.stubEnv("MQTT_PASSWORD", "nothing");
    const { publish, TOPIC } = await freshModule();

    const started = Date.now();
    await expect(publish(TOPIC.agentRun, { taskId: "t-1" })).resolves.toBeUndefined();

    // Bounded by the publish timeout, not by the OS connect timeout. If this
    // ever exceeds it, a user's request is being held open by a dead broker.
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 20_000);

  it("reports an unroutable broker as unhealthy rather than silently fine", async () => {
    vi.stubEnv("MQTT_HOST", "192.0.2.1");
    vi.stubEnv("MQTT_USERNAME", "nobody");
    vi.stubEnv("MQTT_PASSWORD", "nothing");
    const { ping } = await freshModule();

    // The counterpart to fail-soft publishing: if publishing hides the outage,
    // something else has to surface it.
    await expect(ping()).rejects.toThrow();
  }, 20_000);
});

describe("entity keys", () => {
  it("refuses an entity nothing announced, rather than inventing one", async () => {
    vi.stubEnv("MQTT_HOST", "192.0.2.1");
    vi.stubEnv("MQTT_USERNAME", "nobody");
    const { publishEntityState } = await freshModule();

    // A typo should be loud. Silently creating an entity no discovery config
    // describes leaves an orphan in Home Assistant that nothing updates.
    await expect(publishEntityState("availabilty" as any, "online")).rejects.toThrow(/Unknown MQTT entity/);
  });
});
