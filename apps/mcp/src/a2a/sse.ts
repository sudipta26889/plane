import type { Response } from "express";

export const SSE_MAX_CONNECTION_MS = 5 * 60 * 1000; // 5 minutes
export const SSE_PING_INTERVAL_MS = 15 * 1000; // 15 seconds

export function formatSseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type SseListener = {
  res: Response;
  pingInterval: NodeJS.Timeout;
  maxTimeout: NodeJS.Timeout;
};

class SseManager {
  private listeners = new Map<string, Set<SseListener>>();

  addListener(taskId: string, res: Response): SseListener {
    if (!this.listeners.has(taskId)) {
      this.listeners.set(taskId, new Set());
    }

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Ping interval
    const pingInterval = setInterval(() => {
      res.write(formatSseEvent("ping", { timestamp: new Date().toISOString() }));
    }, SSE_PING_INTERVAL_MS);

    // Max connection timeout
    const maxTimeout = setTimeout(() => {
      res.write(formatSseEvent("final", { reason: "max_connection_time" }));
      res.end();
      this.removeListener(taskId, listener);
    }, SSE_MAX_CONNECTION_MS);

    const listener: SseListener = { res, pingInterval, maxTimeout };
    this.listeners.get(taskId)!.add(listener);

    // Clean up on client disconnect
    res.on("close", () => {
      this.removeListener(taskId, listener);
    });

    return listener;
  }

  removeListener(taskId: string, listener: SseListener): void {
    clearInterval(listener.pingInterval);
    clearTimeout(listener.maxTimeout);
    const set = this.listeners.get(taskId);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(taskId);
      }
    }
  }

  notify(taskId: string, event: string, data: any): void {
    const set = this.listeners.get(taskId);
    if (!set) return;

    const message = formatSseEvent(event, data);
    for (const listener of set) {
      listener.res.write(message);
    }

    // If this is a terminal event, close all connections
    if (
      event === "final" ||
      event === "task.completed" ||
      event === "task.failed" ||
      event === "task.canceled" ||
      event === "task.rejected"
    ) {
      const finalMsg = formatSseEvent("final", data);
      for (const listener of set) {
        if (event !== "final") {
          listener.res.write(finalMsg);
        }
        listener.res.end();
        this.removeListener(taskId, listener);
      }
    }
  }

  hasListeners(taskId: string): boolean {
    const set = this.listeners.get(taskId);
    return set !== undefined && set.size > 0;
  }
}

export const sseManager = new SseManager();
