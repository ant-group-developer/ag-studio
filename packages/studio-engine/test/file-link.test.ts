import { describe, expect, it } from "vitest";
import { signAgentToken, signFileLink, verifyAgentToken, verifyFileLink } from "../src/index.js";

const SECRET = "s".repeat(32);
const claims = { project: "p1", path: "context/audio/nhac.mp3", sub: "auth0|u", exp: 2000 };

describe("workspace file link", () => {
  it("round-trips its claims while valid", () => {
    expect(verifyFileLink(signFileLink(claims, SECRET), SECRET, 1999)).toEqual(claims);
  });

  it("refuses an expired, altered, foreign or malformed link", () => {
    const token = signFileLink(claims, SECRET);
    expect(() => verifyFileLink(token, SECRET, 2001)).toThrow(/hết hạn/);
    expect(() => verifyFileLink(token, "x".repeat(32), 1)).toThrow(/chữ ký/);
    const [, mac] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...claims, path: "CLAUDE.md" })).toString("base64url")}.${mac}`;
    expect(() => verifyFileLink(forged, SECRET, 1)).toThrow(/chữ ký/);
    for (const bad of ["", "a", "a.b.c", "!!.??"]) expect(() => verifyFileLink(bad, SECRET, 1)).toThrow(/link file/);
  });

  it("is not an agent token, nor the other way round, though both come from one secret", () => {
    const agent = signAgentToken({ msg: "m1", thread: "t1", project: "p1", video: null, sub: "auth0|u", exp: 2000 }, SECRET);
    expect(() => verifyFileLink(agent, SECRET, 1)).toThrow(/chữ ký/);
    expect(() => verifyAgentToken(signFileLink(claims, SECRET), SECRET, 1)).toThrow(/chữ ký/);
  });

  it("needs a secret long enough", () => {
    expect(() => signFileLink(claims, "short")).toThrow(/16/);
  });
});
