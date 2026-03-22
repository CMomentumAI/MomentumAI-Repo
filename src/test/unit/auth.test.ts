import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  extractTokenFromHeader,
  type JWTPayload,
} from "@/lib/auth";

const TEST_SECRET = process.env.JWT_SECRET!;

const SAMPLE_PAYLOAD: Omit<JWTPayload, "iat" | "exp"> = {
  sub: "user-123",
  email: "patient@example.com",
  name: "Test Patient",
};

describe("signToken / verifyToken", () => {
  it("round-trips a payload correctly", () => {
    const token = signToken(SAMPLE_PAYLOAD);
    const decoded = verifyToken(token);

    expect(decoded.sub).toBe(SAMPLE_PAYLOAD.sub);
    expect(decoded.email).toBe(SAMPLE_PAYLOAD.email);
    expect(decoded.name).toBe(SAMPLE_PAYLOAD.name);
  });

  it("includes iat and exp claims", () => {
    const token = signToken(SAMPLE_PAYLOAD);
    const decoded = verifyToken(token);

    expect(typeof decoded.iat).toBe("number");
    expect(typeof decoded.exp).toBe("number");
    // 7-day expiry: exp should be roughly 7 days ahead of iat
    expect(decoded.exp! - decoded.iat!).toBeGreaterThan(6 * 24 * 60 * 60);
  });

  it("rejects a token signed with a different secret", () => {
    const wrongToken = jwt.sign(SAMPLE_PAYLOAD, "completely-different-secret");
    expect(() => verifyToken(wrongToken)).toThrow();
  });

  it("rejects an expired token", () => {
    const expiredToken = jwt.sign(SAMPLE_PAYLOAD, TEST_SECRET, {
      expiresIn: -1,
    });
    expect(() => verifyToken(expiredToken)).toThrow();
  });

  it("rejects a tampered token", () => {
    const token = signToken(SAMPLE_PAYLOAD);
    const parts = token.split(".");
    // Tamper with the payload segment
    const tamperedToken = `${parts[0]}.${parts[1]}X.${parts[2]}`;
    expect(() => verifyToken(tamperedToken)).toThrow();
  });
});

describe("extractTokenFromHeader", () => {
  it("returns the decoded payload for a valid Bearer token", () => {
    const token = signToken(SAMPLE_PAYLOAD);
    const result = extractTokenFromHeader(`Bearer ${token}`);

    expect(result).not.toBeNull();
    expect(result!.sub).toBe(SAMPLE_PAYLOAD.sub);
  });

  it("returns null for a null Authorization header", () => {
    expect(extractTokenFromHeader(null)).toBeNull();
  });

  it("returns null when Authorization header lacks the 'Bearer ' prefix", () => {
    const token = signToken(SAMPLE_PAYLOAD);
    expect(extractTokenFromHeader(token)).toBeNull();
    expect(extractTokenFromHeader(`Basic ${token}`)).toBeNull();
    expect(extractTokenFromHeader(`bearer ${token}`)).toBeNull();
  });

  it("returns null for a malformed token string", () => {
    expect(extractTokenFromHeader("Bearer not.a.valid.jwt")).toBeNull();
  });

  it("returns null for an expired token in the Authorization header", () => {
    const expiredToken = jwt.sign(SAMPLE_PAYLOAD, TEST_SECRET, {
      expiresIn: -1,
    });
    expect(extractTokenFromHeader(`Bearer ${expiredToken}`)).toBeNull();
  });

  it("returns null for a token signed with the wrong secret", () => {
    const badToken = jwt.sign(SAMPLE_PAYLOAD, "wrong-secret");
    expect(extractTokenFromHeader(`Bearer ${badToken}`)).toBeNull();
  });
});
