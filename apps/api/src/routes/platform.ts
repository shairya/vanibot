import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePlatformAdmin } from "../auth.js";
import { asSystem, one, query } from "../db.js";
import { ALL_CHANNELS, getPlan, plans, type PlanId } from "../core/plans.js";

// vanibot team console: every company, its plan and channels, and website demo requests.
export async function platformRoutes(app: FastifyInstance) {
  app.register(async (admin) => {
    admin.addHook("preHandler", requirePlatformAdmin);

    admin.get("/api/platform/tenants", async () =>
      asSystem(() =>
        query(
          `SELECT t.id, t.name, t.plan, t.status, t.channels, t.created_at,
                  (SELECT count(*) FROM bots b WHERE b.tenant_id = t.id)::int AS bots,
                  (SELECT count(*) FROM users u WHERE u.tenant_id = t.id)::int AS users,
                  (SELECT coalesce(sum(quantity), 0) FROM usage_events e WHERE e.tenant_id = t.id AND e.kind = 'conversation'
                     AND e.created_at >= date_trunc('month', now()))::int AS conversations_this_month,
                  (SELECT coalesce(sum(quantity), 0) FROM usage_events e WHERE e.tenant_id = t.id AND e.kind = 'voice_note'
                     AND e.created_at >= date_trunc('month', now()))::int AS voice_notes_this_month
             FROM tenants t ORDER BY t.created_at`,
        ),
      ),
    );

    admin.patch<{ Params: { id: string } }>("/api/platform/tenants/:id", async (req, reply) => {
      const body = z
        .object({
          plan: z.enum(Object.keys(plans) as [PlanId, ...PlanId[]]).optional(),
          channels: z.array(z.enum(ALL_CHANNELS as ["web", "whatsapp", "voice"])).optional(),
          status: z.enum(["active", "suspended"]).optional(),
          data_retention_days: z.number().int().min(7).max(3650).optional(),
        })
        .parse(req.body);
      // Changing the plan resets channels to the plan's, unless channels are given explicitly.
      const channels = body.channels ?? (body.plan ? getPlan(body.plan).channels : undefined);
      const row = await asSystem(() =>
        one(
          `UPDATE tenants SET plan = coalesce($2, plan), channels = coalesce($3, channels), status = coalesce($4, status),
                  data_retention_days = coalesce($5, data_retention_days)
            WHERE id = $1 RETURNING id`,
          [req.params.id, body.plan ?? null, channels ?? null, body.status ?? null, body.data_retention_days ?? null],
        ),
      );
      if (!row) return reply.code(404).send({ error: "Company not found." });
      return { ok: true };
    });

    admin.get("/api/platform/demo-requests", async () =>
      asSystem(() => query("SELECT id, name, company, email, phone, interest, message, created_at FROM demo_requests ORDER BY created_at DESC LIMIT 500")),
    );
  });
}
