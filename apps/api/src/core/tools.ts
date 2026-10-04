import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { one, query } from "../db.js";
import type { Channel, ResolvedBotConfig } from "./botConfig.js";
import type { LeadField } from "../templates/index.js";
import { queueWebhook } from "./jobs.js";

export type ToolContext = {
  tenantId: string;
  botId: string;
  conversationId: string;
  channel: Channel;
  caller?: string | null;
};

// Something the UI should react to (e.g. show "lead submitted"), streamed alongside text.
export type ToolEvent = { type: "lead_captured"; leadId: string } | { type: "handoff_requested" };

export type ToolOutcome = { result: string; isError?: boolean; event?: ToolEvent };

type ToolDef = Anthropic.Beta.BetaTool;

function fieldSchema(f: LeadField) {
  const base: Record<string, unknown> = { description: f.label };
  if (f.type === "number") return { ...base, type: "number" };
  return { ...base, type: "string" };
}

// Tool definitions are built from the bot config when a conversation starts and frozen on the conversation.
export function buildToolDefs(cfg: ResolvedBotConfig, channel: Channel): ToolDef[] {
  const tools: ToolDef[] = [];
  if (cfg.actions.captureLead) {
    const required = cfg.leadFields.filter((f) => f.required && !((channel === "phone" || channel === "whatsapp") && f.type === "phone")).map((f) => f.key);
    tools.push({
      name: "capture_lead",
      description:
        "Save the visitor's details so the company's team can follow up. Call only after the visitor has given the required details and explicitly agreed to the consent statement.",
      input_schema: {
        type: "object",
        properties: {
          ...Object.fromEntries(cfg.leadFields.map((f) => [f.key, fieldSchema(f)])),
          consent: { type: "boolean", description: "True only if the visitor explicitly agreed to the consent statement." },
          summary: { type: "string", description: "One or two sentences on what the visitor needs." },
        },
        required: [...required, "consent", "summary"],
      },
      eager_input_streaming: true,
    });
  }
  if (cfg.actions.handoff) {
    tools.push({
      name: "handoff_to_human",
      description: "Flag this conversation for a human on the company's team to follow up.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string", description: "Why a human is needed, in one sentence." } },
        required: ["reason"],
      },
      eager_input_streaming: true,
    });
  }
  return tools;
}

function leadValidator(defs: ToolDef[]) {
  const def = defs.find((d) => d.name === "capture_lead");
  const props = (def?.input_schema.properties ?? {}) as Record<string, { type: string }>;
  const required = new Set((def?.input_schema.required as string[]) ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, p] of Object.entries(props)) {
    let s: z.ZodType = p.type === "number" ? z.coerce.number() : p.type === "boolean" ? z.boolean() : z.string().trim().min(1).max(500);
    if (!required.has(key)) s = s.optional();
    shape[key] = s;
  }
  return z.object(shape);
}

export async function runTool(name: string, rawInput: unknown, defs: ToolDef[], ctx: ToolContext): Promise<ToolOutcome> {
  if (!defs.some((d) => d.name === name)) return { result: `Unknown tool ${name}`, isError: true };

  if (name === "capture_lead") {
    const parsed = leadValidator(defs).safeParse(rawInput);
    if (!parsed.success) {
      return { result: `INVALID_INPUT: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, isError: true };
    }
    const { consent, summary, ...fields } = parsed.data as Record<string, unknown>;
    if (consent !== true) {
      return { result: "The visitor has not agreed to the consent statement. Ask for consent before capturing.", isError: true };
    }
    if ((ctx.channel === "phone" || ctx.channel === "whatsapp") && ctx.caller && !fields.phone) fields.phone = ctx.caller;
    fields.summary = summary;
    const lead = await one<{ id: string; created_at: Date }>(
      `INSERT INTO leads(tenant_id, bot_id, conversation_id, fields, consent) VALUES ($1, $2, $3, $4, true) RETURNING id, created_at`,
      [ctx.tenantId, ctx.botId, ctx.conversationId, fields],
    );
    await queueWebhook(ctx.botId, ctx.tenantId, "lead.created", {
      lead_id: lead!.id,
      conversation_id: ctx.conversationId,
      channel: ctx.channel,
      fields,
      consent: true,
      created_at: lead!.created_at,
    });
    return {
      result: "Lead saved. Tell the visitor the team will be in touch, and ask if there's anything else you can help with.",
      event: { type: "lead_captured", leadId: lead!.id },
    };
  }

  if (name === "handoff_to_human") {
    const parsed = z.object({ reason: z.string().min(1).max(500) }).safeParse(rawInput);
    if (!parsed.success) return { result: "INVALID_INPUT: reason is required", isError: true };
    await query("UPDATE conversations SET status = 'handoff', updated_at = now() WHERE id = $1 AND tenant_id = $2", [
      ctx.conversationId,
      ctx.tenantId,
    ]);
    await queueWebhook(ctx.botId, ctx.tenantId, "handoff.requested", {
      conversation_id: ctx.conversationId,
      channel: ctx.channel,
      reason: parsed.data.reason,
    });
    return {
      result:
        "The team has been notified. Tell the visitor someone will follow up, and offer to take their contact details if you don't have them yet.",
      event: { type: "handoff_requested" },
    };
  }

  return { result: `Unknown tool ${name}`, isError: true };
}
