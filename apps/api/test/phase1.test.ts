import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { asSystem, one, pool, query, setScriptContext, withTenant } from "../src/db.js";
import { runOneJob } from "../src/core/jobs.js";
import { setClaudeClient } from "../src/core/orchestrator.js";
import { encryptSecret } from "../src/core/secrets.js";
import { setSpeechProvider } from "../src/core/speech.js";
import { fakeClaude } from "./fakeClaude.js";

let app: FastifyInstance;
let graph: Server;
let graphCalls: { path: string; body: string; contentType: string }[] = [];
const created: string[] = [];

async function makeTenant(name: string, channels = ["web", "whatsapp", "voice"]) {
  return asSystem(async () => {
    const t = (await one("INSERT INTO tenants(name, plan, channels) VALUES ($1, 'pilot', $2) RETURNING id", [name, channels])).id as string;
    created.push(t);
    const user = await one("INSERT INTO users(tenant_id, email, password_hash, name) VALUES ($1, $2, $3, 'Owner') RETURNING id, email", [
      t,
      `${randomBytes(5).toString("hex")}@test.local`,
      await hashPassword("password123"),
    ]);
    const phoneId = String(10 ** 14 + Math.floor(Math.random() * 10 ** 13));
    const bot = await one(
      `INSERT INTO bots(tenant_id, name, industry, public_key, webhook_secret, config, whatsapp_phone_number_id, whatsapp_access_token_enc)
       VALUES ($1, $2, 'medical-bill-discount', $3, 'whsec_x', $4, $5, $6) RETURNING id, public_key`,
      [t, name + " bot", "pk_t_" + randomBytes(6).toString("hex"), { companyName: name }, phoneId, encryptSecret("EAAtest")],
    );
    await query("INSERT INTO leads(tenant_id, bot_id, fields, consent) VALUES ($1, $2, $3, true)", [t, bot.id, { name: `${name} lead` }]);
    return { tenantId: t, userId: user.id as string, email: user.email as string, botId: bot.id as string, publicKey: bot.public_key as string, phoneId };
  });
}

const token = (u: { userId: string; tenantId: string; email: string }) => `Bearer ${signToken(u)}`;

function waPayload(phoneId: string, message: Record<string, unknown>) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneId }, contacts: [{ wa_id: "919800000001", profile: { name: "Asha" } }], messages: [message] } }] }],
  });
}
const sign = (body: string) => "sha256=" + createHmac("sha256", "test-app-secret").update(body).digest("hex");

async function drainJobs() {
  for (let i = 0; i < 20 && (await runOneJob()); i++);
}

beforeAll(async () => {
  app = await buildApp();
  graph = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      graphCalls.push({ path, body: Buffer.concat(chunks).toString("latin1"), contentType: String(req.headers["content-type"] ?? "") });
      res.setHeader("content-type", "application/json");
      if (path.endsWith("/media") && req.method === "POST") return res.end(JSON.stringify({ id: "uploaded-media-1" }));
      if (path.includes("/media-in-1")) return res.end(JSON.stringify({ url: "http://127.0.0.1:4599/download/voice.ogg", mime_type: "audio/ogg" }));
      if (path.startsWith("/download/")) {
        res.setHeader("content-type", "audio/ogg");
        return res.end("OGGDATA");
      }
      res.end(JSON.stringify({ messages: [{ id: "wamid.out" }] }));
    });
  });
  await new Promise<void>((r) => graph.listen(4599, "127.0.0.1", r));
});

afterAll(async () => {
  setClaudeClient(null);
  setSpeechProvider(null);
  await asSystem(async () => {
    for (const t of created) {
      await query("DELETE FROM jobs WHERE tenant_id = $1", [t]);
      await query("DELETE FROM tenants WHERE id = $1", [t]);
    }
  });
  await app.close();
  graph.close();
  await pool.end();
});

beforeEach(() => {
  graphCalls = [];
  setScriptContext(null);
});

