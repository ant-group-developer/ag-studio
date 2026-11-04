/**
 * Audio a person gives a project (ADR-0001 item 168): a link fetched by the server without reaching inside the
 * network, a file checked and normalised by ffmpeg (keeping it on the project: workspace-project-audio.test.ts).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AudioImportError, downloadUrlFor, fetchAudioUrl, isPrivateAddress, pausesOf, prepareVoice, voiceCutAt,
} from "../src/index.js";
import { spawnSync } from "node:child_process";
import { ffprobeDuration, hasFfmpeg, makeVideo, makeWav } from "../../../tests/media.js";

const TOOLS = { ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" };
const tmp = () => mkdtempSync(join(tmpdir(), "audio-import-"));
const codeOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof AudioImportError ? e.code : String(e); } return null; };

describe("downloadUrlFor", () => {
  it("turns a Google Drive share link into its download link", () => {
    expect(downloadUrlFor("https://drive.google.com/file/d/1AbC_d-9/view?usp=sharing")).toBe("https://drive.google.com/uc?export=download&id=1AbC_d-9");
    expect(downloadUrlFor("https://drive.google.com/open?id=XyZ")).toBe("https://drive.google.com/uc?export=download&id=XyZ");
    expect(downloadUrlFor("https://cdn.example.com/a.mp3")).toBe("https://cdn.example.com/a.mp3");
  });

  it("only http(s)", () => {
    for (const u of ["file:///c:/a.wav", "ftp://a.b/c.mp3", "not a link"]) expect(() => downloadUrlFor(u)).toThrow(AudioImportError);
  });
});

describe("isPrivateAddress", () => {
  it("knows loopback, private, link-local and unique-local addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("fetchAudioUrl", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function serve(body: Buffer): Promise<string> {
    server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(body); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/a.mp3`;
  }

  it("refuses a link inside the network unless allowed (local stack)", async () => {
    const url = await serve(Buffer.from("ID3 audio"));
    const dest = join(tmp(), "a.mp3");
    expect(await codeOf(fetchAudioUrl(url, dest, { maxBytes: 1000 }))).toBe("url_not_allowed");
    expect(existsSync(dest)).toBe(false);
    await fetchAudioUrl(url, dest, { maxBytes: 1000, allowPrivate: true });
    expect(readFileSync(dest, "utf8")).toBe("ID3 audio");
  });

  it("stops past the size limit and leaves nothing behind", async () => {
    const url = await serve(Buffer.alloc(5000, 1));
    const dest = join(tmp(), "a.mp3");
    expect(await codeOf(fetchAudioUrl(url, dest, { maxBytes: 1000, allowPrivate: true }))).toBe("audio_too_large");
    expect(existsSync(dest)).toBe(false);
  });

  it("a public name that redirects inside the network is refused", async () => {
    const lookup = async (host: string) => [{ address: host === "public.test" ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    const fetchImpl = (async (u: string | URL) => String(u).startsWith("http://public.test")
      ? new Response(null, { status: 302, headers: { location: "http://inside.test/x.mp3" } })
      : new Response("secret")) as typeof fetch;
    expect(await codeOf(fetchAudioUrl("http://public.test/a.mp3", join(tmp(), "a.mp3"), { maxBytes: 1000, lookup, fetchImpl }))).toBe("url_not_allowed");
  });

  it("an HTTP error is a fetch failure", async () => {
    const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const fetchImpl = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await codeOf(fetchAudioUrl("https://a.test/x.mp3", join(tmp(), "x.mp3"), { maxBytes: 1000, lookup, fetchImpl }))).toBe("url_fetch_failed");
  });
});

describe("voiceCutAt", () => {
  it("keeps a sample short enough whole", () => {
    expect(voiceCutAt(12, [{ start: 6, end: 7 }])).toBeNull();
    expect(voiceCutAt(4, [])).toBeNull();
  });

  it("cuts a long sample in the middle of its last pause before 12 s, never inside a word", () => {
    // prod 03/11: speech ran 18.79–20.56 s and the old hard cut at 20 s split "day"
    const pauses = [{ start: 0.75, end: 1.25 }, { start: 6.77, end: 7.11 }, { start: 11.7, end: 12.26 }, { start: 13.57, end: 14.1 }];
    expect(voiceCutAt(80.8, pauses)).toBeCloseTo(11.98, 2);
    expect(voiceCutAt(80.8, pauses.slice(0, 2))).toBeCloseTo(6.94, 2);
  });

  it("ignores a pause too early to leave enough voice, and with none cuts at 12 s", () => {
    expect(voiceCutAt(30, [{ start: 2, end: 3 }])).toBe(12);
    expect(voiceCutAt(30, [])).toBe(12);
  });
});

describe("pausesOf", () => {
  it("reads silencedetect's lines; a pause still open at the end closes there", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: -0.002", "[silencedetect @ 0x1] silence_end: 0.458 | silence_duration: 0.46",
      "[silencedetect @ 0x1] silence_start: 11.7", "[silencedetect @ 0x1] silence_end: 12.26 | silence_duration: 0.56",
      "[silencedetect @ 0x1] silence_start: 12.8",
    ].join("\n");
    expect(pausesOf(stderr, 13)).toEqual([{ start: 0, end: 0.458 }, { start: 11.7, end: 12.26 }, { start: 12.8, end: 13 }]);
  });
});

describe.skipIf(!hasFfmpeg())("audio files (needs ffmpeg + ffprobe)", () => {
  it("a long voice sample becomes 24 kHz mono WAV, cut in the middle of its pause", async () => {
    const dir = tmp();
    // a tone with one second of silence at 8–9 s
    const r = spawnSync(TOOLS.ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=30", "-af", "volume=enable='between(t,8,9)':volume=0", "-c:a", "pcm_s16le", join(dir, "long.wav")]);
    expect(r.status).toBe(0);
    const out = await prepareVoice(TOOLS, join(dir, "long.wav"), join(dir, "voice.wav"));
    expect(out.duration_s).toBeGreaterThan(8);
    expect(out.duration_s).toBeLessThan(9);
    expect(ffprobeDuration(join(dir, "voice.wav"))).toBeCloseTo(out.duration_s, 1);
  });

  it("a long sample with no pause is cut at 12 s; a short one is kept whole", async () => {
    const dir = tmp();
    makeWav(join(dir, "long.wav"), 30);
    makeWav(join(dir, "short.wav"), 7);
    expect((await prepareVoice(TOOLS, join(dir, "long.wav"), join(dir, "a.wav"))).duration_s).toBe(12);
    expect(ffprobeDuration(join(dir, "a.wav"))).toBeCloseTo(12, 1);
    expect((await prepareVoice(TOOLS, join(dir, "short.wav"), join(dir, "b.wav"))).duration_s).toBeCloseTo(7, 1);
    expect(ffprobeDuration(join(dir, "b.wav"))).toBeCloseTo(7, 1);
  });

  it("refuses a sample with no sound or shorter than 3 s", async () => {
    const dir = tmp();
    makeVideo(join(dir, "mute.mp4"), { seconds: 5, audio: false });
    makeWav(join(dir, "short.wav"), 1);
    expect(await codeOf(prepareVoice(TOOLS, join(dir, "mute.mp4"), join(dir, "v.wav")))).toBe("audio_invalid");
    expect(await codeOf(prepareVoice(TOOLS, join(dir, "short.wav"), join(dir, "v.wav")))).toBe("audio_invalid");
    writeFileSync(join(dir, "junk.mp3"), "not audio");
    expect(await codeOf(prepareVoice(TOOLS, join(dir, "junk.mp3"), join(dir, "v.wav")))).toBe("audio_invalid");
  });
});
