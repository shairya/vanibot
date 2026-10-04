import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { asSystem, one, setRequestTenant } from "./db.js";

export type AuthUser = { userId: string; tenantId: string; email: string; isPlatformAdmin: boolean; homeTenantId: string };

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function signToken(user: { userId: string; tenantId: string; email: string }) {
  return jwt.sign({ userId: user.userId, tenantId: user.tenantId, email: user.email }, config.jwtSecret, { expiresIn: "7d" });
}

/**
 * Authenticates a dashboard request and sets the acting company for row-level security.
 * vanibot team members (platform admins) may act for another company by sending the X-Act-As-Tenant header.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  let payload: { userId: string; tenantId: string; email: string };
  try {
    payload = jwt.verify(token, config.jwtSecret) as typeof payload;
  } catch {
    return reply.code(401).send({ error: "Please log in." });
  }
  // Re-check the user on every request so removed users and admin rights take effect immediately.
  const user = await asSystem(() =>
    one<{ id: string; tenant_id: string; email: string; is_platform_admin: boolean; tenant_status: string }>(
      "SELECT u.id, u.tenant_id, u.email, u.is_platform_admin, t.status AS tenant_status FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1",
      [payload.userId],
    ),
  );
  if (!user) return reply.code(401).send({ error: "Please log in." });
  if (user.tenant_status !== "active" && !user.is_platform_admin) return reply.code(403).send({ error: "This account is suspended." });

  let tenantId = user.tenant_id;
  const actAs = req.headers["x-act-as-tenant"];
  if (typeof actAs === "string" && actAs && actAs !== user.tenant_id) {
    if (!user.is_platform_admin) return reply.code(403).send({ error: "Not allowed." });
    if (!/^[0-9a-f-]{36}$/.test(actAs)) return reply.code(400).send({ error: "Bad company id." });
    tenantId = actAs;
  }
  req.user = { userId: user.id, tenantId, email: user.email, isPlatformAdmin: user.is_platform_admin, homeTenantId: user.tenant_id };
  setRequestTenant(tenantId);
}

export async function requirePlatformAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (!req.user?.isPlatformAdmin) return reply.code(403).send({ error: "vanibot team only." });
}
