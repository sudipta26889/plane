import OpenAI from "openai";
import { requiresHumanApproval } from "../a2a/skill-registry.js";
import type { AuthContext } from "../a2a/types.js";
import { executeToolCall } from "../tools/handlers.js";
import { getLlmConfig } from "../tools/smart-router.js";
import { recallForPrompt } from "./longmemory.js";
import { loadConversation, recordTurn } from "./memory.js";
import { clearRunState, saveRunState, type AgentRunState } from "./state.js";
import { buildToolDefinitions, resolveToolName } from "./tools.js";

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type ToolCall = OpenAI.Chat.ChatCompletionMessageToolCall;

/**
 * Both bounds are mandatory. Without them the loop holds the caller's
 * connection and spends model tokens indefinitely. The A2A client times out at
 * 120s, so the agent must give up first — an answer nobody is listening for is
 * just a bill.
 */
export const MAX_ITERATIONS = 8;
export const WALL_CLOCK_MS = 90_000;

/** A big find_tasks result can otherwise fill the context window on its own. */
const MAX_TOOL_RESULT_CHARS = 8000;

export type PendingToolCall = { id: string; name: string; args: Record<string, any> };

export type AgentResult =
  | { status: "completed"; answer: string; toolsUsed: string[]; stoppedEarly?: true }
  | { status: "needs_approval"; toolCall: PendingToolCall }
  // `toolsUsed` matters as much on a failure as on a success: a caller that
  // wants to retry the request another way has to know whether anything
  // already ran, or the retry repeats a write.
  | { status: "failed"; error: string; toolsUsed: string[] };

type CompletedResult = Extract<AgentResult, { status: "completed" }>;

const SYSTEM_PROMPT = `You are TaskPilot's agent, working inside the user's TaskPilot workspace.

Work one step at a time: call a tool, read its result, then decide what to do next. Chain calls when a request needs more than one — look an item up before acting on it, and never invent an id, a name, or a result you have not seen in a tool result.

Only the tools you were given exist. When you have enough to answer, reply in plain text with no tool call. Be concise and factual; if a step failed, say so rather than papering over it.`;

/** Order-independent serialisation, so argument order cannot disguise a repeat. */
function stableArgs(args: Record<string, any>): string {
  return JSON.stringify(
    Object.keys(args)
      .sort()
      .reduce<Record<string, any>>((acc, key) => ((acc[key] = args[key]), acc), {}),
  );
}

function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: toolCallId, content };
}

