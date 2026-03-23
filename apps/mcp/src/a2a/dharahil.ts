import { config } from "../config.js";

export interface ApprovalRequestInput {
  toolName: string;
  toolArgs: Record<string, any>;
  userId: string;
  taskId: string;
  contextSummary: string;
  agentId?: string;
}

export interface ApprovalRequest {
  tool_name: string;
  tool_args: Record<string, any>;
  context: {
    agent_id: string;
    run_id: string;
    step_id: string;
    context_summary: string;
    risk_level: string;
    tags: string[];
    idempotency_key: string;
    metadata: Record<string, string>;
  };
}

export interface DecisionResult {
  shouldProceed: boolean;
  shouldReject: boolean;
  reason: string;
}

const PROCEED_ACTIONS = new Set(["APPROVED", "ALLOW", "AUTO_ALLOWED"]);
const REJECT_ACTIONS = new Set(["REJECTED", "DENY", "EXPIRED", "REVISE_REQUESTED", "ERROR"]);

export function buildApprovalRequest(input: ApprovalRequestInput): ApprovalRequest {
  const identifier = input.toolArgs.identifier || "";
  return {
    tool_name: input.toolName,
    tool_args: input.toolArgs,
    context: {
      agent_id: input.agentId || "taskpilot-mcp",
      run_id: input.userId,
      step_id: input.taskId,
      context_summary: input.contextSummary,
      risk_level: "MEDIUM",
      tags: ["taskpilot", input.toolName.replace("_", "."), "cancel"],
      idempotency_key: `task_move_${identifier}_cancelled_${Date.now()}`,
      metadata: {
        tool: input.toolName,
        identifier,
      },
    },
  };
}

export function interpretDecision(decision: { action: string; reason?: string }): DecisionResult {
  if (PROCEED_ACTIONS.has(decision.action)) {
    return { shouldProceed: true, shouldReject: false, reason: "" };
  }

  let reason = decision.reason || "";
  if (decision.action === "EXPIRED") {
    reason = reason || "Approval request expired — no human response within TTL";
  } else if (decision.action === "ERROR") {
    reason = reason || "DharaHIL gateway error — action blocked for safety";
  } else if (decision.action === "REVISE_REQUESTED") {
    reason = reason || "Revision requested — treated as rejection for task operations";
  } else if (!reason) {
    reason = `Action ${decision.action} — blocked`;
  }

  return { shouldProceed: false, shouldReject: true, reason };
}

export async function submitApproval(request: ApprovalRequest): Promise<{ requestId: string; expiresAt: string }> {
  const response = await fetch(`${config.dharahilBaseUrl}/v1/requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.dharahilApiKey}`,
      "X-Tenant-Id": config.dharahilTenantId,
      "X-App-Id": config.dharahilAppId,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`DharaHIL gateway error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as any;
  if (!data.request_id || !data.expires_at) {
    throw new Error("DharaHIL gateway returned invalid response");
  }

  return { requestId: data.request_id, expiresAt: data.expires_at };
}

export async function pollForDecision(
  requestId: string,
  expiresAt: string,
  pollIntervalMs: number = 3000,
): Promise<DecisionResult> {
  const expiresAtTime = new Date(expiresAt).getTime();

  while (Date.now() < expiresAtTime) {
    try {
      const response = await fetch(`${config.dharahilBaseUrl}/v1/requests/${requestId}`, {
        headers: {
          Authorization: `Bearer ${config.dharahilApiKey}`,
          "X-Tenant-Id": config.dharahilTenantId,
          "X-App-Id": config.dharahilAppId,
        },
      });

      if (response.ok) {
        const data = await response.json() as any;
        if (data.status !== "PENDING") {
          return interpretDecision({ action: data.action || data.status, reason: data.reason });
        }
      }
    } catch (err) {
      console.error("[dharahil] Polling error:", err);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return interpretDecision({ action: "EXPIRED" });
}

export async function runApprovalLoop(
  input: ApprovalRequestInput,
  timeoutMs?: number,
): Promise<DecisionResult> {
  if (!config.dharahilEnabled) {
    return { shouldProceed: true, shouldReject: false, reason: "DharaHIL disabled" };
  }

  try {
    const request = buildApprovalRequest(input);
    const { requestId, expiresAt } = await submitApproval(request);

    // Apply local timeout cap if specified
    let effectiveExpiresAt = expiresAt;
    if (timeoutMs) {
      const localExpiry = new Date(Date.now() + timeoutMs).toISOString();
      if (new Date(localExpiry) < new Date(expiresAt)) {
        effectiveExpiresAt = localExpiry;
      }
    }

    return await pollForDecision(requestId, effectiveExpiresAt);
  } catch (err: any) {
    console.error("[dharahil] Approval loop error:", err);
    return { shouldProceed: false, shouldReject: true, reason: `Gateway error: ${err.message}` };
  }
}
