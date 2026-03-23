export const A2A_TASK_STATES = [
  "submitted",
  "working",
  "completed",
  "failed",
  "auth_required",
  "canceled",
  "rejected",
] as const;

export type A2aTaskState = (typeof A2A_TASK_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<A2aTaskState> = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

const VALID_TRANSITIONS: Record<string, A2aTaskState[]> = {
  submitted: ["working", "auth_required", "canceled", "failed"],
  working: ["completed", "failed"],
  auth_required: ["submitted", "rejected", "canceled"],
};

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state as A2aTaskState);
}

export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to as A2aTaskState);
}

export interface A2aTask {
  id: number;
  task_id: string;
  context_id: string;
  client_id: string;
  user_id: string;
  workspace_slug: string;
  skill: string;
  input: Record<string, any>;
  state: A2aTaskState;
  state_reason: string | null;
  result: any | null;
  error: any | null;
  requires_approval: boolean;
  idempotency_key: string | null;
  retry_count: number;
  max_retries: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface A2aJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, any>;
}

// Reuse in both handlers.ts and A2A modules
export interface AuthContext {
  userId: string;
  workspaceSlug: string;
  clientId: string;
  scopes: string[];
}

// Standard JSON-RPC + A2A error codes
export const A2A_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_REQUIRED: -32002,
  RATE_LIMITED: -32003,
  APPROVAL_REQUIRED: -32004,
} as const;
