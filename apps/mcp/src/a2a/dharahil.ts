import crypto from "node:crypto";
import { config } from "../config.js";

export interface ApprovalRequestInput {
  toolName: string;
  toolArgs: Record<string, any>;
  userId: string;
  taskId: string;
  contextSummary: string;
  agentId?: string;
  /** Identifier of the project the call targets, so the approver sees where it lands. */
  project?: string;
}

export interface ApprovalRequest {
  tenant_id: string;
  app_id: string;
  agent_id: string;
  run_id: string;
  step_id: string;
  tool_name: string;
  tool_args: Record<string, any>;
  tool_args_redacted: Record<string, any>;
  context_summary: string;
  risk_level: string;
  environment: string;
  tags: string[];
  idempotency_key: string;
  metadata: Record<string, string>;
  webhook: { url: string; headers: Record<string, string>; decision_url: string };
}

export interface DecisionResult {
  shouldProceed: boolean;
  shouldReject: boolean;
  shouldRevise: boolean;
  reviseInput: string;
  reason: string;
}

const PROCEED_ACTIONS = new Set(["APPROVED", "ALLOW", "AUTO_ALLOWED"]);

export function buildApprovalRequest(input: ApprovalRequestInput): ApprovalRequest {
  const identifier = input.toolArgs.identifier || "";
  // Stable for one exact call on one task, so a resubmission after a crash or
  // retry is deduplicated by the gateway instead of paging the human twice. The
  // args hash keeps a resumed agent run's NEXT call from matching the previous
  // (already approved) request and sailing through on it.
  const argsHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(input.toolArgs ?? {}))
    .digest("hex")
    .slice(0, 16);
  return {
    tenant_id: config.dharahilTenantId,
    app_id: config.dharahilAppId,
    agent_id: input.agentId || "taskpilot-mcp",
    run_id: input.userId,
    step_id: input.taskId,
    tool_name: input.toolName,
    tool_args: input.toolArgs,
    tool_args_redacted: input.toolArgs,
    context_summary: input.contextSummary,
    risk_level: "HIGH",
    environment: "production",
    tags: ["taskpilot", input.toolName.replace(/_/g, ".")],
    idempotency_key: `taskpilot:${input.taskId}:${input.toolName}:${argsHash}`,
    // The gateway types metadata values as strings.
    metadata: {
      tool: input.toolName,
      task_id: input.taskId,
      ...(identifier ? { identifier: String(identifier) } : {}),
      ...(input.project ? { project: input.project } : {}),
    },
    webhook: {
      url: "",
      headers: {},
      decision_url: `${config.dharahilBaseUrl}/v1/requests`,
    },
  };
}

export function interpretDecision(decision: { action: string; reason?: string; revise_input?: string }): DecisionResult {
  if (PROCEED_ACTIONS.has(decision.action)) {
    return { shouldProceed: true, shouldReject: false, shouldRevise: false, reviseInput: "", reason: "" };
  }

  if (decision.action === "REVISE_REQUESTED") {
    return {
      shouldProceed: false,
      shouldReject: false,
      shouldRevise: true,
      reviseInput: decision.revise_input || decision.reason || "",
      reason: decision.reason || "Revision requested by human",
    };
  }

  let reason = decision.reason || "";
  if (decision.action === "EXPIRED") {
    reason = reason || "Approval request expired — no human response within TTL";
  } else if (decision.action === "ERROR") {
    reason = reason || "DharaHIL gateway error — action blocked for safety";
  } else if (!reason) {
    reason = `Action ${decision.action} — blocked`;
  }

  return { shouldProceed: false, shouldReject: true, shouldRevise: false, reviseInput: "", reason };
}

/**
 * Use LLM to interpret human revision instructions and modify tool args.
 * Reuses the same LLM config as smart-router (from instance_configurations).
 */
export async function applyRevisionInstructions(
  toolName: string,
  originalArgs: Record<string, any>,
  reviseInput: string,
): Promise<Record<string, any>> {
  // Dynamic: smart-router pulls in the database pool, which this module's
  // other exports (and their tests) do not need.
  const OpenAI = (await import("openai")).default;
  const { getLlmConfig, defuseMessages } = await import("../tools/smart-router.js");
  const { apiKey, baseUrl, model } = await getLlmConfig();

  const openai = new OpenAI({ apiKey, baseURL: baseUrl });

  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: defuseMessages([
      {
        role: "system",
        content: `You are a tool argument modifier. Given a tool name, its original arguments (JSON), and human revision instructions, return ONLY the modified arguments as valid JSON. Do not explain. Do not wrap in markdown. Return ONLY the JSON object.`,
      },
      {
        role: "user",
        content: `Tool: ${toolName}
Original args: ${JSON.stringify(originalArgs)}
Human revision instructions: ${reviseInput}

Return the modified args as JSON:`,
      },
    ]),
    // Reasoning tokens count against this; an unset cap left it to the provider.
    max_tokens: 8192,
  });

  const content = response.choices[0]?.message?.content?.trim() || "";
  try {
    return JSON.parse(content);
  } catch {
    console.error("[dharahil] Failed to parse LLM revision response:", content);
    throw new Error(`Could not interpret revision instructions: ${reviseInput}`);
  }
}

export async function submitApproval(request: ApprovalRequest): Promise<{ requestId: string; expiresAt: string }> {
  const response = await fetch(`${config.dharahilBaseUrl}/v1/requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-DHARA-API-KEY": config.dharahilApiKey,
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
          "X-DHARA-API-KEY": config.dharahilApiKey,
        },
      });

      if (response.ok) {
        const data = await response.json() as any;
        if (data.status !== "PENDING") {
          return interpretDecision({ action: data.action || data.status, reason: data.reason || data.last_decision_note, revise_input: data.last_decision_revise_input || data.revise_input });
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
): Promise<DecisionResult> {
  if (!config.dharahilEnabled) {
    return { shouldProceed: true, shouldReject: false, shouldRevise: false, reviseInput: "", reason: "DharaHIL disabled" };
  }

  try {
    const request = buildApprovalRequest(input);
    const { requestId, expiresAt } = await submitApproval(request);

    // Use the gateway's expires_at as-is — the gateway controls TTL, not us
    return await pollForDecision(requestId, expiresAt);
  } catch (err: any) {
    console.error("[dharahil] Approval loop error:", err);
    return { shouldProceed: false, shouldReject: true, shouldRevise: false, reviseInput: "", reason: `Gateway error: ${err.message}` };
  }
}
