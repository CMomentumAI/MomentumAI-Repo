/**
 * Structured server-side logger with PHI/secret redaction.
 *
 * Emits newline-delimited JSON to stdout (info/debug) and stderr (warn/error).
 * Railway's log collector captures both streams and forwards them to its
 * log aggregator, making structured JSON queryable.
 *
 * Sensitive field names listed in REDACT_KEYS are replaced with "[REDACTED]"
 * before any value reaches the output, providing a defence-in-depth backstop
 * against accidental PHI leakage when code passes the wrong data to a logger.
 */

type Level = "debug" | "info" | "warn" | "error";

/**
 * Keys whose values must never appear in logs regardless of caller intent.
 * Matched case-insensitively against object keys during redaction.
 */
const REDACT_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "secret",
  "apikey",
  "api_key",
  "transcript",
  "rawtranscript",
  "signedurl",
  "presignedurl",
]);

function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = REDACT_KEYS.has(k.toLowerCase())
      ? "[REDACTED]"
      : redactObject(v, depth + 1);
  }
  return result;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      // Stack traces may expose internal file paths — omit in production.
      ...(process.env.NODE_ENV !== "production" && { stack: error.stack }),
    };
  }
  if (error !== undefined && error !== null) {
    return { raw: String(error) };
  }
  return {};
}

function emit(
  level: Level,
  tag: string,
  message: string,
  fields: Record<string, unknown>,
): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    tag,
    message,
    ...fields,
  });
  if (level === "error" || level === "warn") {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

export const logger = {
  debug(tag: string, message: string, meta?: Record<string, unknown>): void {
    emit(
      "debug",
      tag,
      message,
      meta ? (redactObject(meta) as Record<string, unknown>) : {},
    );
  },

  info(tag: string, message: string, meta?: Record<string, unknown>): void {
    emit(
      "info",
      tag,
      message,
      meta ? (redactObject(meta) as Record<string, unknown>) : {},
    );
  },

  warn(tag: string, message: string, meta?: Record<string, unknown>): void {
    emit(
      "warn",
      tag,
      message,
      meta ? (redactObject(meta) as Record<string, unknown>) : {},
    );
  },

  error(
    tag: string,
    message: string,
    error?: unknown,
    meta?: Record<string, unknown>,
  ): void {
    const errFields = serializeError(error);
    const metaFields = meta
      ? (redactObject(meta) as Record<string, unknown>)
      : {};
    emit("error", tag, message, { err: errFields, ...metaFields });
  },
};
