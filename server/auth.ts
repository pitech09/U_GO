import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import type { User, UserRole } from "@shared/schema";

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  iat: number;
  exp: number;
}

const scrypt = promisify(scryptCallback);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith('scrypt$')) {
    // Compatibility path for accounts created before password hashing. The
    // caller should upgrade the stored value after a successful login.
    return password === stored;
  }
  const [, salt, expectedHex] = stored.split('$');
  if (!salt || !expectedHex) return false;
  const derived = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function authSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be configured in production");
  }
  return secret || "rideflow-development-secret-change-me";
}

export function signAccessToken(user: User): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    sub: user.id,
    role: user.role,
    iat: now,
    exp: now + Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 7),
  };
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = base64Url(createHmac("sha256", authSecret()).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

export function verifyAccessToken(token: string | null | undefined): AccessTokenClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  const expected = base64Url(createHmac("sha256", authSecret()).update(`${header}.${payload}`).digest());
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenClaims;
    if (!claims.sub || !claims.role || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function tokenFromRequest(req: Request): string | null {
  const authorization = req.header("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
}

export function requireAccessToken(req: Request, res: Response, next: NextFunction) {
  const claims = verifyAccessToken(tokenFromRequest(req));
  if (!claims) return res.status(401).json({ message: "Authentication required" });
  res.locals.auth = claims;
  return next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (res.locals.auth?.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  return next();
}
