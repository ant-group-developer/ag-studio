import { describe, expect, it } from "vitest";
import { signAgentToken, verifyAgentToken } from "../src/index.js";

const SECRET = "s".repeat(32);
const claims = { msg: "m1", thread: "t1", project: "p1", video: null, sub: "auth0|u", exp: 2000 };

describe("agent turn token", () => {
  it("round-trips its claims while valid", () => {
    expect(verifyAgentToken(signAgentToken(claims, SECRET), SECRET, 1999)).toEqual(claims);
  });

  it("refuses an expired, altered, foreign or malformed token", () => {
    const token = signAgentToken(claims, SECRET);
    expect(() => verifyAgentToken(token, SECRET, 2001)).toThrow(/hết hạn/);
    expect(() => verifyAgentToken(token, "x".repeat(32), 1)).toThrow(/chữ ký/);
    const [, mac] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...claims, project: "p2" })).toString("base64url")}.${mac}`;
    expect(() => verifyAgentToken(forged, SECRET, 1)).toThrow(/chữ ký/);
    for (const bad of ["", "a", "a.b.c", "!!.??"]) expect(() => verifyAgentToken(bad, SECRET, 1)).toThrow(/token/);
  });

  it("needs a secret long enough", () => {
    expect(() => signAgentToken(claims, "short")).toThrow(/16/);
  });
});
