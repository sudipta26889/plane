import type OpenAI from "openai";
import { db } from "../db.js";

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

// Bounded so a long-lived context can't grow the prompt without limit.
const DEFAULT_CONVERSATION_TURNS = 20;
const MAX_CONVERSATION_TURNS = 50;

// Bounded for the same reason: recallFacts is a DB fetch limit, the two
// below cap what formatMemoryForPrompt is willing to render regardless of
// how many facts (or how long) are passed in.
const DEFAULT_FACT_LIMIT = 20;
const MAX_FACT_LIMIT = 50;
export const MAX_FACTS_IN_PROMPT = 20;
export const MAX_PROMPT_CHARS = 2000;

export interface StoredFact {
  id: number;
  fact: string;
  source: string | null;
  createdAt: Date;
}

interface ConversationRow {
  role: string;
  content: string | null;
  tool_calls: unknown;
  tool_call_id: string | null;
  name: string | null;
}

function extractContent(message: ChatMessage): string | null {
  if (typeof message.content === "string") return message.content;
  if (message.content == null) return null;
  // ponytail: multi-part content is not produced by this loop today; store
  // it as JSON rather than adding columns for a case that doesn't occur.
  return JSON.stringify(message.content);
}

function rowToMessage(row: ConversationRow): ChatMessage {
  const message: Record<string, unknown> = { role: row.role, content: row.content };
  if (row.tool_calls) message.tool_calls = row.tool_calls;
  if (row.tool_call_id) message.tool_call_id = row.tool_call_id;
  if (row.name) message.name = row.name;
  return message as unknown as ChatMessage;
}

/** Append one message to a context's conversation history. */
export async function recordTurn(contextId: string, message: ChatMessage): Promise<void> {
  const content = extractContent(message);
  const toolCalls = "tool_calls" in message && message.tool_calls ? JSON.stringify(message.tool_calls) : null;
  const toolCallId = "tool_call_id" in message ? message.tool_call_id : null;
  const name = "name" in message ? (message.name ?? null) : null;

  await db.query(
    `INSERT INTO a2a_conversations (context_id, role, content, tool_calls, tool_call_id, name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [contextId, message.role, content, toolCalls, toolCallId, name],
  );
}

/** Load the most recent `limit` turns for a context, oldest first. Hard-capped regardless of the requested limit. */
export async function loadConversation(
  contextId: string,
  limit: number = DEFAULT_CONVERSATION_TURNS,
): Promise<ChatMessage[]> {
  const boundedLimit = Math.min(limit, MAX_CONVERSATION_TURNS);
  const { rows } = await db.query<ConversationRow>(
    `SELECT role, content, tool_calls, tool_call_id, name
     FROM a2a_conversations
     WHERE context_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [contextId, boundedLimit],
  );
  return rows.reverse().map(rowToMessage);
}

/** Store a durable fact for a user/workspace. Never overwrites or deletes prior facts. */
export async function rememberFact(
  userId: string,
  workspace: string,
  fact: string,
  source?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO a2a_memory (user_id, workspace_slug, fact, source) VALUES ($1, $2, $3, $4)`,
    [userId, workspace, fact, source ?? null],
  );
}

/** Load active (not superseded) facts for a user/workspace, most recent first. Hard-capped regardless of the requested limit. */
export async function recallFacts(
  userId: string,
  workspace: string,
  limit: number = DEFAULT_FACT_LIMIT,
): Promise<StoredFact[]> {
  const boundedLimit = Math.min(limit, MAX_FACT_LIMIT);
  const { rows } = await db.query(
    `SELECT id, fact, source, created_at
     FROM a2a_memory
     WHERE user_id = $1 AND workspace_slug = $2 AND superseded_at IS NULL
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, workspace, boundedLimit],
  );
  return rows.map((r) => ({ id: r.id, fact: r.fact, source: r.source, createdAt: r.created_at }));
}

/**
 * Render facts for injection into the system prompt. Pure and bounded: caps
 * both the number of facts rendered (MAX_FACTS_IN_PROMPT) and the total
 * output length (MAX_PROMPT_CHARS), so accumulated memory can't grow the
 * prompt without limit.
 */
export function formatMemoryForPrompt(facts: StoredFact[]): string {
  if (facts.length === 0) return "";

  const lines = facts.slice(0, MAX_FACTS_IN_PROMPT).map((f) => `- ${f.fact}`);
  const rendered = ["Known facts about this user/workspace:", ...lines].join("\n");
  return rendered.length > MAX_PROMPT_CHARS ? rendered.slice(0, MAX_PROMPT_CHARS) : rendered;
}
