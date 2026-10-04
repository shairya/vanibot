import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { one, query } from "../db.js";
import { resolveBotConfig, type ResolvedBotConfig } from "./botConfig.js";
import type { BotRow } from "./conversations.js";
import { LimitError, startConversation } from "./conversations.js";
import { registerJobHandler } from "./jobs.js";
import type { Conversation } from "./orchestrator.js";
import { runTurnToText } from "./orchestrator.js";
import { canUseVoice, recordUsage, tenantChannels } from "./plans.js";
import { decryptSecret } from "./secrets.js";
import { speech, SpeechUnavailableError, textForSpeech } from "./speech.js";

// WhatsApp via Meta's WhatsApp Cloud API. One Meta app (WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN) serves every
// company; each company's bot stores its own phone number ID and access token (encrypted).

export type WhatsAppBot = BotRow & {
  whatsapp_phone_number_id: string | null;
  whatsapp_access_token_enc: string | null;
};

export type InboundMessage = {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  button?: { text: string };
};

export function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!config.whatsapp.appSecret) return !config.production; // allowed only in local development
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", config.whatsapp.appSecret).update(rawBody).digest("hex"));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const graphUrl = (path: string) => `${config.whatsapp.graphBase}/${config.whatsapp.graphVersion}/${path}`;

/** Thin client for one bot's WhatsApp number. Without an access token it runs "dry": it logs instead of sending. */
export class WhatsAppClient {
  readonly dryRun: boolean;
  private token: string;
  constructor(
    private phoneNumberId: string,
    tokenEnc: string | null,
    private log: (msg: string, data?: unknown) => void = () => {},
  ) {
    this.token = tokenEnc ? decryptSecret(tokenEnc) : "";
    this.dryRun = !this.token;
  }

  private async graph(path: string, init: RequestInit) {
    const res = await fetch(graphUrl(path), {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`WhatsApp API ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async sendText(to: string, body: string) {
    if (this.dryRun) return this.log("[whatsapp dry run] text", { to, body });
    for (const part of splitForWhatsApp(body)) {
      await this.graph(`${this.phoneNumberId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: part, preview_url: false } }),
      });
    }
  }

  async sendAudio(to: string, audio: Buffer, mimeType: string, filename: string) {
    if (this.dryRun) return this.log("[whatsapp dry run] audio", { to, bytes: audio.length });
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
    const upload = (await (await this.graph(`${this.phoneNumberId}/media`, { method: "POST", body: form })).json()) as { id: string };
    await this.graph(`${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "audio", audio: { id: upload.id } }),
    });
  }

  async markRead(messageId: string) {
    if (this.dryRun) return;
    await this.graph(`${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    }).catch(() => {});
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    if (this.dryRun) throw new Error("Cannot download media without a WhatsApp access token");
    const meta = (await (await this.graph(mediaId, { method: "GET" })).json()) as { url: string; mime_type: string };
    const res = await fetch(meta.url, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`WhatsApp media download failed: ${res.status}`);
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type };
  }
}

/** WhatsApp text messages are limited to 4096 characters. */
export function splitForWhatsApp(text: string, max = 4000): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf("\n", max), rest.lastIndexOf(". ", max));
    const at = cut > max / 2 ? cut + 1 : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const MESSAGES = {
  voiceOnly: "This WhatsApp line answers voice notes. Please send your question as a voice message. 🎙️",
  textOnly: "Sorry, I can't listen to voice notes on this line. Please type your question.",
  unsupported: "Sorry, I can only read text messages and voice notes.",
  notHeard: "Sorry, I couldn't hear that clearly. Could you send it again, or type your question?",
  unavailable: "Sorry, this assistant is not available right now. Please contact the company directly.",
};

async function findOrStartConversation(bot: WhatsAppBot, waId: string, contactName?: string): Promise<Conversation> {
  // Reuse the customer's conversation if they wrote in the last 24 hours (WhatsApp's customer-service window).
  const existing = await one<Conversation>(
    `SELECT id, tenant_id, bot_id, channel, caller, system_prompt, tools FROM conversations
      WHERE bot_id = $1 AND channel = 'whatsapp' AND caller = $2 AND status <> 'closed' AND updated_at > now() - interval '24 hours'
      ORDER BY updated_at DESC LIMIT 1`,
    [bot.id, waId],
  );
  if (existing) return existing;
  const conv = await startConversation(bot, "whatsapp", { caller: waId });
  if (contactName) await query("UPDATE conversations SET contact_name = $2 WHERE id = $1", [conv.id, contactName.slice(0, 120)]);
  return conv;
}

