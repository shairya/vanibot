import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/**
 * Tenant isolation, layer 2: every query runs inside a transaction that tells Postgres which tenant is acting
 * (app.tenant_id). Row-level security policies on every tenant table then hide all other tenants' rows, even if
 * application code forgets a WHERE clause. Queries without a context fail closed: they see no tenant rows.
 *
 * - withTenant(id, fn): normal work for one company
 * - asSystem(fn): platform-level work that must cross tenants (login lookup, routing a webhook to its bot,
 *   the job worker claiming jobs, vanibot team admin). Keep these blocks small.
 */
type DbContext = { tenantId: string | null; system: boolean };
const als = new AsyncLocalStorage<DbContext>();

export function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ tenantId, system: false }, fn);
}

export function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({ tenantId: als.getStore()?.tenantId ?? null, system: true }, fn);
}

export type RequestDbContext = DbContext;

/** Starts an empty context for a request; the tenant is filled in once it is known (login token, bot key...). */
export function runInRequestContext(fn: () => void): DbContext {
  const ctx: DbContext = { tenantId: null, system: false };
  als.run(ctx, fn);
  return ctx;
}

/** Re-enters a request's context (body parsing can lose async context between Fastify hooks). */
export function reenterContext(ctx: DbContext, fn: () => void) {
  als.run(ctx, fn);
}

/** Sets the acting tenant for the rest of the current request. */
export function setRequestTenant(tenantId: string) {
  const store = als.getStore();
  if (!store) throw new Error("No request context");
  store.tenantId = tenantId;
}

export function currentTenantId(): string | null {
  return (als.getStore() ?? scriptContext)?.tenantId ?? null;
}

// Scripts and tests (not the server) may set a context for code that runs outside any withTenant/asSystem block.
let scriptContext: DbContext | null = null;
export function setScriptContext(ctx: { tenantId?: string | null; system?: boolean } | null) {
  scriptContext = ctx ? { tenantId: ctx.tenantId ?? null, system: ctx.system ?? false } : null;
}

async function applyContext(client: pg.PoolClient) {
  const ctx = als.getStore() ?? scriptContext;
  await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass_rls', $2, true)", [
    ctx?.tenantId ?? "",
    ctx?.system ? "on" : "off",
  ]);
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applyContext(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return withTransaction(async (client) => (await client.query<T>(text, params)).rows);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** Refuses to run with a database role that silently skips row-level security. */
export async function checkIsolationEnforced(): Promise<{ ok: boolean; role: string }> {
  const { rows } = await pool.query("SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  const r = rows[0];
  return { ok: !r.rolsuper && !r.rolbypassrls, role: r.role };
}
