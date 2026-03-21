/**
 * POST /api/auth/login
 * Authenticate a patient and return a signed JWT.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { getUserByEmail, verifyPassword } from "@/lib/users";
import { signToken } from "@/lib/auth";
import { successResponse, errorResponse } from "@/lib/api-helpers";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = LoginSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse("Invalid email or password", 400);
    }

    const { email, password } = parsed.data;

    const user = await getUserByEmail(email);

    if (!user) {
      // Constant-time failure — don't reveal whether email exists
      await new Promise((r) => setTimeout(r, 500));
      return errorResponse("Invalid email or password", 401);
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return errorResponse("Invalid email or password", 401);
    }

    const token = signToken({
      sub: user.id,
      email: user.email,
      name: user.name,
    });

    const { passwordHash: _pw, ...patient } = user;

    return successResponse({ patient, token }, "Logged in successfully");
  } catch (error) {
    console.error("[login]", error);
    return errorResponse("Internal server error", 500);
  }
}
