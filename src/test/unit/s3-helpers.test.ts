/**
 * Tests for pure S3 utility functions.
 *
 * We test only the validation/key-building logic here — no S3 client is
 * instantiated and no network calls are made.  Upload/download functions
 * require AWS SDK mocking and are left to integration-level tests.
 */

import { describe, it, expect } from "vitest";
import {
  buildS3Key,
  buildSystemKey,
  validateContentType,
  validateByteSize,
  S3StorageError,
  MAX_BYTE_SIZES,
  type S3Category,
} from "@/lib/s3";

// ─── buildS3Key ───────────────────────────────────────────────────────────────

describe("buildS3Key", () => {
  it("produces the correct key structure with env prefix", () => {
    // NODE_ENV is "test" → prefix is "development"
    const key = buildS3Key("user-abc-123", "transcripts", "appt_transcript.txt");
    expect(key).toBe("development/patients/user-abc-123/transcripts/appt_transcript.txt");
  });

  it("includes the category in the key path", () => {
    const key = buildS3Key("user-1", "summaries", "summary.json");
    expect(key).toContain("/summaries/");
  });

  it("accepts all valid categories", () => {
    const categories: S3Category[] = [
      "appointments",
      "transcripts",
      "summaries",
      "audio",
      "embeddings",
      "forms",
    ];
    for (const cat of categories) {
      expect(() => buildS3Key("user-1", cat, "file.json")).not.toThrow();
    }
  });

  describe("patientId validation", () => {
    it("accepts valid UUID-shaped patientId", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      expect(() => buildS3Key(uuid, "transcripts", "t.txt")).not.toThrow();
    });

    it("rejects a patientId with path traversal (..)", () => {
      expect(() => buildS3Key("../etc/passwd", "transcripts", "t.txt")).toThrow(
        S3StorageError,
      );
    });

    it("rejects a patientId containing a forward slash", () => {
      expect(() => buildS3Key("user/admin", "transcripts", "t.txt")).toThrow(
        S3StorageError,
      );
    });

    it("rejects a patientId with special characters", () => {
      expect(() => buildS3Key("user@email.com", "transcripts", "t.txt")).toThrow(
        S3StorageError,
      );
    });

    it("rejects an empty patientId", () => {
      expect(() => buildS3Key("", "transcripts", "t.txt")).toThrow(S3StorageError);
    });
  });

  describe("filename validation", () => {
    it("accepts filenames with letters, digits, dots, underscores, and hyphens", () => {
      expect(() =>
        buildS3Key("user-1", "transcripts", "appt_123-abc.txt"),
      ).not.toThrow();
    });

    it("rejects a filename containing path traversal (..)", () => {
      expect(() =>
        buildS3Key("user-1", "transcripts", "../../../etc/passwd"),
      ).toThrow(S3StorageError);
    });

    it("rejects a filename containing a forward slash", () => {
      expect(() =>
        buildS3Key("user-1", "transcripts", "sub/dir/file.txt"),
      ).toThrow(S3StorageError);
    });

    it("rejects an empty filename", () => {
      expect(() => buildS3Key("user-1", "transcripts", "")).toThrow(S3StorageError);
    });
  });
});

// ─── buildSystemKey ───────────────────────────────────────────────────────────

describe("buildSystemKey", () => {
  it("produces the correct system key structure", () => {
    const key = buildSystemKey("users/abc123.json");
    expect(key).toBe("development/system/users/abc123.json");
  });

  it("rejects path traversal", () => {
    expect(() => buildSystemKey("../etc/shadow")).toThrow(S3StorageError);
    expect(() => buildSystemKey("users/../../etc")).toThrow(S3StorageError);
  });

  it("rejects a leading slash", () => {
    expect(() => buildSystemKey("/etc/passwd")).toThrow(S3StorageError);
  });

  it("rejects an empty path", () => {
    expect(() => buildSystemKey("")).toThrow(S3StorageError);
  });
});

// ─── validateContentType ──────────────────────────────────────────────────────

describe("validateContentType", () => {
  it.each([
    ["appointments", "application/json"],
    ["transcripts", "text/plain"],
    ["transcripts", "application/json"],
    ["summaries", "application/json"],
    ["audio", "audio/mpeg"],
    ["audio", "audio/wav"],
    ["embeddings", "application/json"],
    ["forms", "application/json"],
  ] as [S3Category, string][])(
    "%s accepts %s",
    (category, contentType) => {
      expect(() => validateContentType(category, contentType)).not.toThrow();
    },
  );

  it.each([
    ["appointments", "text/plain"],
    ["transcripts", "audio/mpeg"],
    ["summaries", "text/html"],
    ["audio", "application/json"],
    ["forms", "text/plain"],
  ] as [S3Category, string][])(
    "%s rejects %s",
    (category, contentType) => {
      expect(() => validateContentType(category, contentType)).toThrow(S3StorageError);
      try {
        validateContentType(category, contentType);
      } catch (e) {
        expect((e as S3StorageError).code).toBe("INVALID_CONTENT_TYPE");
      }
    },
  );
});

// ─── validateByteSize ─────────────────────────────────────────────────────────

describe("validateByteSize", () => {
  it("passes when size is exactly at the limit", () => {
    expect(() =>
      validateByteSize("transcripts", MAX_BYTE_SIZES.transcripts),
    ).not.toThrow();
  });

  it("throws SIZE_EXCEEDED when one byte over the limit", () => {
    expect(() =>
      validateByteSize("transcripts", MAX_BYTE_SIZES.transcripts + 1),
    ).toThrow(S3StorageError);

    try {
      validateByteSize("transcripts", MAX_BYTE_SIZES.transcripts + 1);
    } catch (e) {
      expect((e as S3StorageError).code).toBe("SIZE_EXCEEDED");
    }
  });

  it("enforces different limits per category", () => {
    // forms (128 KB) is much smaller than audio (50 MB)
    expect(() =>
      validateByteSize("forms", MAX_BYTE_SIZES.forms + 1),
    ).toThrow(S3StorageError);

    // Same size is fine for audio
    expect(() =>
      validateByteSize("audio", MAX_BYTE_SIZES.forms + 1),
    ).not.toThrow();
  });
});

// ─── S3StorageError ───────────────────────────────────────────────────────────

describe("S3StorageError", () => {
  it("sets name, code, and key correctly", () => {
    const err = new S3StorageError("object missing", "NOT_FOUND", "some/key");
    expect(err.name).toBe("S3StorageError");
    expect(err.message).toBe("object missing");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.key).toBe("some/key");
    expect(err instanceof Error).toBe(true);
  });

  it("key is optional", () => {
    const err = new S3StorageError("upload failed", "UPLOAD_FAILED");
    expect(err.key).toBeUndefined();
  });
});
