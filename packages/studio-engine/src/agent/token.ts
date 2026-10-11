/**
 * The token a turn's MCP server uses to call the Studio API (spec 2026-10-10 agent-workspace §3.3, ADR-0001 item 183):
 * HMAC-SHA256 over its claims with `STUDIO_AGENT_TOKEN_SECRET`, valid until the turn's deadline, scoped to one message
 * of one thread of one project. The API still checks that the message is running and the person's role now.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { StudioRunError } from "../errors.js";

export interface AgentTokenClaims {
  /** The assistant message (turn) running. */
  msg: string;
  thread: string;
  project: string;
  video: string | null;
  /** The person whose message started the turn (or who confirmed the action). */
  sub: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const b64url = (b: Buffer) => b.toString("base64url");
const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest();

export function signAgentToken(claims: AgentTokenClaims, secret: string): string {
  if (secret.length < 16) throw new Error("STUDIO_AGENT_TOKEN_SECRET must have at least 16 characters");
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${b64url(sign(payload, secret))}`;
}

const bad = (why: string) => new StudioRunError("rejected", `token của lượt không hợp lệ: ${why}`, { code: "bad_agent_token" });

/** The claims of a valid, unexpired token; throws `bad_agent_token` otherwise. */
export function verifyAgentToken(token: string, secret: string, nowSeconds: number = Math.floor(Date.now() / 1000)): AgentTokenClaims {
  const [payload, mac, extra] = String(token ?? "").split(".");
  if (!payload || !mac || extra !== undefined) throw bad("sai dạng");
  const expected = sign(payload, secret);
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad("sai chữ ký");
  let claims: AgentTokenClaims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AgentTokenClaims; } catch { throw bad("sai dạng"); }
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds) throw bad("hết hạn");
  for (const k of ["msg", "thread", "project", "sub"] as const) if (typeof claims[k] !== "string" || !claims[k]) throw bad(`thiếu ${k}`);
  return claims;
}
