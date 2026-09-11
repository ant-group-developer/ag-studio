import { describe, expect, it } from "vitest";
import { isHarnessError } from "@harness/contracts";
import { EnvSecretResolver } from "../../src/config/secrets.js";

describe("EnvSecretResolver", () => {
  it("maps secret refs to env vars and remembers resolved values", () => {
    const r = new EnvSecretResolver({ HARNESS_SECRET_TTS_MAIN: "tok-123", HARNESS_SECRET_YOUTUBE_CHANNEL_01: "yt-456" });
    expect(r.resolve("secret://tts/main")).toBe("tok-123");
    expect(r.resolve("secret://youtube/channel-01")).toBe("yt-456");
    expect(r.resolvedValues()).toEqual(["tok-123", "yt-456"]);
  });
  it("throws SECRET_UNRESOLVED for missing or malformed refs", () => {
    const r = new EnvSecretResolver({});
    for (const ref of ["secret://nope/x", "not-a-ref"]) {
      try { r.resolve(ref); throw new Error("no throw"); } catch (e) { expect(isHarnessError(e, "SECRET_UNRESOLVED")).toBe(true); }
    }
  });
});
