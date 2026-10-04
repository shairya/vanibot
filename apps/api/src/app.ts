import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import "./core/ingest.js"; // registers the ingestion job handler
import { adminRoutes } from "./routes/admin.js";
import { billingRoutes } from "./routes/billing.js";
import { voiceRoutes } from "./routes/voice.js";
import { widgetRoutes } from "./routes/widget.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const widgetBundle = path.resolve(here, "../../widget/dist/widget.js");

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 1_000_000 });

  // Admin API uses bearer tokens (no cookies) and the widget checks allowed domains itself, so reflecting the origin is safe.
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] });
  await app.register(formbody); // Twilio posts application/x-www-form-urlencoded
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 ? "Something went wrong." : err.message });
  });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  app.get("/widget.js", async (_req, reply) => {
    if (!existsSync(widgetBundle)) return reply.code(404).send("Widget not built yet. Run: pnpm --filter @vanibot/widget build");
    reply.header("content-type", "application/javascript; charset=utf-8").header("cache-control", "public, max-age=300");
    return readFile(widgetBundle, "utf8");
  });

  // A blank page with the widget installed, for testing a bot without a website.
  app.get<{ Params: { key: string } }>("/demo/:key", async (req, reply) => {
    const key = req.params.key.replace(/[^a-zA-Z0-9_]/g, "");
    reply.header("content-type", "text/html; charset=utf-8");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vanibot demo</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:60px auto;padding:0 16px;color:#1f2937}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>vanibot demo page</h1><p>This page has your bot installed. Click the chat bubble in the corner to talk to it, or the microphone to talk by voice (Chrome or Edge).</p>
<p>To add it to your website, paste this before <code>&lt;/body&gt;</code>:</p>
<pre><code>${`&lt;script src="${config.publicUrl}/widget.js" data-bot="${key}" async&gt;&lt;/script&gt;`}</code></pre>
<script src="${config.publicUrl}/widget.js" data-bot="${key}" async></script></body></html>`;
  });

  await app.register(adminRoutes);
  await app.register(widgetRoutes);
  await app.register(voiceRoutes);
  await app.register(billingRoutes);
  return app;
}
