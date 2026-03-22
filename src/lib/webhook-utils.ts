/**
 * OMI webhook signature verification utilities.
 *
 * Extracted from the webhook route handler so the HMAC verification
 * logic is independently testable without spinning up a full HTTP server.
 */

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify an OMI webhook request's HMAC-SHA256 signature.
 *
 * @param rawBody       - The raw request body string (must not be parsed first)
 * @param signatureHeader - Value of the X-OMI-Signature header, or null if absent
 * @param warnFn        - Optional function to call with warning messages (defaults to console.warn)
 * @returns true if the signature is valid (or if dev-mode skips verification)
 */
export function verifyOmiSignature(
  rawBody: string,
  signatureHeader: string | null,
  warnFn: (msg: string) => void = (msg) => console.warn(msg),
): boolean {
  // Read the secret directly from process.env to avoid triggering full env
  // validation (which requires all vars) on cold starts in development.
  const secret = process.env.OMI_WEBHOOK_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      warnFn(
        "[webhook:omi] OMI_WEBHOOK_SECRET is not set — rejecting request in production",
      );
      return false;
    }
    // In development, warn and allow through for easier local testing.
    warnFn(
      "[webhook:omi] OMI_WEBHOOK_SECRET is not set — skipping signature verification (dev only)",
    );
    return true;
  }

  if (!signatureHeader) return false;

  const expected = `sha256=${createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex")}`;

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signatureHeader);

  // Lengths must match before calling timingSafeEqual (it throws on mismatch).
  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Compute the expected X-OMI-Signature header value for a given body and secret.
 * Useful for constructing test requests and seed payloads.
 */
export function computeOmiSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex")}`;
}
