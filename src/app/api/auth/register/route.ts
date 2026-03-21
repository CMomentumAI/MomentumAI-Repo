/**
 * POST /api/auth/register
 * Create a new patient account.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { createUser } from "@/lib/users";
import { signToken } from "@/lib/auth";
import { successResponse, errorResponse } from "@/lib/api-helpers";

const RegisterSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
  name: z.string().min(1, "Name is required").max(100),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = RegisterSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
    }

    const { email, password, name } = parsed.data;

    const patient = await createUser(email, password, name);

    const token = signToken({
      sub: patient.id,
      email: patient.email,
      name: patient.name,
    });

    return successResponse(
      { patient, token },
      "Account created successfully",
      201,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create account";

    if (message.includes("already exists")) {
      return errorResponse(message, 409);
    }

    console.error("[register]", error);
    return errorResponse("Internal server error", 500);
  }
}
