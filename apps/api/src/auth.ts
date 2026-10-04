import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

export type AuthUser = { userId: string; tenantId: string; email: string };

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function signToken(user: AuthUser) {
  return jwt.sign(user, config.jwtSecret, { expiresIn: "7d" });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AuthUser;
    req.user = { userId: payload.userId, tenantId: payload.tenantId, email: payload.email };
  } catch {
    return reply.code(401).send({ error: "Please log in." });
  }
}
