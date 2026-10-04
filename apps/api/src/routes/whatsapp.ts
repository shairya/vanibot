import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { asSystem, one, query } from "../db.js";
import { enqueue } from "../core/jobs.js";
import { verifySignature, type InboundMessage } from "../core/whatsapp.js";

// Meta WhatsApp Cloud API webhook. In the Meta app, set the callback URL to {PUBLIC_URL}/v1/whatsapp/webhook,
// the verify token to WHATSAPP_VERIFY_TOKEN, and subscribe to the "messages" field.

type WebhookBody = {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: InboundMessage[];
      };
    }[];
  }[];
};

export async function whatsappRoutes(app: FastifyInstance) {
  // Keep the exact bytes for the signature check.
  app.register(async (wa) => {
    wa.removeContentTypeParser("application/json");
    wa.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    wa.get<{ Querystring: Record<string, string> }>("/v1/whatsapp/webhook", async (req, reply) => {
      const q = req.query;
      if (q["hub.mode"] === "subscribe" && config.whatsapp.verifyToken && q["hub.verify_token"] === config.whatsapp.verifyToken) {
        return reply.type("text/plain").send(q["hub.challenge"] ?? "");
      }
      return reply.code(403).send("Verification failed");
    });

    wa.post("/v1/whatsapp/webhook", async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
        return reply.code(401).send("Bad signature");
      }
      let body: WebhookBody;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send("Bad JSON");
      }
      // Answer Meta quickly; the reply is produced by the job worker.
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value;
          const phoneNumberId = value?.metadata?.phone_number_id;
          if (!phoneNumberId || !value?.messages?.length) continue; // delivery/read statuses are ignored
          // Routing a number to its company crosses companies, so it runs as the platform.
          const bot = await asSystem(() =>
            one<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM bots WHERE whatsapp_phone_number_id = $1", [phoneNumberId]),
          );
          if (!bot) {
            req.log.warn({ phoneNumberId }, "WhatsApp message for an unknown number");
            continue;
          }
          for (const message of value.messages) {
            const contact = value.contacts?.find((c) => c.wa_id === message.from) ?? value.contacts?.[0];
            const fresh = await asSystem(() =>
              query("INSERT INTO whatsapp_inbound(message_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING message_id", [
                message.id,
                bot.tenant_id,
              ]),
            );
            if (!fresh.length) continue; // Meta retried a message we already have
            await asSystem(() =>
              enqueue("whatsapp_inbound", { botId: bot.id, tenantId: bot.tenant_id, message, contactName: contact?.profile?.name }, bot.tenant_id),
            );
          }
        }
      }
      return { ok: true };
    });
  });
}
