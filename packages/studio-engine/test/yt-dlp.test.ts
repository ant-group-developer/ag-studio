/** yt-dlp through the fake (`fixtures/fake-yt-dlp.mjs`): no network. The download case needs ffmpeg (FFMPEG_PATH). */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCuts, ytDlp, ytVideoMeta } from "../src/index.js";
import { hasFfmpeg } from "../../../tests/media.js";
import { ROOT } from "./helpers.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FAKE = [process.execPath, join(ROOT, "fixtures", "fake-yt-dlp.mjs")];

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
    await expect(yt.listChannel({ kind: "handle", value: "@missing" }, 3)).rejects.toThrow(/does not exist/);
  });

  it("a refused download says why", async () => {
    await expect(yt.download("ERRgone0000", mkdtempSync(join(tmpdir(), "ytdl-")))).rejects.toThrow(/Video unavailable/);
    await expect(yt.download("../../etc/x", mkdtempSync(join(tmpdir(), "ytdl-")))).rejects.toThrow(/không phải id/);
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
