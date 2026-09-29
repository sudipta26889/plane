import { describe, it, expect } from "vitest";
import { buildApprovalRequest, interpretDecision } from "../dharahil.js";

describe("DharaHIL Client", () => {
  it("builds an approval request for task cancellation", () => {
    const req = buildApprovalRequest({
      toolName: "move_task",
      toolArgs: { identifier: "PROJ-42", state: "Cancelled" },
      userId: "user-1",
      taskId: "task-1",
      contextSummary: 'Cancel task PROJ-42: "Fix bug"',
    });
    expect(req.tool_name).toBe("move_task");
    expect(req.tool_args.identifier).toBe("PROJ-42");
    expect(req.agent_id).toBe("taskpilot-mcp");
    expect(req.run_id).toBe("user-1");
    expect(req.step_id).toBe("task-1");
    expect(req.risk_level).toBe("HIGH");
    expect(req.tags).toEqual(["taskpilot", "move.task"]);
    expect(req.idempotency_key).toMatch(/^taskpilot:task-1:move_task:[0-9a-f]{16}$/);
    expect(req.metadata.identifier).toBe("PROJ-42");
    expect(req.tool_args_redacted).toEqual(req.tool_args);
    expect(req.environment).toBe("production");
    expect(req.metadata).toBeDefined();
    expect(req.webhook).toBeDefined();
    expect(req.webhook.url).toBe("");
  });

  // The key is what lets the gateway drop a resubmitted request instead of
  // paging the human twice. It must be stable for one call, and must differ
  // for a different call on the same task — a resumed agent run's next write
  // must never match (and ride on) the approval its previous write got.
  it("keys an approval request by task, tool and exact args", () => {
    const base = { toolName: "create_task", userId: "u", taskId: "task-9", contextSummary: "s" };
    const a = buildApprovalRequest({ ...base, toolArgs: { title: "A" } });
    const again = buildApprovalRequest({ ...base, toolArgs: { title: "A" } });
    const other = buildApprovalRequest({ ...base, toolArgs: { title: "B" } });
    expect(again.idempotency_key).toBe(a.idempotency_key);
    expect(other.idempotency_key).not.toBe(a.idempotency_key);
  });

  it("shows the approver the target project", () => {
    const req = buildApprovalRequest({
      toolName: "page_create",
      toolArgs: { title: "Canary" },
      userId: "u",
      taskId: "t",
      contextSummary: "s",
      project: "GUARDIANAI",
    });
    expect(req.metadata.project).toBe("GUARDIANAI");
    expect(Object.values(req.metadata).every((v) => typeof v === "string")).toBe(true);
  });

  it("interprets APPROVED decision", () => {
    const result = interpretDecision({ action: "APPROVED" });
    expect(result.shouldProceed).toBe(true);
    expect(result.shouldReject).toBe(false);
    expect(result.shouldRevise).toBe(false);
  });

  it("interprets ALLOW decision", () => {
    const result = interpretDecision({ action: "ALLOW" });
    expect(result.shouldProceed).toBe(true);
  });

  it("interprets AUTO_ALLOWED decision", () => {
    const result = interpretDecision({ action: "AUTO_ALLOWED" });
    expect(result.shouldProceed).toBe(true);
  });

  it("interprets REJECTED decision", () => {
    const result = interpretDecision({ action: "REJECTED", reason: "No" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(true);
    expect(result.shouldRevise).toBe(false);
    expect(result.reason).toBe("No");
  });

  it("interprets DENY decision", () => {
    const result = interpretDecision({ action: "DENY", reason: "Nope" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(true);
  });

  it("interprets EXPIRED as rejection", () => {
    const result = interpretDecision({ action: "EXPIRED" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(true);
    expect(result.reason).toContain("expired");
  });

  it("interprets REVISE_REQUESTED as revision with instructions", () => {
    const result = interpretDecision({ action: "REVISE_REQUESTED", revise_input: "Move to Done instead" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(false);
    expect(result.shouldRevise).toBe(true);
    expect(result.reviseInput).toBe("Move to Done instead");
  });

  it("interprets REVISE_REQUESTED with reason fallback", () => {
    const result = interpretDecision({ action: "REVISE_REQUESTED", reason: "Change the state" });
    expect(result.shouldRevise).toBe(true);
    expect(result.reviseInput).toBe("Change the state");
  });

  it("interprets ERROR as rejection (fail-closed)", () => {
    const result = interpretDecision({ action: "ERROR" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(true);
  });

  it("interprets unknown action as rejection (fail-closed)", () => {
    const result = interpretDecision({ action: "UNKNOWN_THING" });
    expect(result.shouldProceed).toBe(false);
    expect(result.shouldReject).toBe(true);
  });
});
