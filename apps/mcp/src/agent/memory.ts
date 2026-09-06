import type OpenAI from "openai";
import { db } from "../db.js";

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

// Bounded so a long-lived context can't grow the prompt without limit.
const DEFAULT_CONVERSATION_TURNS = 20;
const MAX_CONVERSATION_TURNS = 50;

// Bounded for the same reason: recallFacts is a DB fetch limit, the two
// below cap what formatMemoryForPrompt is willing to render regardless of
// how many facts (or how long) are passed in.


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

// Durable facts deliberately do NOT live here. They live in the
// longmemory-hydrograph service (agent/longmemory.ts), which models
// supersession and contradictions — things a local facts table could not
// express, since it could record when a fact was written but never when it
// stopped being true. Keeping a second local store would give two recall paths
// that drift, and the one that drifts is the one that stops being true.