describe("tenant isolation (row-level security)", () => {
  it("a company only ever sees its own rows, even without a WHERE clause", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");
    const leadsA = await withTenant(a.tenantId, () => query("SELECT fields FROM leads"));
    expect(leadsA.map((l) => l.fields.name)).toEqual(["Alpha lead"]);
    const botsB = await withTenant(b.tenantId, () => query("SELECT id FROM bots"));
    expect(botsB.map((r) => r.id)).toEqual([b.botId]);
    const tenantsA = await withTenant(a.tenantId, () => query("SELECT id FROM tenants"));
    expect(tenantsA.map((r) => r.id)).toEqual([a.tenantId]);
  });

  it("queries with no company context see nothing", async () => {
    await makeTenant("Gamma");
    expect(await query("SELECT id FROM leads")).toEqual([]);
    expect(await query("SELECT id FROM users")).toEqual([]);
  });

  it("a company cannot write rows into another company", async () => {
    const a = await makeTenant("Delta");
    const b = await makeTenant("Epsilon");
    await expect(
      withTenant(a.tenantId, () => query("INSERT INTO leads(tenant_id, bot_id, fields, consent) VALUES ($1, $2, '{}', true)", [b.tenantId, b.botId])),
    ).rejects.toThrow(/row-level security/);
    const updated = await withTenant(a.tenantId, () => query("UPDATE bots SET name = 'hacked' WHERE id = $1 RETURNING id", [b.botId]));
    expect(updated).toEqual([]);
  });

  it("the dashboard API returns 404 for another company's bot", async () => {
    const a = await makeTenant("Zeta");
    const b = await makeTenant("Eta");
    const res = await app.inject({ method: "GET", url: `/api/bots/${b.botId}`, headers: { authorization: token(a) } });
    expect(res.statusCode).toBe(404);
    const own = await app.inject({ method: "GET", url: `/api/bots/${a.botId}`, headers: { authorization: token(a) } });
    expect(own.statusCode).toBe(200);
    expect(own.json().whatsapp_access_token_enc).toBeUndefined();
    expect(own.json().whatsapp_token_set).toBe(true);
    const leads = await app.inject({ method: "GET", url: "/api/leads", headers: { authorization: token(a) } });
    expect(leads.json().map((l: any) => l.fields.name)).toEqual(["Zeta lead"]);
  });

  it("only vanibot team members can act for another company", async () => {
    const a = await makeTenant("Theta");
    const b = await makeTenant("Iota");
    const denied = await app.inject({ method: "GET", url: "/api/leads", headers: { authorization: token(a), "x-act-as-tenant": b.tenantId } });
    expect(denied.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/platform/tenants", headers: { authorization: token(a) } })).statusCode).toBe(403);

    await asSystem(() => query("UPDATE users SET is_platform_admin = true WHERE id = $1", [a.userId]));
    const acting = await app.inject({ method: "GET", url: "/api/leads", headers: { authorization: token(a), "x-act-as-tenant": b.tenantId } });
    expect(acting.json().map((l: any) => l.fields.name)).toEqual(["Iota lead"]);
    const all = await app.inject({ method: "GET", url: "/api/platform/tenants", headers: { authorization: token(a) } });
    expect(all.json().map((t: any) => t.id)).toEqual(expect.arrayContaining([a.tenantId, b.tenantId]));
  });
});

describe("dashboard writes", () => {
  it("saves WhatsApp settings for the company's own bot and encrypts the token", async () => {
    const a = await makeTenant("Kappa");
    const b = await makeTenant("Lambda");
    const payload = { whatsapp_phone_number_id: "123456789012", whatsapp_display_number: "+91 98000 00000", whatsapp_access_token: "EAAsecret", config: { channels: { voice: false } } };
    const res = await app.inject({ method: "PATCH", url: `/api/bots/${a.botId}`, headers: { authorization: token(a) }, payload });
    expect(res.statusCode).toBe(200);
    const row = await asSystem(() => one("SELECT whatsapp_phone_number_id, whatsapp_access_token_enc, config FROM bots WHERE id = $1", [a.botId]));
    expect(row.whatsapp_phone_number_id).toBe("123456789012");
    expect(row.whatsapp_access_token_enc).not.toContain("EAAsecret");
    expect(row.config.channels.voice).toBe(false);
    const other = await app.inject({ method: "PATCH", url: `/api/bots/${b.botId}`, headers: { authorization: token(a) }, payload: { name: "hacked" } });
    expect(other.statusCode).toBe(404);
  });
});

describe("channels per company", () => {
  it("a chat-only company gets no voice in the widget", async () => {
    const c = await makeTenant("ChatOnly", ["web", "whatsapp"]);
    const cfg = (await app.inject({ method: "GET", url: `/v1/widget/${c.publicKey}/config` })).json();
    expect(cfg.chat).toBe(true);
    expect(cfg.voice.enabled).toBe(false);
    const voice = await app.inject({ method: "POST", url: `/v1/widget/${c.publicKey}/conversations`, payload: { channel: "web_voice" } });
    expect(voice.statusCode).toBe(403);
  });

  it("a voice-only company gets a voice-only widget", async () => {
    const v = await makeTenant("VoiceOnly", ["voice"]);
    const cfg = (await app.inject({ method: "GET", url: `/v1/widget/${v.publicKey}/config` })).json();
    expect(cfg.chat).toBe(false);
    expect(cfg.voice.enabled).toBe(true);
    expect((await app.inject({ method: "POST", url: `/v1/widget/${v.publicKey}/conversations`, payload: { channel: "web" } })).statusCode).toBe(403);
  });
});

