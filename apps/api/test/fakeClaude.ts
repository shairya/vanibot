import type Anthropic from "@anthropic-ai/sdk";

type Block = Record<string, unknown>;
export type ScriptedReply = { content: Block[]; stop_reason: Anthropic.Beta.BetaMessage["stop_reason"] };

/** A stand-in for client.beta.messages.stream that plays back scripted replies and records each request. */
export function fakeClaude(replies: ScriptedReply[]) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const reply = replies.shift();
          if (!reply) throw new Error("fakeClaude: no scripted reply left");
          const events: any[] = [];
          for (const block of reply.content) {
            if (block.type === "text") {
              for (const piece of String(block.text).match(/.{1,12}/gs) ?? []) {
                events.push({ type: "content_block_delta", delta: { type: "text_delta", text: piece } });
              }
            }
          }
          const message = {
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model: params.model,
            content: reply.content,
            stop_reason: reply.stop_reason,
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
  return { client: client as any, requests };
}
