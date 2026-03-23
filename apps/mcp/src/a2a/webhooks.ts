import crypto from "node:crypto";
import { db } from "../db.js";

export const WEBHOOK_EVENTS = [
  "task.created",
  "task.state_changed",
  "task.completed",
  "task.failed",
  "task.canceled",
  "task.rejected",
  "task.approval_required",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const RETRY_BACKOFF = [1000, 5000, 15000, 60000, 300000] as const;

export function signPayload(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hmac}`;
}

export interface WebhookTaskData {
  task_id: string;
  context_id: string;
  skill: string;
  state: string;
  result?: any;
  error?: any;
  created_at: string;
  completed_at?: string | null;
}

export function buildWebhookPayload(event: string, task: WebhookTaskData) {
  return {
    event,
    timestamp: new Date().toISOString(),
    task: {
      id: task.task_id,
      context_id: task.context_id,
      skill: task.skill,
      state: task.state,
      result: task.result || null,
      error: task.error || null,
      created_at: task.created_at,
      completed_at: task.completed_at || null,
    },
  };
}

export async function deliverWebhook(
  url: string,
  secret: string,
  payload: any,
): Promise<{ success: boolean; status?: number; body?: string }> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, secret);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    const responseBody = await response.text().catch(() => "");
    return { success: response.ok, status: response.status, body: responseBody };
  } catch (err: any) {
    return { success: false, body: err.message };
  }
}

export async function queueWebhookDeliveries(
  taskId: string,
  event: string,
  taskData: WebhookTaskData,
  clientId: string,
): Promise<void> {
  try {
    const configs = await db.query(
      `SELECT id, url, secret, events FROM a2a_webhook_configs WHERE client_id = $1 AND active = true`,
      [clientId],
    );

    for (const config of configs.rows) {
      const events = config.events || [];
      if (events.length > 0 && !events.includes(event)) continue;

      const payload = buildWebhookPayload(event, taskData);

      await db.query(
        `INSERT INTO a2a_webhook_deliveries (webhook_config_id, task_id, event, payload, status, next_retry_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [config.id, taskId, event, JSON.stringify(payload)],
      );

      // Fire-and-forget delivery attempt
      deliverWebhook(config.url, config.secret, payload).then(async (result) => {
        if (result.success) {
          await db.query(
            `UPDATE a2a_webhook_deliveries SET status = 'delivered', attempts = 1, last_attempt_at = NOW(), response_status = $1
             WHERE webhook_config_id = $2 AND task_id = $3 AND event = $4 AND status = 'pending'`,
            [result.status, config.id, taskId, event],
          );
        } else {
          const nextRetry = new Date(Date.now() + RETRY_BACKOFF[0]);
          await db.query(
            `UPDATE a2a_webhook_deliveries SET attempts = 1, last_attempt_at = NOW(), next_retry_at = $1, response_status = $2, response_body = $3
             WHERE webhook_config_id = $4 AND task_id = $5 AND event = $6 AND status = 'pending'`,
            [nextRetry, result.status || null, result.body?.substring(0, 1000) || null, config.id, taskId, event],
          );
        }
      }).catch((err) => {
        console.error("[webhooks] Delivery error:", err);
      });
    }
  } catch (err) {
    console.error("[webhooks] Queue error:", err);
  }
}