describe("WhatsApp", () => {
  it("verifies the webhook with Meta's challenge", async () => {
    const ok = await app.inject({ method: "GET", url: "/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345" });
    expect(ok.body).toBe("12345");
    const bad = await app.inject({ method: "GET", url: "/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" });
    expect(bad.statusCode).toBe(403);
  });

  it("rejects unsigned webhooks", async () => {
    const body = waPayload("1", { id: "x", from: "1", type: "text", text: { body: "hi" } });
    const res = await app.inject({ method: "POST", url: "/v1/whatsapp/webhook", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" } });
    expect(res.statusCode).toBe(401);
  });

  it("answers a text message once, even if Meta delivers it twice", async () => {
    const w = await makeTenant("WhatsText");
    const { client, requests } = fakeClaude([{ content: [{ type: "text", text: "Our review is *free*." }], stop_reason: "end_turn" }]);
    setClaudeClient(client);
    const body = waPayload(w.phoneId, { id: "wamid.text." + randomBytes(4).toString("hex"), from: "919800000001", type: "text", text: { body: "Is it free?" } });
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/v1/whatsapp/webhook", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } });
      expect(res.statusCode).toBe(200);
    }
    await drainJobs();
    expect(requests).toHaveLength(1);
    expect(requests[0].system).toContain("WhatsApp");
    const sent = graphCalls.filter((c) => c.path.endsWith(`/${w.phoneId}/messages`) && c.body.includes('"type":"text"'));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body)).toMatchObject({ to: "919800000001", text: { body: "Our review is *free*." } });
    const conv = await withTenant(w.tenantId, () => one("SELECT channel, caller, contact_name FROM conversations"));
    expect(conv).toEqual({ channel: "whatsapp", caller: "919800000001", contact_name: "Asha" });
  });

  it("transcribes a voice note and replies with a voice note and text", async () => {
    const w = await makeTenant("WhatsVoice");
    const { client, requests } = fakeClaude([{ content: [{ type: "text", text: "हाँ, समीक्षा मुफ़्त है।" }], stop_reason: "end_turn" }]);
    setClaudeClient(client);
    const spoken: { text: string; language: string }[] = [];
    setSpeechProvider({
      name: "fake",
      transcribe: async (audio) => ({ text: audio.toString() === "OGGDATA" ? "क्या यह मुफ़्त है?" : "", language: "hi-IN" }),
      synthesize: async (text, language) => (spoken.push({ text, language }), { data: Buffer.from("MP3"), mimeType: "audio/mpeg", filename: "reply.mp3" }),
    });
    const body = waPayload(w.phoneId, { id: "wamid.voice." + randomBytes(4).toString("hex"), from: "919800000001", type: "audio", audio: { id: "media-in-1", voice: true } });
    await app.inject({ method: "POST", url: "/v1/whatsapp/webhook", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } });
    await drainJobs();
    expect(requests[0].messages[0].content[1].text).toBe("क्या यह मुफ़्त है?");
    expect(spoken).toEqual([{ text: "हाँ, समीक्षा मुफ़्त है।", language: "hi-IN" }]);
    expect(graphCalls.some((c) => c.path.endsWith("/media") && c.body.includes("MP3"))).toBe(true);
    const messages = graphCalls.filter((c) => c.path.endsWith("/messages") && !c.body.includes('"status":"read"')).map((c) => JSON.parse(c.body).type);
    expect(messages).toEqual(["audio", "text"]);
    const usage = await withTenant(w.tenantId, () => one("SELECT sum(quantity)::int AS n FROM usage_events WHERE kind = 'voice_note'"));
    expect(usage.n).toBe(1);
    const conv = await withTenant(w.tenantId, () => one("SELECT language FROM conversations"));
    expect(conv.language).toBe("hi-IN");
    setSpeechProvider(null);
  });

  it("tells a chat-only company's customers to type instead of sending voice notes", async () => {
    const w = await makeTenant("WhatsNoVoice", ["web", "whatsapp"]);
    const body = waPayload(w.phoneId, { id: "wamid.nv." + randomBytes(4).toString("hex"), from: "919800000001", type: "audio", audio: { id: "media-in-1" } });
    await app.inject({ method: "POST", url: "/v1/whatsapp/webhook", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } });
    await drainJobs();
    const sent = graphCalls.filter((c) => c.path.endsWith("/messages") && c.body.includes('"type":"text"'));
    expect(JSON.parse(sent[0].body).text.body).toMatch(/type your question/);
  });
});

describe("website", () => {
  it("stores demo requests where only the vanibot team can read them", async () => {
    const email = `lead-${randomBytes(4).toString("hex")}@example.com`;
    const res = await app.inject({ method: "POST", url: "/api/public/demo-requests", payload: { name: "Ravi", company: "Acme Loans", email, interest: "chat_voice" } });
    expect(res.statusCode).toBe(200);
    const asCompany = await withTenant(created[0], () => query("SELECT id FROM demo_requests WHERE email = $1", [email]));
    expect(asCompany).toEqual([]);
    const asTeam = await asSystem(() => query("SELECT id FROM demo_requests WHERE email = $1", [email]));
    expect(asTeam).toHaveLength(1);
    await asSystem(() => query("DELETE FROM demo_requests WHERE email = $1", [email]));
  });
});
