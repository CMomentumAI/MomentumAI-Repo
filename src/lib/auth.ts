/**
 * Auth utilities — JWT-based session tokens.
 */

import jwt from "jsonwebtoken";

export interface JWTPayload {
  sub: string;  // userId
  email: string;
  name: string;
  iat?: number;
  exp?: number;
}

const TOKEN_EXPIRY = "7d";

function getSecret(): string {
  const secret = process.env.JWT_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable must be set.");
  }
  return secret;
}

export function signToken(payload: Omit<JWTPayload, "iat" | "exp">): string {
  return jwt.sign(payload, getSecret(), { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, getSecret()) as JWTPayload;
}

/**
 * Extract and verify a Bearer token from an Authorization header.
 * Returns null if the token is missing or invalid.
 */
export function extractTokenFromHeader(
  authHeader: string | null,
): JWTPayload | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}
