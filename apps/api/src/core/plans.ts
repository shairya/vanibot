import { one, query } from "../db.js";

/** What a company can switch on. 'voice' covers voice in the website widget and WhatsApp voice notes (phone calls later). */
export type ChannelId = "web" | "whatsapp" | "voice";
export const ALL_CHANNELS: ChannelId[] = ["web", "whatsapp", "voice"];

export type PlanId = "pilot" | "chat" | "voice" | "chat_voice";

export type Plan = {
  id: PlanId;
  name: string;
  priceLabel: string;
  tagline: string;
  channels: ChannelId[];
  bots: number;
  conversationsPerMonth: number;
  voiceNotesPerMonth: number;
  documents: number;
  removeBranding: boolean;
};

// Placeholder prices for the website. There are no online payments in the pilot; vanibot admins assign plans by hand.
export const plans: Record<PlanId, Plan> = {
  pilot: {
    id: "pilot", name: "Pilot", priceLabel: "Free during pilot", tagline: "Everything on, for pilot companies",
    channels: ["web", "whatsapp", "voice"], bots: 3, conversationsPerMonth: 2000, voiceNotesPerMonth: 1000, documents: 200, removeBranding: true,
  },
  chat: {
    id: "chat", name: "Chat", priceLabel: "₹2,999/month", tagline: "Website chat and WhatsApp text",
    channels: ["web", "whatsapp"], bots: 1, conversationsPerMonth: 1000, voiceNotesPerMonth: 0, documents: 50, removeBranding: false,
  },
  voice: {
    id: "voice", name: "Voice", priceLabel: "₹4,999/month", tagline: "WhatsApp voice notes and website voice",
    channels: ["voice"], bots: 1, conversationsPerMonth: 1000, voiceNotesPerMonth: 2000, documents: 50, removeBranding: false,
  },
  chat_voice: {
    id: "chat_voice", name: "Chat + Voice", priceLabel: "₹6,999/month", tagline: "Every channel, more volume",
    channels: ["web", "whatsapp", "voice"], bots: 3, conversationsPerMonth: 5000, voiceNotesPerMonth: 5000, documents: 300, removeBranding: true,
  },
};

export function getPlan(id: string): Plan {
  return plans[id as PlanId] ?? plans.pilot;
}

export async function recordUsage(tenantId: string, botId: string | null, kind: string, quantity = 1, inputTokens = 0, outputTokens = 0) {
  await query("INSERT INTO usage_events(tenant_id, bot_id, kind, quantity, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6)", [
    tenantId,
    botId,
    kind,
    quantity,
    inputTokens,
    outputTokens,
  ]);
}

export async function monthUsage(tenantId: string) {
  const rows = await query<{ kind: string; total: string; input_tokens: string; output_tokens: string }>(
    `SELECT kind, SUM(quantity) AS total, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
       FROM usage_events WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())
      GROUP BY kind`,
    [tenantId],
  );
  const get = (k: string) => Number(rows.find((r) => r.kind === k)?.total ?? 0);
  return {
    conversations: get("conversation"),
    messages: get("message"),
    voiceNotes: get("voice_note"),
    inputTokens: rows.reduce((s, r) => s + Number(r.input_tokens), 0),
    outputTokens: rows.reduce((s, r) => s + Number(r.output_tokens), 0),
  };
}

export type LimitCheck = { ok: true } | { ok: false; reason: string };

type TenantLimits = { plan: string; status: string; channels: ChannelId[] };

async function loadTenant(tenantId: string) {
  return one<TenantLimits>("SELECT plan, status, channels FROM tenants WHERE id = $1", [tenantId]);
}

/** Which conversation channels need which purchased channel. */
export function requiredChannel(conversationChannel: string): ChannelId[] {
  switch (conversationChannel) {
    case "web":
      return ["web"];
    case "web_voice":
      return ["voice"];
    case "whatsapp":
      return ["whatsapp", "voice"]; // either is enough to open a WhatsApp conversation
    default:
      return ["voice"];
  }
}

/** Checks whether a company may start a new conversation on a channel. */
export async function canStartConversation(tenantId: string, conversationChannel: string): Promise<LimitCheck> {
  const tenant = await loadTenant(tenantId);
  if (!tenant) return { ok: false, reason: "Unknown account" };
  if (tenant.status !== "active") return { ok: false, reason: "Account is suspended" };
  if (!requiredChannel(conversationChannel).some((c) => tenant.channels.includes(c))) {
    return { ok: false, reason: `Channel ${conversationChannel} is not enabled for this account` };
  }
  const usage = await monthUsage(tenantId);
  if (usage.conversations >= getPlan(tenant.plan).conversationsPerMonth) return { ok: false, reason: "Monthly conversation limit reached" };
  return { ok: true };
}

/** Checks whether a company may process another voice note this month. */
export async function canUseVoice(tenantId: string): Promise<LimitCheck> {
  const tenant = await loadTenant(tenantId);
  if (!tenant || tenant.status !== "active") return { ok: false, reason: "Account is not active" };
  if (!tenant.channels.includes("voice")) return { ok: false, reason: "Voice is not enabled for this account" };
  const usage = await monthUsage(tenantId);
  if (usage.voiceNotes >= getPlan(tenant.plan).voiceNotesPerMonth) return { ok: false, reason: "Monthly voice note limit reached" };
  return { ok: true };
}

export async function tenantChannels(tenantId: string): Promise<ChannelId[]> {
  return (await loadTenant(tenantId))?.channels ?? [];
}
