import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { one, query } from "../db.js";
import { resolveBotConfig } from "../core/botConfig.js";
import { getConversation, LimitError, startConversation, type BotRow } from "../core/conversations.js";
import { runTurn } from "../core/orchestrator.js";
import { getPlan } from "../core/plans.js";

// Public endpoints used by the embeddable widget. Authenticated by the bot's public key + allowed domains.

function originAllowed(bot: BotRow, req: FastifyRequest): boolean {
  if (!bot.allowed_domains?.length) return true;
  const origin = req.headers.origin ?? req.headers.referer;
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === new URL(config.publicUrl).hostname) return true; // the built-in demo page
  return bot.allowed_domains.some((d) => host === d || host.endsWith("." + d));
}

async function loadBot(req: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply): Promise<BotRow | null> {
  const bot = await one<BotRow>("SELECT id, tenant_id, name, industry, config, is_active, allowed_domains FROM bots WHERE public_key = $1", [
    req.params.key,
  ]);
  if (!bot || !bot.is_active) {
    reply.code(404).send({ error: "This assistant is not available." });
    return null;
  }
  if (!originAllowed(bot, req)) {
    reply.code(403).send({ error: "This assistant is not enabled for this website." });
    return null;
  }
  return bot;
}

export async function widgetRoutes(app: FastifyInstance) {
  app.get<{ Params: { key: string } }>("/v1/widget/:key/config", async (req, reply) => {
    const bot = await loadBot(req, reply);
    if (!bot) return;
    const cfg = resolveBotConfig(bot);
    const tenant = await one("SELECT plan FROM tenants WHERE id = $1", [bot.tenant_id]);
    return {
      botName: cfg.botName,
      companyName: cfg.companyName,
      greeting: cfg.greeting,
      suggestedQuestions: cfg.suggestedQuestions,
      theme: cfg.theme,
      voice: { enabled: cfg.voice.enabled, lang: cfg.voice.lang },
      showBranding: !getPlan(tenant.plan).removeBranding,
    };
  });

  app.post<{ Params: { key: string } }>("/v1/widget/:key/conversations", async (req, reply) => {
    const bot = await loadBot(req, reply);
    if (!bot) return;
    const body = z
      .object({ visitorId: z.string().max(100).optional(), channel: z.enum(["web", "web_voice"]).default("web") })
      .parse(req.body ?? {});
    try {
      const conv = await startConversation(bot, body.channel, { visitorId: body.visitorId });
      return { conversationId: conv.id };
    } catch (err) {
      if (err instanceof LimitError) {
        req.log.warn({ tenant: bot.tenant_id, reason: err.message }, "conversation limit");
        return reply.code(429).send({ error: "This assistant is temporarily unavailable. Please contact the company directly." });
      }
      throw err;
    }
  });

  app.get<{ Params: { key: string; conv: string } }>("/v1/widget/:key/conversations/:conv/messages", async (req, reply) => {
    const bot = await loadBot(req, reply);
    if (!bot) return;
    const conv = await getConversation(req.params.conv, bot.id);
    if (!conv) return reply.code(404).send({ error: "Conversation not found." });
    return query("SELECT role, display_text AS text FROM messages WHERE conversation_id = $1 AND display_text IS NOT NULL ORDER BY id", [conv.id]);
  });

  // Streams the reply as Server-Sent Events: {type:"text"|"tool"|"done"|"error", ...}
  app.post<{ Params: { key: string; conv: string } }>("/v1/widget/:key/conversations/:conv/messages", async (req, reply) => {
    const bot = await loadBot(req, reply);
    if (!bot) return;
    const body = z.object({ text: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Message must be 1 to 2000 characters." });
    const conv = await getConversation(req.params.conv, bot.id);
    if (!conv) return reply.code(404).send({ error: "Conversation not found." });

    reply.hijack();
    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      for await (const ev of runTurn(conv, body.data.text)) {
        if (ev.type === "error") {
          req.log.error({ err: ev.message, conversation: conv.id }, "turn failed");
          continue; // the generator follows with a friendly text event
        }
        send(ev);
      }
    } catch (err) {
      req.log.error(err, "turn crashed");
      send({ type: "text", text: "Sorry, something went wrong." });
      send({ type: "done", text: "" });
    }
    reply.raw.end();
  });
}
