import { createHmac } from "node:crypto";
import { asSystem, currentTenantId, one, query, withTenant } from "../db.js";

// A tiny Postgres-backed job queue: no Redis needed for local development or small deployments.

export type JobKind = "ingest_document" | "deliver_webhook" | "whatsapp_inbound" | "retention_cleanup";

/** Queues a job. Company jobs carry their tenant and later run inside that company's isolation context. */
export async function enqueue(kind: JobKind, payload: Record<string, unknown>, tenantId?: string | null) {
  const tenant = tenantId === undefined ? currentTenantId() : tenantId;
  await query("INSERT INTO jobs(kind, payload, tenant_id) VALUES ($1, $2, $3)", [kind, payload, tenant]);
}

type Handler = (payload: any) => Promise<void>;
const handlers = new Map<JobKind, Handler>();

export function registerJobHandler(kind: JobKind, handler: Handler) {
  handlers.set(kind, handler);
}

const MAX_ATTEMPTS = 6;

// Claiming crosses companies, so it runs as the platform; the handler then runs as the job's company only.
async function claimJob() {
  return asSystem(() => one(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING id, kind, payload, attempts, tenant_id`,
  ));
}

export async function runOneJob(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  const handler = handlers.get(job.kind);
  try {
    if (!handler) throw new Error(`No handler for job kind ${job.kind}`);
    if (job.tenant_id) await withTenant(job.tenant_id, () => handler(job.payload));
    else await asSystem(() => handler(job.payload));
    await asSystem(() => query("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = $1", [job.id]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const giveUp = job.attempts >= MAX_ATTEMPTS;
    // Exponential backoff: 30s, 1m, 2m, 4m, 8m
    const delaySeconds = 30 * 2 ** (job.attempts - 1);
    await asSystem(() =>
      query(`UPDATE jobs SET status = $2, last_error = $3, run_at = now() + ($4 || ' seconds')::interval WHERE id = $1`, [
        job.id,
        giveUp ? "failed" : "queued",
        message.slice(0, 2000),
        String(delaySeconds),
      ]),
    );
  }
  return true;
}

export function startWorker(log: { error: (o: unknown, msg: string) => void }) {
  let stopped = false;
  // Data retention: once an hour, queue a cleanup unless one is already waiting.
  const scheduleCleanup = () =>
    asSystem(async () => {
      const waiting = await one("SELECT 1 FROM jobs WHERE kind = 'retention_cleanup' AND status IN ('queued', 'running')");
      if (!waiting) await enqueue("retention_cleanup", {}, null);
    }).catch((err) => log.error(err, "could not schedule retention cleanup"));
  void scheduleCleanup();
  const cleanupTimer = setInterval(scheduleCleanup, 60 * 60 * 1000);
  cleanupTimer.unref();
  const loop = async () => {
    while (!stopped) {
      try {
        const didWork = await runOneJob();
        if (!didWork) await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        log.error(err, "job worker error");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
    clearInterval(cleanupTimer);
  };
}

// ---- Outbound webhooks ----

export function signWebhook(secret: string, timestamp: string, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export async function queueWebhook(botId: string, tenantId: string, event: string, data: Record<string, unknown>) {
  const bot = await one("SELECT webhook_url FROM bots WHERE id = $1 AND tenant_id = $2", [botId, tenantId]);
  if (!bot?.webhook_url) return;
  await enqueue("deliver_webhook", { botId, tenantId, event, data, createdAt: new Date().toISOString() }, tenantId);
}

registerJobHandler("deliver_webhook", async (p) => {
  const bot = await one("SELECT webhook_url, webhook_secret FROM bots WHERE id = $1 AND tenant_id = $2", [p.botId, p.tenantId]);
  if (!bot?.webhook_url) return;
  const body = JSON.stringify({ event: p.event, bot_id: p.botId, created_at: p.createdAt, data: p.data });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const res = await fetch(bot.webhook_url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "vanibot-webhooks/1.0",
      "x-vanibot-event": p.event,
      "x-vanibot-timestamp": timestamp,
      "x-vanibot-signature": signWebhook(bot.webhook_secret, timestamp, body),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
});

// ---- Data retention ----
// Deletes each company's conversations (with their messages) older than its retention period, plus old job and
// WhatsApp de-duplication rows. Leads are kept: they belong to the company until it deletes them.
registerJobHandler("retention_cleanup", async () => {
  await query(
    `DELETE FROM conversations c USING tenants t
      WHERE c.tenant_id = t.id AND c.updated_at < now() - make_interval(days => t.data_retention_days)`,
  );
  await query("DELETE FROM whatsapp_inbound WHERE created_at < now() - interval '7 days'");
  await query("DELETE FROM jobs WHERE status IN ('done', 'failed') AND created_at < now() - interval '30 days'");
});
