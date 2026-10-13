/** yt-dlp through the fake (`fixtures/fake-yt-dlp.mjs`): no network. The download case needs ffmpeg (FFMPEG_PATH). */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyYtDlp, detectCuts, YtDlpError, YTDLP_COMMON_ARGS, ytDlp, ytVideoMeta } from "../src/index.js";
import { hasFfmpeg } from "../../../tests/media.js";
import { ROOT } from "./helpers.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FAKE = [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")];

describe("yt-dlp's arguments", () => {
  it("YouTube gets the worker's own Node as its JavaScript runtime; no config file, no cookies", () => {
    const at = YTDLP_COMMON_ARGS.indexOf("--js-runtimes");
    expect(YTDLP_COMMON_ARGS[at + 1]).toBe(`node:${process.execPath}`);
    expect(YTDLP_COMMON_ARGS).toEqual(expect.arrayContaining(["--ignore-config", "--no-cookies"]));
  });
});

describe("ytDlp (fake)", () => {
  const yt = ytDlp({ argv: FAKE });

  it("says its version, or null when it cannot run", async () => {
    expect(await yt.version()).toBe("2026.09.01-fake");
    expect(await ytDlp({ argv: [join(ROOT, "no-such-yt-dlp")] }).version()).toBeNull();
  });

  it("reads the numbers of the videos it can, skips the ones YouTube refuses, never asks for an id that is not one", async () => {
    const m = await yt.metadata(["U_17EqTHUIo", "ERRgone0000", "not an id; rm -rf"]);
    expect([...m.keys()]).toEqual(["U_17EqTHUIo"]);
    expect(m.get("U_17EqTHUIo")).toMatchObject({ channel_title: "Fake Channel", published_at: "2026-06-01T00:00:00.000Z", duration_s: 600, views: 12345, tags: ["fake", "travel"] });
  });

  it("lists a channel's newest uploads; a channel that does not exist is an error", async () => {
    const list = await yt.listChannel({ kind: "handle", value: "@meitime" }, 3);
    expect(list.video_ids).toEqual(["fake0000001", "fake0000002", "fake0000003"]);
    expect(list.title).toBe("Fake Channel");
    await expect(yt.listChannel({ kind: "handle", value: "@missing" }, 3)).rejects.toMatchObject({ code: "unavailable", detail: "This channel does not exist" });
  });

  it("a refused download says why, in a word and a code", async () => {
    const dir = () => mkdtempSync(join(tmpdir(), "ytdl-"));
    await expect(yt.download("ERRgone0000", dir())).rejects.toMatchObject({ name: "YtDlpError", code: "unavailable", detail: "Video unavailable" });
    await expect(yt.download("PRIVate0000", dir())).rejects.toMatchObject({ code: "private", message: "video riêng tư" });
    await expect(yt.download("AGEcheck000", dir())).rejects.toMatchObject({ code: "age_restricted" });
    await expect(yt.download("LONGvideo00", dir())).rejects.toMatchObject({ code: "too_long" });
    await expect(yt.download("BOTblocked1", dir())).rejects.toMatchObject({ code: "youtube_blocked", message: expect.stringMatching(/^YouTube đang chặn tải từ máy chủ Studio/) });
    await expect(yt.download("../../etc/x", dir())).rejects.toThrow(/không phải id/);
  });

  it("a server YouTube blocks: every read says youtube_blocked, the start of the message kept", async () => {
    const blocked = ytDlp({ argv: [...FAKE, "--fake-blocked"] });
    expect(await blocked.version()).toBe("2026.09.01-fake");
    const err = await blocked.metadata(["U_17EqTHUIo"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YtDlpError);
    expect(err).toMatchObject({ code: "youtube_blocked", message: expect.stringMatching(/^yt-dlp không đọc được video nào: YouTube đang chặn/) });
    expect((err as YtDlpError).detail).toMatch(/^Sign in to confirm you.re not a bot/);
    await expect(blocked.search("phố cổ", 5, "relevance")).rejects.toMatchObject({ code: "youtube_blocked" });
    await expect(blocked.listChannel({ kind: "handle", value: "@meitime" }, 3)).rejects.toMatchObject({ code: "youtube_blocked" });
    await expect(blocked.download("U_17EqTHUIo", mkdtempSync(join(tmpdir(), "ytdl-")))).rejects.toMatchObject({ code: "youtube_blocked" });
  });

  it.skipIf(!hasFfmpeg())("downloads a video yt-dlp merges with this ffmpeg, scenes and all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ytdl-"));
    const path = await ytDlp({ argv: FAKE, ffmpeg: FFMPEG }).download("U_17EqTHUIo", dir);
    expect(path).toBe(join(dir, "U_17EqTHUIo.mp4"));
    expect(existsSync(path)).toBe(true);
    expect(await detectCuts(FFMPEG, path, 0.3)).toEqual([2, 4, 6, 8]);
  });
});

describe("ytVideoMeta", () => {
  it("a line yt-dlp prints for a video, or null", () => {
    expect(ytVideoMeta(JSON.stringify({ id: "U_17EqTHUIo", channel_id: "UC1", channel: "Mei", title: "Kyoto", timestamp: 1767225600, duration: 1299.4, view_count: 10 }))).toMatchObject({
      published_at: "2026-01-01T00:00:00.000Z", duration_s: 1299, views: 10, likes: null, comments: null, tags: [],
    });
    expect(ytVideoMeta("not json")).toBeNull();
    expect(ytVideoMeta(JSON.stringify({ id: "playlist-of-things", channel_id: "UC1", upload_date: "20260101" }))).toBeNull();
  });
});

describe("classifyYtDlp", () => {
  const c = (text: string) => classifyYtDlp(text).code;
  it("names each way YouTube says no", () => {
    expect(c("ERROR: [youtube] U_17EqTHUIo: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.")).toBe("youtube_blocked");
    expect(c("ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests")).toBe("youtube_blocked");
    expect(c("ERROR: [youtube] abcdefghijk: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies")).toBe("age_restricted");
    expect(c("ERROR: [youtube] abcdefghijk: Join this channel to get access to members-only content like this video")).toBe("members_only");
    expect(c("ERROR: [youtube] abcdefghijk: Private video. Sign in if you've been granted access")).toBe("private");
    expect(c("ERROR: [youtube] abcdefghijk: This live event will begin in 3 hours.")).toBe("live");
    expect(c("[download] Kyoto does not pass filter (duration<=1800 & !is_live), skipping ..")).toBe("too_long");
    expect(c("[download] File is larger than max-filesize (400000000 bytes > 300M). Aborting.")).toBe("too_big");
    expect(c("ERROR: [youtube] abcdefghijk: Requested format is not available. Use --list-formats")).toBe("no_480p");
    expect(c("ERROR: [youtube] abcdefghijk: Unable to download API page: <urlopen error [Errno -3] Temporary failure in name resolution>")).toBe("network");
  });

  it("a bot check on any line wins; something else keeps the START of its ERROR line", () => {
    expect(c("ERROR: [youtube] aaaaaaaaaaa: Video unavailable\nERROR: [youtube] bbbbbbbbbbb: Sign in to confirm you're not a bot")).toBe("youtube_blocked");
    const long = `ERROR: [youtube] abcdefghijk: Something new went wrong ${"x".repeat(400)} the end`;
    const f = classifyYtDlp(`WARNING: noise\n${long}\nsome trailing line`);
    expect(f.code).toBe("other");
    expect(f.reason.startsWith("yt-dlp: Something new went wrong")).toBe(true);
    expect(f.reason.length).toBeLessThanOrEqual(210);
    expect(f.reason).not.toContain("the end");
  });
});
