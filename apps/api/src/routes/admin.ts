import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, requireAuth, signToken, verifyPassword } from "../auth.js";
import { config } from "../config.js";
import { asSystem, one, query, withTransaction } from "../db.js";
import { botConfigOverridesSchema, resolveBotConfig } from "../core/botConfig.js";
import { extractText } from "../core/ingest.js";
import { enqueue, signWebhook } from "../core/jobs.js";
import { getPlan, monthUsage, plans } from "../core/plans.js";
import { encryptSecret } from "../core/secrets.js";
import { templates } from "../templates/index.js";

const newPublicKey = () => "pk_" + randomBytes(16).toString("hex");
const newSecret = () => "whsec_" + randomBytes(24).toString("hex");

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const err = new Error(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    (err as any).statusCode = 400;
    throw err;
  }
  return result.data;
}

function embedSnippet(publicKey: string) {
  return `<script src="${config.publicUrl}/widget.js" data-bot="${publicKey}" async></script>`;
}

export async function adminRoutes(app: FastifyInstance) {
  // ---------- Auth ----------
  app.post("/api/auth/signup", async (req, reply) => {
    const body = parse(
      z.object({
        company: z.string().min(2).max(120),
        name: z.string().min(1).max(120),
        email: z.string().email().toLowerCase(),
        password: z.string().min(8).max(200),
      }),
      req.body,
    );
    // Sign-up creates a new company, so it runs as the platform. New companies start on the pilot plan.
    const exists = await asSystem(() => one("SELECT 1 FROM users WHERE email = $1", [body.email]));
    if (exists) return reply.code(409).send({ error: "An account with this email already exists." });
    const passwordHash = await hashPassword(body.password);
    const pilot = getPlan("pilot");
    const user = await asSystem(() => withTransaction(async (db) => {
      const tenant = (await db.query("INSERT INTO tenants(name, plan, channels) VALUES ($1, $2, $3) RETURNING id", [body.company, pilot.id, pilot.channels])).rows[0];
      return (
        await db.query("INSERT INTO users(tenant_id, email, password_hash, name) VALUES ($1, $2, $3, $4) RETURNING id, tenant_id, email", [
          tenant.id,
          body.email,
          passwordHash,
          body.name,
        ])
      ).rows[0];
    }));
    return { token: signToken({ userId: user.id, tenantId: user.tenant_id, email: user.email }) };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(z.object({ email: z.string().email().toLowerCase(), password: z.string() }), req.body);
    const user = await asSystem(() => one("SELECT id, tenant_id, email, password_hash FROM users WHERE email = $1", [body.email]));
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      return reply.code(401).send({ error: "Wrong email or password." });
    }
    return { token: signToken({ userId: user.id, tenantId: user.tenant_id, email: user.email }) };
  });

  app.get("/api/templates", async () =>
    Object.values(templates).map((t) => ({ id: t.id, name: t.name, description: t.description, leadFields: t.leadFields })),
  );

  // ---------- Everything below requires a logged-in tenant user ----------
  app.register(async (secured) => {
    secured.addHook("preHandler", requireAuth);

    secured.get("/api/me", async (req) => {
      const t = req.user!.tenantId;
      const tenant = await one("SELECT id, name, plan, status, channels, default_language, data_retention_days FROM tenants WHERE id = $1", [t]);
      // The user row lives in the user's own company, which differs from the acting company when a team member acts for another.
      const user = await asSystem(() => one("SELECT id, tenant_id, email, name, role, is_platform_admin FROM users WHERE id = $1", [req.user!.userId]));
      return {
        user,
        tenant,
        actingAs: req.user!.tenantId !== req.user!.homeTenantId,
        plan: getPlan(tenant.plan),
        plans: Object.values(plans),
        usage: await monthUsage(t),
        features: { phone: config.phone.enabled, whatsappWebhookUrl: `${config.publicUrl}/v1/whatsapp/webhook` },
      };
    });

    // ---------- Bots ----------
    secured.get("/api/bots", async (req) =>
      query(
        `SELECT b.id, b.name, b.industry, b.public_key, b.is_active, b.created_at,
                (SELECT count(*) FROM documents d WHERE d.bot_id = b.id)::int AS documents,
                (SELECT count(*) FROM leads l WHERE l.bot_id = b.id)::int AS leads,
                (SELECT count(*) FROM conversations c WHERE c.bot_id = b.id)::int AS conversations
           FROM bots b WHERE b.tenant_id = $1 ORDER BY b.created_at`,
        [req.user!.tenantId],
      ),
    );

    secured.post("/api/bots", async (req, reply) => {
      const t = req.user!.tenantId;
      const body = parse(z.object({ name: z.string().min(1).max(80), industry: z.string().default("generic") }), req.body);
      if (!templates[body.industry]) return reply.code(400).send({ error: "Unknown industry template." });
      const tenant = await one("SELECT plan FROM tenants WHERE id = $1", [t]);
      const count = await one("SELECT count(*)::int AS n FROM bots WHERE tenant_id = $1", [t]);
      if (count.n >= getPlan(tenant.plan).bots) return reply.code(402).send({ error: "Your plan's bot limit is reached. Upgrade to add more bots." });
      return one(
        "INSERT INTO bots(tenant_id, name, industry, public_key, webhook_secret, config) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [t, body.name, body.industry, newPublicKey(), newSecret(), { companyName: body.name }],
      );
    });

    secured.get<{ Params: { id: string } }>("/api/bots/:id", async (req, reply) => {
      const row = await one("SELECT * FROM bots WHERE id = $1 AND tenant_id = $2", [req.params.id, req.user!.tenantId]);
      if (!row) return reply.code(404).send({ error: "Bot not found." });
      const { whatsapp_access_token_enc, ...bot } = row; // the token is never sent back
      return {
        ...bot,
        whatsapp_token_set: Boolean(whatsapp_access_token_enc),
        resolved: resolveBotConfig(bot),
        embedSnippet: embedSnippet(bot.public_key),
        demoUrl: `${config.publicUrl}/demo/${bot.public_key}`,
        whatsappWebhookUrl: `${config.publicUrl}/v1/whatsapp/webhook`,
        voiceWebhookUrl: config.phone.enabled ? `${config.publicUrl}/v1/voice/twilio/incoming` : null,
      };
    });

    secured.patch<{ Params: { id: string } }>("/api/bots/:id", async (req, reply) => {
      const body = parse(
        z.object({
          name: z.string().min(1).max(80).optional(),
          industry: z.string().optional(),
          config: botConfigOverridesSchema.optional(),
          allowed_domains: z.array(z.string().min(1).max(253)).max(20).optional(),
          webhook_url: z.string().url().nullable().or(z.literal("")).optional(),
          phone_number: z.string().regex(/^\+[1-9]\d{6,14}$/, "Use E.164 format, e.g. +15551234567").nullable().or(z.literal("")).optional(),
          is_active: z.boolean().optional(),
          whatsapp_phone_number_id: z.string().regex(/^\d{5,30}$/, "The phone number ID is the long number from Meta's WhatsApp setup page").nullable().or(z.literal("")).optional(),
          whatsapp_display_number: z.string().max(30).nullable().or(z.literal("")).optional(),
          whatsapp_business_account_id: z.string().regex(/^\d{5,30}$/, "Use the WhatsApp Business Account ID from Meta").nullable().or(z.literal("")).optional(),
          whatsapp_access_token: z.string().max(1000).nullable().or(z.literal("")).optional(),
        }),
        req.body,
      );
      if (body.industry && !templates[body.industry]) return reply.code(400).send({ error: "Unknown industry template." });
      const sets: string[] = [];
      const values: unknown[] = [];
      const add = (col: string, val: unknown) => {
        values.push(val);
        sets.push(`${col} = $${values.length + 2}`);
      };
      if (body.name !== undefined) add("name", body.name);
      if (body.industry !== undefined) add("industry", body.industry);
      if (body.config !== undefined) add("config", body.config);
      if (body.allowed_domains !== undefined) add("allowed_domains", body.allowed_domains.map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")));
      if (body.webhook_url !== undefined) add("webhook_url", body.webhook_url || null);
      if (body.phone_number !== undefined) add("phone_number", body.phone_number || null);
      if (body.is_active !== undefined) add("is_active", body.is_active);
      if (body.whatsapp_phone_number_id !== undefined) add("whatsapp_phone_number_id", body.whatsapp_phone_number_id || null);
      if (body.whatsapp_display_number !== undefined) add("whatsapp_display_number", body.whatsapp_display_number || null);
      if (body.whatsapp_business_account_id !== undefined) add("whatsapp_business_account_id", body.whatsapp_business_account_id || null);
      if (body.whatsapp_access_token !== undefined) {
        if (body.whatsapp_access_token && !/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
          return reply.code(500).send({ error: "The server has no APP_ENCRYPTION_KEY, so it cannot store WhatsApp tokens." });
        }
        add("whatsapp_access_token_enc", body.whatsapp_access_token ? encryptSecret(body.whatsapp_access_token) : null);
      }
      if (!sets.length) return { ok: true };
      const row = await one(
        `UPDATE bots SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [req.params.id, req.user!.tenantId, ...values],
      ).catch((err) => {
        if (err.code === "23505") throw Object.assign(new Error("That phone number is already connected to another bot."), { statusCode: 409 });
        throw err;
      });
      if (!row) return reply.code(404).send({ error: "Bot not found." });
      return { ok: true };
    });

    secured.delete<{ Params: { id: string } }>("/api/bots/:id", async (req) => {
      await query("DELETE FROM bots WHERE id = $1 AND tenant_id = $2", [req.params.id, req.user!.tenantId]);
      return { ok: true };
    });

    secured.post<{ Params: { id: string } }>("/api/bots/:id/test-webhook", async (req, reply) => {
      const bot = await one("SELECT id, webhook_url, webhook_secret FROM bots WHERE id = $1 AND tenant_id = $2", [req.params.id, req.user!.tenantId]);
      if (!bot?.webhook_url) return reply.code(400).send({ error: "Set a webhook URL first." });
      const body = JSON.stringify({
        event: "lead.created",
        bot_id: bot.id,
        created_at: new Date().toISOString(),
        data: { lead_id: "test", test: true, channel: "web", consent: true, fields: { name: "Test Lead", phone: "+15550000000", summary: "Test lead from vanibot" } },
      });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      try {
        const res = await fetch(bot.webhook_url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vanibot-event": "lead.created",
            "x-vanibot-timestamp": timestamp,
            "x-vanibot-signature": signWebhook(bot.webhook_secret, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    // ---------- Knowledge ----------
    async function assertBot(botId: string, tenantId: string) {
      const bot = await one("SELECT id FROM bots WHERE id = $1 AND tenant_id = $2", [botId, tenantId]);
      if (!bot) throw Object.assign(new Error("Bot not found."), { statusCode: 404 });
    }
    async function assertDocQuota(tenantId: string) {
      const tenant = await one("SELECT plan FROM tenants WHERE id = $1", [tenantId]);
      const n = await one("SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1", [tenantId]);
      if (n.n >= getPlan(tenant.plan).documents) throw Object.assign(new Error("Your plan's document limit is reached."), { statusCode: 402 });
    }
    async function addDocument(tenantId: string, botId: string, kind: string, title: string, source: string | null, text: string | null) {
      const doc = await one("INSERT INTO documents(tenant_id, bot_id, kind, title, source, raw_text) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [
        tenantId,
        botId,
        kind,
        title,
        source,
        text,
      ]);
      await enqueue("ingest_document", { documentId: doc.id }, tenantId);
      return doc;
    }

    secured.get<{ Params: { id: string } }>("/api/bots/:id/documents", async (req) => {
      await assertBot(req.params.id, req.user!.tenantId);
      return query(
        "SELECT id, kind, title, source, status, error, chunk_count, created_at FROM documents WHERE bot_id = $1 AND tenant_id = $2 ORDER BY created_at DESC",
        [req.params.id, req.user!.tenantId],
      );
    });

    secured.post<{ Params: { id: string } }>("/api/bots/:id/documents/upload", async (req, reply) => {
      const t = req.user!.tenantId;
      await assertBot(req.params.id, t);
      await assertDocQuota(t);
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "No file uploaded." });
      const data = await file.toBuffer();
      let text: string;
      try {
        text = await extractText(file.filename, data);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "Could not read file." });
      }
      return addDocument(t, req.params.id, "file", file.filename, file.filename, text);
    });

    secured.post<{ Params: { id: string } }>("/api/bots/:id/documents/url", async (req) => {
      const t = req.user!.tenantId;
      await assertBot(req.params.id, t);
      await assertDocQuota(t);
      const body = parse(z.object({ url: z.string().url().refine((u) => /^https?:\/\//.test(u), "Must be http(s)") }), req.body);
      return addDocument(t, req.params.id, "url", body.url, body.url, null);
    });

    secured.post<{ Params: { id: string } }>("/api/bots/:id/documents/text", async (req) => {
      const t = req.user!.tenantId;
      await assertBot(req.params.id, t);
      await assertDocQuota(t);
      const body = parse(
        z.object({ title: z.string().min(1).max(200), text: z.string().min(1).max(200_000), kind: z.enum(["text", "qa"]).default("text") }),
        req.body,
      );
      return addDocument(t, req.params.id, body.kind, body.title, null, body.text);
    });

    secured.delete<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
      await query("DELETE FROM documents WHERE id = $1 AND tenant_id = $2", [req.params.id, req.user!.tenantId]);
      return { ok: true };
    });

    // Visitor questions the bot found no documents for: the to-do list for improving the knowledge base.
    secured.get<{ Params: { id: string } }>("/api/bots/:id/unanswered", async (req) => {
      await assertBot(req.params.id, req.user!.tenantId);
      return query(
        `SELECT m.display_text AS question, m.created_at, m.conversation_id
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.bot_id = $1 AND m.tenant_id = $2 AND m.role = 'user' AND m.display_text IS NOT NULL
            AND m.content->0->>'text' LIKE '%No matching company documents%'
          ORDER BY m.created_at DESC LIMIT 100`,
        [req.params.id, req.user!.tenantId],
      );
    });

    // ---------- Leads ----------
    secured.get<{ Querystring: { bot_id?: string } }>("/api/leads", async (req) =>
      query(
        `SELECT l.id, l.bot_id, b.name AS bot_name, l.conversation_id, l.fields, l.consent, l.status, l.created_at, c.channel
           FROM leads l JOIN bots b ON b.id = l.bot_id LEFT JOIN conversations c ON c.id = l.conversation_id
          WHERE l.tenant_id = $1 AND ($2::uuid IS NULL OR l.bot_id = $2)
          ORDER BY l.created_at DESC LIMIT 500`,
        [req.user!.tenantId, req.query.bot_id || null],
      ),
    );

    secured.get("/api/leads.csv", async (req, reply) => {
      const rows = await query("SELECT l.created_at, b.name AS bot, l.fields, l.status FROM leads l JOIN bots b ON b.id = l.bot_id WHERE l.tenant_id = $1 ORDER BY l.created_at DESC", [
        req.user!.tenantId,
      ]);
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r.fields)))];
      const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
      const lines = [["created_at", "bot", "status", ...keys].map(esc).join(",")];
      for (const r of rows) lines.push([new Date(r.created_at).toISOString(), r.bot, r.status, ...keys.map((k) => r.fields[k])].map(esc).join(","));
      reply.header("content-type", "text/csv").header("content-disposition", 'attachment; filename="leads.csv"');
      return lines.join("\n");
    });

    secured.patch<{ Params: { id: string } }>("/api/leads/:id", async (req) => {
      const body = parse(z.object({ status: z.enum(["new", "contacted", "qualified", "closed"]) }), req.body);
      await query("UPDATE leads SET status = $3 WHERE id = $1 AND tenant_id = $2", [req.params.id, req.user!.tenantId, body.status]);
      return { ok: true };
    });

    // ---------- Conversations ----------
    secured.get<{ Querystring: { bot_id?: string } }>("/api/conversations", async (req) =>
      query(
        `SELECT c.id, c.bot_id, b.name AS bot_name, c.channel, c.caller, c.status, c.created_at, c.updated_at,
                (SELECT display_text FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.display_text IS NOT NULL ORDER BY m.id LIMIT 1) AS first_message,
                (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.display_text IS NOT NULL)::int AS message_count
           FROM conversations c JOIN bots b ON b.id = c.bot_id
          WHERE c.tenant_id = $1 AND ($2::uuid IS NULL OR c.bot_id = $2)
          ORDER BY c.updated_at DESC LIMIT 200`,
        [req.user!.tenantId, req.query.bot_id || null],
      ),
    );

    secured.get<{ Params: { id: string } }>("/api/conversations/:id", async (req, reply) => {
      const conv = await one("SELECT id, bot_id, channel, caller, status, created_at FROM conversations WHERE id = $1 AND tenant_id = $2", [
        req.params.id,
        req.user!.tenantId,
      ]);
      if (!conv) return reply.code(404).send({ error: "Conversation not found." });
      const messages = await query(
        "SELECT role, display_text AS text, created_at FROM messages WHERE conversation_id = $1 AND display_text IS NOT NULL ORDER BY id",
        [conv.id],
      );
      return { ...conv, messages };
    });
  });
}
