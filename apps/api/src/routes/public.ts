import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asSystem, query } from "../db.js";
import { plans } from "../core/plans.js";
import { templates } from "../templates/index.js";

// Unauthenticated endpoints used by the vanibot marketing website.
const recent = new Map<string, number[]>();
function rateLimited(ip: string, max = 5, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > max;
}

export async function publicRoutes(app: FastifyInstance) {
  app.get("/api/public/plans", async () => Object.values(plans));

  app.get("/api/public/industries", async () => Object.values(templates).map((t) => ({ id: t.id, name: t.name, description: t.description })));

  app.post("/api/public/demo-requests", async (req, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        company: z.string().trim().min(1).max(160),
        email: z.string().trim().email().max(200),
        phone: z.string().trim().max(30).optional().or(z.literal("")),
        interest: z.enum(["chat", "voice", "chat_voice", "not_sure"]).optional(),
        message: z.string().trim().max(2000).optional().or(z.literal("")),
        website: z.string().optional(), // honeypot: real people leave it empty
      })
      .parse(req.body);
    if (body.website) return { ok: true };
    if (rateLimited(req.ip)) return reply.code(429).send({ error: "Too many requests. Please try again later." });
    await asSystem(() =>
      query("INSERT INTO demo_requests(name, company, email, phone, interest, message) VALUES ($1, $2, $3, $4, $5, $6)", [
        body.name,
        body.company,
        body.email.toLowerCase(),
        body.phone || null,
        body.interest ?? null,
        body.message || null,
      ]),
    );
    return { ok: true };
  });
}
