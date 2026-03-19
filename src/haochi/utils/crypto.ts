import crypto from "crypto";

import type {
  EncryptedPayload,
  PoolAbility,
  SecretHashPayload,
} from "@/haochi/types.ts";

export const ALL_ABILITIES: PoolAbility[] = ["images", "videos", "chat", "token"];

export function nowIso() {
  return new Date().toISOString();
}

export function deepClone<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function normalizeEmail(email: string) {
  return String(email || "").trim().toLowerCase();
}

export function clampNumber(value: any, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomId(prefix: string) {
  return `${prefix}_${randomToken(12)}`;
}

export function isEncryptionEnabled(secret?: string) {
  return !!(secret && String(secret).length >= 8);
}

function sha256Key(secret: string) {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest();
}

export function isEncryptedPayload(payload: any): payload is EncryptedPayload {
  return !!(
    payload &&
    typeof payload === "object" &&
    payload.alg &&
    payload.iv &&
    payload.tag &&
    payload.data
  );
}

export function encryptString(plain: string, secret: string): EncryptedPayload {
  const key = sha256Key(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plain || ""), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

export function decryptString(payload: EncryptedPayload, secret: string) {
  const key = sha256Key(secret);
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const data = Buffer.from(payload.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString("utf8");
}

export function createSecretHash(secret: string, salt = randomToken(16)): SecretHashPayload {
  const hash = crypto
    .scryptSync(String(secret), salt, 64)
    .toString("base64");
  return { salt, hash };
}

export function verifySecret(secret: string, payload: SecretHashPayload) {
  const expected = Buffer.from(payload.hash, "base64");
  const actual = crypto.scryptSync(String(secret), payload.salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function maskSecret(value?: string | null, left = 6, right = 4) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= left + right) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, left)}***${text.slice(-right)}`;
}

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseCookieHeader(header?: string | null) {
  return String(header || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, item) => {
      const index = item.indexOf("=");
      if (index <= 0) return acc;
      const key = item.slice(0, index).trim();
      const value = item.slice(index + 1).trim();
      if (key) acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

export function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  } = {}
) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (typeof options.maxAge === "number") parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAge))}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseBoolean(value: any, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}
