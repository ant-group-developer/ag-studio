/**
 * Secrets Studio keeps in its database (Claude tokens, plan 2026-10-30): sealed with AES-256-GCM under
 * `STUDIO_SECRET_KEY`, which the API (to seal) and the worker (to open) both have. The key never goes in the database;
 * losing it means entering the tokens again.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { HarnessError } from "@harness/contracts";

const PREFIX = "v1:";

/** The key from `STUDIO_SECRET_KEY` (any text of 16 characters or more); null when unset. */
export function secretKey(raw: string | undefined): Buffer | null {
  const s = raw?.trim();
  if (!s) return null;
  if (s.length < 16) throw new HarnessError("CONFIG_INVALID", "STUDIO_SECRET_KEY must be at least 16 characters");
  return createHash("sha256").update(s, "utf8").digest();
}

export function sealSecret(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** Throws when the text was not sealed with this key (another key, or changed). */
export function openSecret(key: Buffer, sealed: string): string {
  if (!sealed.startsWith(PREFIX)) throw new HarnessError("CONFIG_INVALID", "unknown secret format");
  const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
