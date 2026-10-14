/**
 * A short link to play one workspace file in the browser (an `<audio>` or `<video>` element cannot send the person's
 * bearer token): HMAC-SHA256 over the project, the path, the person and an expiry, like the agent's turn token
 * (`agent/token.ts`), with a key of its own derived from the same secret so neither token passes for the other.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { StudioRunError } from "../errors.js";

export interface FileLinkClaims {
  project: string;
  /** The file, relative to the project's workspace. */
  path: string;
  /** The person the link was made for. */
  sub: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** How long a link plays: long enough to listen to a whole track, short enough not to be worth sharing. */
export const FILE_LINK_TTL_SECONDS = 15 * 60;

const b64url = (b: Buffer) => b.toString("base64url");
const keyOf = (secret: string) => createHmac("sha256", secret).update("studio-file-link").digest();
const sign = (payload: string, secret: string) => createHmac("sha256", keyOf(secret)).update(payload).digest();

export function signFileLink(claims: FileLinkClaims, secret: string): string {
  if (secret.length < 16) throw new Error("the file link secret must have at least 16 characters");
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${b64url(sign(payload, secret))}`;
}

const bad = (why: string) => new StudioRunError("rejected", `link file không hợp lệ: ${why}`, { code: "bad_file_link" });

/** The claims of a valid, unexpired link; throws `bad_file_link` otherwise. */
export function verifyFileLink(token: string, secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): FileLinkClaims {
  const [payload, mac, extra] = String(token ?? "").split(".");
  if (!payload || !mac || extra !== undefined) throw bad("sai dạng");
  const expected = sign(payload, secret);
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad("sai chữ ký");
  let claims: FileLinkClaims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as FileLinkClaims; } catch { throw bad("sai dạng"); }
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds) throw bad("hết hạn");
  for (const k of ["project", "path", "sub"] as const) if (typeof claims[k] !== "string" || !claims[k]) throw bad(`thiếu ${k}`);
  return claims;
}
