import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import twilio from "twilio";
import { config } from "../config.js";
import { asSystem, one, setRequestTenant } from "../db.js";
import { resolveBotConfig } from "../core/botConfig.js";
import { getConversation, LimitError, startConversation, type BotRow } from "../core/conversations.js";
import { runTurnToText } from "../core/orchestrator.js";
import { recordUsage } from "../core/plans.js";

// Phone voice bot over Twilio Programmable Voice.
// Point a Twilio number's "A call comes in" webhook at  {PUBLIC_URL}/v1/voice/twilio/incoming  (HTTP POST)
// and its status callback at {PUBLIC_URL}/v1/voice/twilio/status. Twilio does speech-to-text (<Gather>)
// and text-to-speech (<Say>); vanibot supplies the conversation.

type TwilioBody = Record<string, string>;

function xmlEscape(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

function twiml(reply: FastifyReply, inner: string) {
  reply.header("content-type", "text/xml");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function verifyTwilio(req: FastifyRequest): boolean {
  if (!config.phone.twilioAuthToken) return true; // local development without Twilio credentials
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;
  return twilio.validateRequest(config.phone.twilioAuthToken, signature, config.publicUrl + req.url, req.body as TwilioBody);
}

function gather(conversationId: string, lang: string, voice: string, say: string) {
  const action = xmlEscape(`${config.publicUrl}/v1/voice/twilio/turn?conversation=${conversationId}`);
  return (
    `<Gather input="speech" action="${action}" method="POST" speechTimeout="auto" language="${xmlEscape(lang)}">` +
    `<Say voice="${xmlEscape(voice)}" language="${xmlEscape(lang)}">${xmlEscape(say)}</Say></Gather>` +
    // If the caller says nothing, ask once more via the same turn endpoint with an empty result.
    `<Redirect method="POST">${action}&amp;silence=1</Redirect>`
  );
}

export async function voiceRoutes(app: FastifyInstance) {
  app.post("/v1/voice/twilio/incoming", async (req, reply) => {
    if (!verifyTwilio(req)) return reply.code(403).send("Invalid signature");
    const body = req.body as TwilioBody;
    const bot = await asSystem(() =>
      one<BotRow>("SELECT id, tenant_id, name, industry, config, is_active, allowed_domains FROM bots WHERE phone_number = $1 AND is_active", [body.To]),
    );
    if (bot) setRequestTenant(bot.tenant_id);
    if (!bot) return twiml(reply, "<Say>Sorry, this number is not set up yet. Goodbye.</Say><Hangup/>");
    const cfg = resolveBotConfig(bot);
    if (!cfg.voice.enabled || !cfg.channels.voice) return twiml(reply, "<Say>Sorry, phone support is not available. Goodbye.</Say><Hangup/>");
    try {
      const conv = await startConversation(bot, "phone", { caller: body.From, externalId: body.CallSid });
      return twiml(reply, gather(conv.id, cfg.voice.lang, cfg.voice.phoneVoice, cfg.greeting));
    } catch (err) {
      if (err instanceof LimitError) return twiml(reply, "<Say>Sorry, we can't take your call right now. Please try again later.</Say><Hangup/>");
      throw err;
    }
  });

  app.post<{ Querystring: { conversation: string; silence?: string } }>("/v1/voice/twilio/turn", async (req, reply) => {
    if (!verifyTwilio(req)) return reply.code(403).send("Invalid signature");
    const body = req.body as TwilioBody;
    const row = await asSystem(() => one("SELECT bot_id, tenant_id FROM conversations WHERE id = $1 AND channel = 'phone'", [req.query.conversation]));
    if (!row) return twiml(reply, "<Hangup/>");
    setRequestTenant(row.tenant_id);
    const conv = await getConversation(req.query.conversation, row.bot_id);
    const bot = await one<BotRow>("SELECT id, tenant_id, name, industry, config, is_active, allowed_domains FROM bots WHERE id = $1", [row.bot_id]);
    if (!conv || !bot) return twiml(reply, "<Hangup/>");
    const cfg = resolveBotConfig(bot);

    const speech = (body.SpeechResult ?? "").trim();
    if (!speech) {
      if (req.query.silence) return twiml(reply, `<Say voice="${xmlEscape(cfg.voice.phoneVoice)}">Sorry, I didn't catch that. Goodbye for now.</Say><Hangup/>`);
      return twiml(reply, gather(conv.id, cfg.voice.lang, cfg.voice.phoneVoice, "Sorry, could you say that again?"));
    }
    const { text } = await runTurnToText(conv, speech);
    const spoken = text.replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim() || "Sorry, could you say that again?";
    return twiml(reply, gather(conv.id, cfg.voice.lang, cfg.voice.phoneVoice, spoken));
  });

  // Call ended: record voice minutes for billing.
  app.post("/v1/voice/twilio/status", async (req, reply) => {
    if (!verifyTwilio(req)) return reply.code(403).send("Invalid signature");
    const body = req.body as TwilioBody;
    if (body.CallStatus !== "completed") return { ok: true };
    const conv = await asSystem(() => one("SELECT id, tenant_id, bot_id FROM conversations WHERE external_id = $1 AND channel = 'phone'", [body.CallSid]));
    if (conv) {
      setRequestTenant(conv.tenant_id);
      const minutes = Math.max(1, Math.ceil(Number(body.CallDuration ?? 0) / 60));
      await recordUsage(conv.tenant_id, conv.bot_id, "voice_minute", minutes);
      await one("UPDATE conversations SET status = CASE WHEN status = 'open' THEN 'closed' ELSE status END WHERE id = $1", [conv.id]);
    }
    return { ok: true };
  });
}
