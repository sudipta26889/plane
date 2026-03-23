import { describe, it, expect } from "vitest";
import { buildAuditEntry } from "../audit-log.js";

describe("Audit Log", () => {
  it("builds an audit entry with all fields", () => {
    const entry = buildAuditEntry({
      userId: "user-1",
      clientId: "client-1",
      ipAddress: "127.0.0.1",
      operation: "task.created",
      taskId: "task-1",
      skill: "task.create",
      success: true,
      metadata: { duration_ms: 42 },
    });
    expect(entry.user_id).toBe("user-1");
    expect(entry.client_id).toBe("client-1");
    expect(entry.ip_address).toBe("127.0.0.1");
    expect(entry.operation).toBe("task.created");
    expect(entry.task_id).toBe("task-1");
    expect(entry.skill).toBe("task.create");
    expect(entry.success).toBe(true);
    expect(entry.metadata).toEqual({ duration_ms: 42 });
    expect(entry.error_code).toBeNull();
    expect(entry.error_message).toBeNull();
  });

  it("builds a failure entry with error details", () => {
    const entry = buildAuditEntry({
      userId: "user-1",
      clientId: "client-1",
      ipAddress: "127.0.0.1",
      operation: "auth.failure",
      success: false,
      errorCode: "invalid_token",
      errorMessage: "Token expired",
    });
    expect(entry.success).toBe(false);
    expect(entry.error_code).toBe("invalid_token");
    expect(entry.error_message).toBe("Token expired");
    expect(entry.task_id).toBeNull();
    expect(entry.skill).toBeNull();
  });

  it("handles missing optional fields", () => {
    const entry = buildAuditEntry({
      userId: "user-1",
      clientId: "client-1",
      ipAddress: "127.0.0.1",
      operation: "task.created",
      success: true,
    });
    expect(entry.task_id).toBeNull();
    expect(entry.skill).toBeNull();
    expect(entry.metadata).toBeNull();
  });
});