export type InboundJob = { botId: string; tenantId: string; message: InboundMessage; contactName?: string };

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
let log: Log = console as unknown as Log;
export function setWhatsAppLogger(l: Log) {
  log = l;
}

/** Handles one inbound customer message: understand it (transcribing voice notes), reply in text and, for voice, audio. */
export async function handleInbound(job: InboundJob) {
  const bot = await one<WhatsAppBot>(
    `SELECT id, tenant_id, name, industry, config, is_active, allowed_domains, whatsapp_phone_number_id, whatsapp_access_token_enc
       FROM bots WHERE id = $1`,
    [job.botId],
  );
  if (!bot?.whatsapp_phone_number_id) return;
  const cfg: ResolvedBotConfig = resolveBotConfig(bot);
  const wa = new WhatsAppClient(bot.whatsapp_phone_number_id, bot.whatsapp_access_token_enc, (m, d) => log.info(d, m));
  const msg = job.message;
  const to = msg.from;
  await wa.markRead(msg.id);

  if (!bot.is_active) return wa.sendText(to, MESSAGES.unavailable);
  const channels = await tenantChannels(bot.tenant_id);
  const textAllowed = channels.includes("whatsapp") && cfg.channels.whatsapp;
  const voiceAllowed = channels.includes("voice") && cfg.channels.voice;

  let userText = "";
  let isVoice = false;
  let detectedLanguage: string | null = null;

  if (msg.type === "text" || msg.type === "interactive" || msg.type === "button") {
    userText = msg.text?.body ?? msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? msg.button?.text ?? "";
    if (!textAllowed) return wa.sendText(to, voiceAllowed ? MESSAGES.voiceOnly : MESSAGES.unavailable);
  } else if (msg.type === "audio" && msg.audio?.id) {
    if (!voiceAllowed) return wa.sendText(to, textAllowed ? MESSAGES.textOnly : MESSAGES.unavailable);
    const limit = await canUseVoice(bot.tenant_id);
    if (!limit.ok) {
      log.warn({ tenant: bot.tenant_id, reason: limit.reason }, "voice limit");
      return wa.sendText(to, textAllowed ? MESSAGES.textOnly : MESSAGES.unavailable);
    }
    const media = await wa.downloadMedia(msg.audio.id);
    try {
      const transcript = await speech().transcribe(media.data, media.mimeType);
      userText = transcript.text;
      detectedLanguage = transcript.language;
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, "transcription failed");
      return wa.sendText(to, err instanceof SpeechUnavailableError && textAllowed ? MESSAGES.textOnly : MESSAGES.notHeard);
    }
    await recordUsage(bot.tenant_id, bot.id, "voice_note");
    isVoice = true;
    if (!userText) return wa.sendText(to, MESSAGES.notHeard);
  } else {
    return wa.sendText(to, MESSAGES.unsupported);
  }

  let conv: Conversation;
  try {
    conv = await findOrStartConversation(bot, to, job.contactName);
  } catch (err) {
    if (err instanceof LimitError) {
      log.warn({ tenant: bot.tenant_id, reason: err.message }, "conversation limit");
      return wa.sendText(to, MESSAGES.unavailable);
    }
    throw err;
  }
  if (detectedLanguage) await query("UPDATE conversations SET language = $2 WHERE id = $1", [conv.id, detectedLanguage]);

  // From here on, never throw: a retry would answer the customer twice.
  try {
    const { text } = await runTurnToText(conv, userText);
    if (isVoice) {
      const language = detectedLanguage ?? cfg.defaultLanguage;
      const audio = await speech()
        .synthesize(textForSpeech(text), language, cfg.voice.speaker)
        .catch((err) => (log.error({ err: err instanceof Error ? err.message : err }, "speech synthesis failed"), null));
      if (audio) {
        await wa.sendAudio(to, audio.data, audio.mimeType, audio.filename);
      }
    }
    await wa.sendText(to, text);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err, conversation: conv.id }, "whatsapp reply failed");
  }
}

registerJobHandler("whatsapp_inbound", handleInbound);
