import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { publishMock, onHandlers, connectMock } = vi.hoisted(() => ({
  publishMock: vi.fn(),
  onHandlers: new Map<string, (arg?: any) => void>(),
  connectMock: vi.fn(),
}));

vi.mock("mqtt", () => ({
  default: {
    connect: (...args: any[]) => {
      connectMock(...args);
      return {
        connected: true,
        publish: publishMock,
        on: (event: string, handler: any) => onHandlers.set(event, handler),
        once: (event: string, handler: any) => onHandlers.set(event, handler),
      };
    },
  },
}));

import { publish, TOPIC } from "../mqtt.js";

beforeEach(() => {
  publishMock.mockReset();
  connectMock.mockReset();
  // onHandlers is deliberately NOT cleared: the client is module-cached, so it
  // connects once for the whole file and clearing would erase the very
  // registration this file asserts on.
  publishMock.mockImplementation((_t: string, _b: string, _o: any, cb: any) => cb?.(null));
});

afterEach(() => vi.unstubAllEnvs());

describe("publish", () => {
  it("stamps every message with an origin so ingest can drop its own traffic", async () => {
    // Without this a future ingest rule matching taskpilot/# would create a
    // task about creating a task, forever.
    await publish(TOPIC.taskCreated, { identifier: "ACME-1" });

    const [topic, body] = publishMock.mock.calls[0]!;
    expect(topic).toBe("taskpilot/task/created");
    expect(JSON.parse(body).origin).toBe("taskpilot-mcp");
  });

  it("timestamps messages", async () => {
    await publish(TOPIC.agentRun, { taskId: "t1" });
    expect(JSON.parse(publishMock.mock.calls[0]![1]).at).toBeDefined();
  });

  it("publishes health retained so a late subscriber still learns the state", async () => {
    await publish(TOPIC.health, { status: "ok" }, { retain: true });
    expect(publishMock.mock.calls[0]![2]).toMatchObject({ retain: true });
  });

  it("does not retain ordinary events", async () => {
    await publish(TOPIC.taskCreated, { identifier: "ACME-2" });
    expect(publishMock.mock.calls[0]![2]).toMatchObject({ retain: false });
  });

  it("swallows a broker error rather than failing the caller's request", async () => {
    // Every publish sits on a request path that must succeed whether or not
    // the house is listening.
    publishMock.mockImplementation((_t: string, _b: string, _o: any, cb: any) =>
      cb?.(new Error("broker gone")),
    );
    await expect(publish(TOPIC.taskCreated, { identifier: "ACME-3" })).resolves.toBeUndefined();
  });

  it("registers an error listener, or an EventEmitter error would crash the process", async () => {
    await publish(TOPIC.taskCreated, {});
    expect(onHandlers.has("error")).toBe(true);
  });
});