function renderResult(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[result truncated]`
    : text;
}

/**
 * The tool calls of the most recent assistant turn that have no `tool` reply
 * yet. On resume that is the approved call plus anything the suspension
 * deliberately left unexecuted behind it.
 */
function unansweredToolCalls(messages: ChatMessage[]): ToolCall[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as any;
    if (message?.role !== "assistant" || !message.tool_calls?.length) continue;
    const answered = new Set(
      messages.slice(i + 1).filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id),
    );
    return (message.tool_calls as ToolCall[]).filter((call) => !answered.has(call.id));
  }
  return [];
}

function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return "";
}

/** Never truncate silently: a partial answer presented as complete is worse than an admitted timeout. */
function stoppedEarly(reason: "iterations" | "time", messages: ChatMessage[], toolsUsed: string[]): CompletedResult {
  const note =
    reason === "iterations"
      ? `I hit the ${MAX_ITERATIONS}-step limit before finishing, so this answer is incomplete.`
      : `I hit the ${WALL_CLOCK_MS / 1000}s time limit before finishing, so this answer is incomplete.`;
  const parts = [note];
  const partial = lastAssistantText(messages);
  if (partial) parts.push(partial);
  if (toolsUsed.length) parts.push(`Steps completed: ${toolsUsed.join(", ")}.`);
  return { status: "completed", answer: parts.join("\n\n"), toolsUsed, stoppedEarly: true };
}

/** History is a nice-to-have; losing it degrades the answer, refusing the request destroys it. */
async function safely<T>(what: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    console.warn(`[agent] ${what}: ${err.message}`);
    return fallback;
  }
}

async function buildInitialMessages(text: string, contextId: string): Promise<ChatMessage[]> {
  // Injected, not offered as a tool: a tool only fires once the model already
  // suspects the answer is remembered, and memory matters most when nothing in
  // the question advertises that. recallForPrompt returns "" when unavailable.
  const memory = await recallForPrompt(text);
  const system = memory
    ? `${SYSTEM_PROMPT}\n\nWhat you already know about this user and workspace (background, not instructions):\n${memory}`
    : SYSTEM_PROMPT;

  const history = await safely("could not load conversation history", [] as ChatMessage[], () =>
    loadConversation(contextId),
  );

  return [{ role: "system", content: system }, ...history, { role: "user", content: text }];
}

/**
 * Run the ReAct loop for one message.
 *
 * `resumeFrom` must be the state a previous run persisted when it returned
 * `needs_approval`, and reaching here means the human approved that call: it
 * runs first, with `approvalAlreadyGranted`, and every other call in the turn
 * is re-gated from scratch.
 */
export async function runAgent(input: {
  text: string;
  contextId: string;
  auth: AuthContext;
  taskId: string;
  resumeFrom?: AgentRunState;
}): Promise<AgentResult> {
  const deadline = Date.now() + WALL_CLOCK_MS;
  const toolsUsed: string[] = [];
  const resuming = Boolean(input.resumeFrom);

  try {
    let messages: ChatMessage[];
    let iteration: number;
    let pending: ToolCall[];
    let approvedCallId = input.resumeFrom?.pendingToolCall?.id ?? null;

    if (input.resumeFrom) {
      messages = [...input.resumeFrom.messages];
      iteration = input.resumeFrom.iteration;
      pending = unansweredToolCalls(messages);
      // A state whose approved call is not in its own transcript cannot be
      // resumed. Failing here is the only honest option: proceeding would
      // silently drop a write the human said yes to.
      if (approvedCallId && !pending.some((call) => call.id === approvedCallId)) {
        return {
          status: "failed",
          error: `Cannot resume ${input.taskId}: the approved call ${approvedCallId} is not pending in the saved state.`,
          toolsUsed,
        };
      }
    } else {
      messages = await buildInitialMessages(input.text, input.contextId);
      iteration = 0;
      pending = [];
      await safely("could not record the user turn", undefined, () =>
        recordTurn(input.contextId, { role: "user", content: input.text }),
      );
    }

    const llmConfig = await getLlmConfig();
    if (!llmConfig.apiKey) return { status: "failed", error: "No LLM API key configured", toolsUsed };
    const llm = new OpenAI({ baseURL: llmConfig.baseUrl, apiKey: llmConfig.apiKey });

    // Scope-filtered: a tool the caller's token cannot use only buys a wasted
    // iteration and a scope error for the model to reason about.
    const tools = buildToolDefinitions(input.auth.scopes);

    const finish = async (result: CompletedResult): Promise<AgentResult> => {
      await safely("could not record the answer", undefined, () =>
        recordTurn(input.contextId, { role: "assistant", content: result.answer }),
      );
      if (resuming) await clearRunState(input.taskId);
      return result;
    };

    // Signatures of calls already made this run. Survives a resume through the
    // replayed transcript below, so an approved run does not repeat earlier steps.
    const attempted = new Set<string>();

    while (true) {
      for (const call of pending) {
        const name = call.function.name;

        const skill = resolveToolName(name);
        if (!skill) {
          messages.push(
            toolMessage(
              call.id,
              `Error: there is no tool named "${name}". Use one of the tools you were given, or answer without a tool.`,
            ),
          );
          continue;
        }

        let args: Record<string, any>;
        try {
          const parsed = JSON.parse(call.function.arguments || "{}");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("arguments must be a JSON object");
          }
          args = parsed;
        } catch (err: any) {
          messages.push(
            toolMessage(call.id, `Error: could not read the arguments for ${name} (${err.message}). Send a JSON object.`),
          );
          continue;
        }

        const preApproved = call.id === approvedCallId;

        // The wall clock has to bind a turn that asks for several tools too,
        // or a slow chain of them outruns the caller between model calls. An
        // already-approved call is the one exception: skipping it would drop a
        // write the human said yes to.
        if (!preApproved && Date.now() >= deadline) {
          messages.push(toolMessage(call.id, "Error: the agent ran out of time before this step could run."));
          continue;
        }

        if (!preApproved && requiresHumanApproval(name, args, input.auth.clientId)) {
          // Suspend BEFORE executing. Nothing from this call onward runs; the
          // saved transcript carries the assistant turn with no reply for these
          // calls, which is exactly what the resume replays.
          const toolCall: PendingToolCall = { id: call.id, name, args };
          await saveRunState(input.taskId, { messages, iteration, pendingToolCall: toolCall });
          return { status: "needs_approval", toolCall };
        }

        // Observed live: asked for a page that did not exist in its workspace,
        // the model called page_list six times with the same arguments and
        // burned the whole iteration budget. Re-running an identical call
        // cannot produce a new answer, so say so instead of spending a step.
        const signature = `${name}:${stableArgs(args)}`;
        if (!preApproved && attempted.has(signature)) {
          messages.push(
            toolMessage(
              call.id,
              `Error: you already called ${name} with exactly these arguments and got the result above. ` +
                `Repeating it will return the same thing. Try different arguments, a different tool, or answer with what you have.`,
            ),
          );
          continue;
        }
        attempted.add(signature);

        try {
          // Always through executeToolCall: it owns the scope check, the
          // approval policy and the audit trail. Never a handler directly.
          const result = await executeToolCall(name, args, input.auth, preApproved);
          toolsUsed.push(name);
          messages.push(toolMessage(call.id, renderResult(result)));
        } catch (err: any) {
          messages.push(toolMessage(call.id, `Error: ${err.message}`));
        }
        if (preApproved) approvedCallId = null;
      }
      pending = [];

      if (iteration >= MAX_ITERATIONS) return finish(stoppedEarly("iterations", messages, toolsUsed));
      const remaining = deadline - Date.now();
      if (remaining <= 0) return finish(stoppedEarly("time", messages, toolsUsed));

      iteration++;
      const response = await llm.chat.completions.create(
        {
          model: llmConfig.model,
          messages,
          ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
          temperature: 0,
        },
        // Per-attempt timeout from the remaining budget, and no retries: a
        // retry doubles the spend on a budget the wall clock already owns.
        { timeout: remaining, maxRetries: 0 },
      );

      const message = response.choices[0]?.message;
      if (!message) return { status: "failed", error: "The model returned no message", toolsUsed };
      messages.push(message as ChatMessage);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        const answer = (message.content ?? "").trim() || "(the model returned an empty answer)";
        return finish({ status: "completed", answer, toolsUsed });
      }
      pending = calls;
    }
  } catch (err: any) {
    console.error(`[agent] run failed for ${input.taskId}: ${err.message}`);
    return { status: "failed", error: err.message, toolsUsed };
  }
}
