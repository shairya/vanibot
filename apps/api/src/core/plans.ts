import { one, query } from "../db.js";

export type PlanId = "trial" | "starter" | "growth" | "business";

export type Plan = {
  id: PlanId;
  name: string;
  priceLabel: string;
  bots: number;
  conversationsPerMonth: number;
  voiceMinutesPerMonth: number;
  documents: number;
  removeBranding: boolean;
};

// Placeholder limits and prices. Real prices live in Stripe; set the price IDs in .env.
export const plans: Record<PlanId, Plan> = {
  trial: { id: "trial", name: "Free trial", priceLabel: "14 days free", bots: 1, conversationsPerMonth: 200, voiceMinutesPerMonth: 30, documents: 20, removeBranding: false },
  starter: { id: "starter", name: "Starter", priceLabel: "$49/mo", bots: 1, conversationsPerMonth: 1000, voiceMinutesPerMonth: 100, documents: 50, removeBranding: false },
  growth: { id: "growth", name: "Growth", priceLabel: "$199/mo", bots: 3, conversationsPerMonth: 5000, voiceMinutesPerMonth: 1000, documents: 300, removeBranding: true },
  business: { id: "business", name: "Business", priceLabel: "$599/mo", bots: 10, conversationsPerMonth: 25000, voiceMinutesPerMonth: 5000, documents: 2000, removeBranding: true },
};

export function getPlan(id: string): Plan {
  return plans[id as PlanId] ?? plans.trial;
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
    voiceMinutes: get("voice_minute"),
    inputTokens: rows.reduce((s, r) => s + Number(r.input_tokens), 0),
    outputTokens: rows.reduce((s, r) => s + Number(r.output_tokens), 0),
  };
}

export type LimitCheck = { ok: true } | { ok: false; reason: string };

/** Checks whether a tenant may start a new conversation on the given channel. */
export async function canStartConversation(tenantId: string, channel: string): Promise<LimitCheck> {
  const tenant = await one("SELECT plan, plan_status, trial_ends_at FROM tenants WHERE id = $1", [tenantId]);
  if (!tenant) return { ok: false, reason: "Unknown account" };
  if (tenant.plan === "trial" && new Date(tenant.trial_ends_at) < new Date()) return { ok: false, reason: "Trial has ended" };
  if (tenant.plan_status !== "active" && tenant.plan_status !== "trialing") return { ok: false, reason: "Subscription is not active" };
  const plan = getPlan(tenant.plan);
  const usage = await monthUsage(tenantId);
  if (usage.conversations >= plan.conversationsPerMonth) return { ok: false, reason: "Monthly conversation limit reached" };
  if (channel === "phone" && usage.voiceMinutes >= plan.voiceMinutesPerMonth) return { ok: false, reason: "Monthly voice minutes used up" };
  return { ok: true };
}
