import { one } from "../db.js";
import { buildSystemPrompt, resolveBotConfig, type Channel } from "./botConfig.js";
import type { Conversation } from "./orchestrator.js";
import { canStartConversation, recordUsage } from "./plans.js";
import { buildToolDefs } from "./tools.js";

export type BotRow = {
  id: string;
  tenant_id: string;
  name: string;
  industry: string;
  config: any;
  is_active: boolean;
  allowed_domains: string[];
};

export class LimitError extends Error {}

export async function startConversation(
  bot: BotRow,
  channel: Channel,
  opts: { visitorId?: string; caller?: string; externalId?: string } = {},
): Promise<Conversation> {
  const check = await canStartConversation(bot.tenant_id, channel);
  if (!check.ok) throw new LimitError(check.reason);
  const cfg = resolveBotConfig(bot);
  const conv = await one<Conversation>(
    `INSERT INTO conversations(tenant_id, bot_id, channel, visitor_id, caller, external_id, system_prompt, tools)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, tenant_id, bot_id, channel, caller, system_prompt, tools`,
    [
      bot.tenant_id,
      bot.id,
      channel,
      opts.visitorId ?? null,
      opts.caller ?? null,
      opts.externalId ?? null,
      buildSystemPrompt(cfg, channel),
      JSON.stringify(buildToolDefs(cfg, channel)),
    ],
  );
  await recordUsage(bot.tenant_id, bot.id, "conversation");
  return conv!;
}

export async function getConversation(id: string, botId: string): Promise<(Conversation & { status: string }) | undefined> {
  return one("SELECT id, tenant_id, bot_id, channel, caller, system_prompt, tools, status FROM conversations WHERE id = $1 AND bot_id = $2", [
    id,
    botId,
  ]);
}
