import { db } from "../db.js";

/**
 * The ReAct loop's state for one task: the full message history (including
 * tool results), how many iterations it has run, and the write it is
 * waiting on approval for, if any.
 *
 * The whole message array is persisted, not just the user's original text,
 * because resuming needs the model's own reasoning so far — the tool results
 * that led it to want this write. Replaying only the input would make the
 * model re-derive that reasoning, possibly differently, after approval.
 */
export type AgentRunState = {
  messages: any[];
  iteration: number;
  pendingToolCall: { id: string; name: string; args: Record<string, any> } | null;
};

interface RunStateRow {
  state: AgentRunState;
}

/** Persist (or overwrite) a run's state, keyed by task id. */
export async function saveRunState(taskId: string, state: AgentRunState): Promise<void> {
  await db.query(
    `INSERT INTO a2a_agent_runs (task_id, state, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (task_id) DO UPDATE SET state = $2, updated_at = NOW()`,
    [taskId, JSON.stringify(state)],
  );
}

/** Load a run's state, or null if this task never suspended (or already resumed). */
export async function loadRunState(taskId: string): Promise<AgentRunState | null> {
  const { rows } = await db.query<RunStateRow>(`SELECT state FROM a2a_agent_runs WHERE task_id = $1`, [taskId]);
  return rows[0]?.state ?? null;
}

/** Drop a run's persisted state once it has resumed (or been abandoned). */
export async function clearRunState(taskId: string): Promise<void> {
  await db.query(`DELETE FROM a2a_agent_runs WHERE task_id = $1`, [taskId]);
}
