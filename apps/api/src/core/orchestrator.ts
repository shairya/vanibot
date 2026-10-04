import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { query, withTransaction } from "../db.js";
import type { Channel } from "./botConfig.js";
import { recordUsage } from "./plans.js";
import { formatKnowledge, retrieve } from "./retrieval.js";
import { runTool, type ToolEvent } from "./tools.js";

export type Conversation = {
  id: string;
  tenant_id: string;
  bot_id: string;
  channel: Channel;
  caller: string | null;
  system_prompt: string;
  tools: Anthropic.Beta.BetaTool[];
};

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool"; event: ToolEvent }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

export type ClaudeClient = Pick<Anthropic, "beta">;

let defaultClient: ClaudeClient | null = null;
function getClient(): ClaudeClient {
  if (!defaultClient) defaultClient = new Anthropic();
  return defaultClient;
}

/** For tests: replace the Claude client used when none is passed in. */
export function setClaudeClient(client: ClaudeClient | null) {
  defaultClient = client;
}

const MAX_TOOL_ROUNDS = 4;
const REFUSAL_REPLY = "Sorry, I can't help with that. Is there anything else about our services I can help you with?";
const ERROR_REPLY = "Sorry, I'm having trouble right now. Please try again in a moment.";

type StoredMessage = { role: "user" | "assistant"; content: unknown; display: string | null };

function requestParams(conv: Conversation, messages: Anthropic.Beta.BetaMessageParam[]) {
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: config.llm.model,
    max_tokens: 16000,
    system: conv.system_prompt,
    tools: conv.tools.length ? conv.tools : undefined,
    messages,
    thinking: { type: "adaptive" },
    output_config: { effort: config.llm.effort },
    // Cache the stable prefix (system + tools + earlier turns) across turns.
    cache_control: { type: "ephemeral" },
  };
  return params;
}

/**
 * Runs one visitor turn: retrieve knowledge, call Claude with the conversation's frozen system prompt and tools,
 * run any tool calls, and persist the exact content blocks so the next turn replays history unchanged.
 * Yields text deltas as they stream so web chat and voice can start speaking early.
 */
export async function* runTurn(conv: Conversation, userText: string, client: ClaudeClient = getClient()): AsyncGenerator<TurnEvent> {
  const history = await query<{ role: "user" | "assistant"; content: Anthropic.Beta.BetaContentBlockParam[] }>(
    "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id",
    [conv.id],
  );

  const chunks = await retrieve(conv.tenant_id, conv.bot_id, userText).catch(() => []);
  // Retrieved knowledge goes in the user turn, not the system prompt, so earlier turns stay byte-identical.
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: formatKnowledge(chunks) },
    { type: "text", text: userText },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent },
  ];
  const pending: StoredMessage[] = [{ role: "user", content: userContent, display: userText }];

  let replyText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (round > 0 && replyText && !/\s$/.test(replyText)) {
        replyText += " ";
        yield { type: "text", text: " " };
      }

      const stream = client.beta.messages.stream(requestParams(conv, messages));
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          replyText += event.delta.text;
          yield { type: "text", text: event.delta.text };
        }
      }
      const message = await stream.finalMessage();
      inputTokens += message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
      outputTokens += message.usage.output_tokens;

      if (message.stop_reason === "refusal") {
        // Discard the refused turn; nothing from this visitor message is persisted.
        yield { type: "text", text: (replyText ? "\n\n" : "") + REFUSAL_REPLY };
        yield { type: "done", text: REFUSAL_REPLY };
        await recordUsage(conv.tenant_id, conv.bot_id, "message", 1, inputTokens, outputTokens);
        return;
      }

      const assistantText = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      // Pass content back exactly as received (thinking and tool_use blocks included).
      messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
      pending.push({ role: "assistant", content: message.content, display: assistantText || null });

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const outcome = await runTool(use.name, use.input, conv.tools, {
          tenantId: conv.tenant_id,
          botId: conv.bot_id,
          conversationId: conv.id,
          channel: conv.channel,
          caller: conv.caller,
        }).catch((err: unknown) => ({ result: `Tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true as const }));
        if ("event" in outcome && outcome.event) yield { type: "tool", event: outcome.event };
        results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.result, ...(outcome.isError ? { is_error: true } : {}) });
      }
      // All results for one round go back in a single user message.
      messages.push({ role: "user", content: results });
      pending.push({ role: "user", content: results, display: null });
    }
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    yield { type: "text", text: (replyText ? "\n\n" : "") + ERROR_REPLY };
    yield { type: "done", text: ERROR_REPLY };
    return;
  }

  // If we hit the round limit mid tool loop, drop the unfinished rounds so history ends on a plain assistant turn.
  const endsCleanly = (m: StoredMessage) =>
    m.role === "assistant" && !(m.content as { type: string }[]).some((b) => b.type === "tool_use");
  while (pending.length > 1 && !endsCleanly(pending[pending.length - 1])) pending.pop();
  if (pending.length === 1) {
    yield { type: "done", text: ERROR_REPLY };
    return;
  }

  await withTransaction(async (db) => {
    for (const m of pending) {
      await db.query("INSERT INTO messages(tenant_id, conversation_id, role, content, display_text) VALUES ($1, $2, $3, $4, $5)", [
        conv.tenant_id,
        conv.id,
        m.role,
        JSON.stringify(m.content),
        m.display,
      ]);
    }
    await db.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conv.id]);
  });
  await recordUsage(conv.tenant_id, conv.bot_id, "message", 1, inputTokens, outputTokens);
  yield { type: "done", text: replyText.trim() };
}

/** Collects a whole turn into a single string (used by the phone channel). */
export async function runTurnToText(conv: Conversation, userText: string, client?: ClaudeClient) {
  let text = "";
  const events: TurnEvent[] = [];
  for await (const ev of runTurn(conv, userText, client)) {
    events.push(ev);
    if (ev.type === "done") text = ev.text;
  }
  return { text, events };
}
