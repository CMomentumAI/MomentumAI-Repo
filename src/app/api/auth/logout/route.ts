/**
 * POST /api/auth/logout
 *
 * Invalidates the caller's current JWT by adding it to the in-memory token
 * denylist. Subsequent requests that present the same token will receive 401.
 *
 * IMPORTANT LIMITATIONS (by design for this deployment model):
 *  - The denylist is in-process. It does NOT survive a container restart or
 *    Cloud Run redeploy. After a restart, the revoked token is valid again until
 *    its natural 7-day expiry.
 *  - On multi-replica deployments only the handling replica denies the token.
 *    Use a shared store (Redis / Railway Valkey) for cluster-wide revocation.
 *
 * Clients MUST discard the token on their side regardless of the server
 * response — this endpoint improves security hygiene but the client-side
 * drop is the primary logout mechanism given the stateless JWT model.
 */

import { NextRequest } from "next/server";
import { requireAuth, successResponse, getRequestId } from "@/lib/api-helpers";
import { denyToken } from "@/lib/token-denylist";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  const authResult = requireAuth(request);
  if ("status" in authResult) return authResult;

  const { user } = authResult;

  denyToken(user);

  logger.info("auth:logout", "Token revoked", {
    requestId,
    userId: user.sub,
  });

  return successResponse(
    null,
    "Logged out. Discard your token — it has been revoked server-side.",
  );
}
