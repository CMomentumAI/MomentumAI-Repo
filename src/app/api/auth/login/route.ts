/**
 * POST /api/auth/login
 * Authenticate a patient and return a signed JWT.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { getUserByEmail, verifyPassword } from "@/lib/users";
import { signToken } from "@/lib/auth";
import {
  successResponse,
  errorResponse,
  rateLimitResponse,
  getRequestId,
} from "@/lib/api-helpers";
import { logger } from "@/lib/logger";
import { authLimiter, getClientIp } from "@/lib/rate-limit";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);

  // Rate-limit by client IP to slow credential-stuffing attacks.
  const ip = getClientIp(request);
  const rl = authLimiter.check(ip);
  if (!rl.allowed) {
    logger.warn("auth:login", "Rate limit exceeded", { requestId, ip });
    return rateLimitResponse(rl.resetAt);
  }

  try {
    const body = await request.json();
    const parsed = LoginSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse("Invalid email or password", 400);
    }

    const { email, password } = parsed.data;

    const user = await getUserByEmail(email);

    if (!user) {
      // Constant-time failure — don't reveal whether the email exists.
      await new Promise((r) => setTimeout(r, 500));
      // Audit failed attempt without logging the email (PHI).
      logger.warn("auth:login", "Login failed — email not found", {
        requestId,
        ip,
      });
      return errorResponse("Invalid email or password", 401);
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      logger.warn("auth:login", "Login failed — wrong password", {
        requestId,
        userId: user.id,
      });
      return errorResponse("Invalid email or password", 401);
    }

    const token = signToken({
      sub: user.id,
      email: user.email,
      name: user.name,
    });

    const { passwordHash: _pw, ...patient } = user;

    logger.info("auth:login", "Login successful", {
      requestId,
      userId: user.id,
    });

    return successResponse({ patient, token }, "Logged in successfully");
  } catch (error) {
    logger.error("auth:login", "Login failed unexpectedly", error, {
      requestId,
    });
    return errorResponse("Internal server error", 500);
  }
}
