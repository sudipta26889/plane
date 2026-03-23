import { db } from "../db.js";

export interface AuditEntryInput {
  userId: string;
  clientId: string;
  ipAddress: string;
  operation: string;
  taskId?: string;
  skill?: string;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, any>;
}

export interface AuditEntry {
  user_id: string;
  client_id: string;
  ip_address: string;
  operation: string;
  task_id: string | null;
  skill: string | null;
  success: boolean;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, any> | null;
}

export function buildAuditEntry(input: AuditEntryInput): AuditEntry {
  return {
    user_id: input.userId,
    client_id: input.clientId,
    ip_address: input.ipAddress,
    operation: input.operation,
    task_id: input.taskId ?? null,
    skill: input.skill ?? null,
    success: input.success,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
    metadata: input.metadata ?? null,
  };
}

export async function logAuditEvent(input: AuditEntryInput): Promise<void> {
  const entry = buildAuditEntry(input);
  try {
    await db.query(
      `INSERT INTO a2a_audit_logs (user_id, client_id, ip_address, operation, task_id, skill, success, error_code, error_message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.user_id,
        entry.client_id,
        entry.ip_address,
        entry.operation,
        entry.task_id,
        entry.skill,
        entry.success,
        entry.error_code,
        entry.error_message,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
  } catch (err) {
    console.error("[a2a] Failed to log audit event:", err);
  }
}
