import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { one, query } from "../db.js";

// Subscriptions via Stripe Checkout + Customer Portal. Stripe is the source of truth for what a tenant pays;
// the webhook mirrors the active price onto tenants.plan, which drives the limits in core/plans.ts.

let stripeClient: Stripe | null = null;
function stripe(): Stripe {
  if (!config.stripe.secretKey) throw Object.assign(new Error("Billing is not configured (STRIPE_SECRET_KEY is empty)."), { statusCode: 501 });
  stripeClient ??= new Stripe(config.stripe.secretKey);
  return stripeClient;
}

function planForPrice(priceId: string | undefined): string | null {
  for (const [plan, id] of Object.entries(config.stripe.prices)) if (id && id === priceId) return plan;
  return null;
}

async function syncSubscription(sub: Stripe.Subscription) {
  const plan = planForPrice(sub.items.data[0]?.price.id) ?? "starter";
  const active = ["active", "trialing", "past_due"].includes(sub.status);
  await query(
    `UPDATE tenants SET plan = $2, plan_status = $3, stripe_subscription_id = $4 WHERE stripe_customer_id = $1`,
    [typeof sub.customer === "string" ? sub.customer : sub.customer.id, active ? plan : "trial", active ? "active" : sub.status, sub.id],
  );
}

export async function billingRoutes(app: FastifyInstance) {
  app.register(async (secured) => {
    secured.addHook("preHandler", requireAuth);

    secured.post("/api/billing/checkout", async (req, reply) => {
      const { plan } = z.object({ plan: z.enum(["starter", "growth", "business"]) }).parse(req.body);
      stripe();
      const price = config.stripe.prices[plan];
      if (!price) return reply.code(501).send({ error: `No Stripe price configured for ${plan} (STRIPE_PRICE_${plan.toUpperCase()}).` });
      const tenant = await one("SELECT id, name, stripe_customer_id FROM tenants WHERE id = $1", [req.user!.tenantId]);
      let customer = tenant.stripe_customer_id as string | null;
      if (!customer) {
        customer = (await stripe().customers.create({ name: tenant.name, email: req.user!.email, metadata: { tenant_id: tenant.id } })).id;
        await query("UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1", [tenant.id, customer]);
      }
      const session = await stripe().checkout.sessions.create({
        mode: "subscription",
        customer,
        line_items: [{ price, quantity: 1 }],
        client_reference_id: tenant.id,
        success_url: `${config.dashboardUrl}/#/billing?status=success`,
        cancel_url: `${config.dashboardUrl}/#/billing?status=cancelled`,
      });
      return { url: session.url };
    });

    secured.post("/api/billing/portal", async (req, reply) => {
      const tenant = await one("SELECT stripe_customer_id FROM tenants WHERE id = $1", [req.user!.tenantId]);
      if (!tenant.stripe_customer_id) return reply.code(400).send({ error: "No subscription yet." });
      const session = await stripe().billingPortal.sessions.create({ customer: tenant.stripe_customer_id, return_url: `${config.dashboardUrl}/#/billing` });
      return { url: session.url };
    });
  });

  // Stripe needs the raw body to verify the signature, so this route gets its own JSON parser.
  app.register(async (raw) => {
    raw.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    raw.post("/api/billing/webhook", async (req, reply) => {
      let event: Stripe.Event;
      try {
        event = stripe().webhooks.constructEvent(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""), config.stripe.webhookSecret);
      } catch (err) {
        return reply.code(400).send({ error: `Webhook signature check failed: ${err instanceof Error ? err.message : err}` });
      }
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          if (session.subscription) {
            const sub = await stripe().subscriptions.retrieve(String(session.subscription));
            await syncSubscription(sub);
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          await syncSubscription(event.data.object);
          break;
      }
      return { received: true };
    });
  });
}
