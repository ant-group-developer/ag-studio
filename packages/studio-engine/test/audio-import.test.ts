/**
 * Audio a person gives a production (ADR-0001 item 168): a link fetched by the server without reaching inside the
 * network, a file checked and normalised by ffmpeg, kept in the Studio bucket under `library/studio/<production>/`.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionMusicSchema, ProductionVoiceSchema } from "@harness/contracts";
import {
  AudioImportError, declineNarration, downloadUrlFor, fetchAudioUrl, getProduction, importProductionAudio, isPrivateAddress, prepareVoice,
} from "../src/index.js";
import { seedProduction, world } from "./helpers.js";
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

describe.skipIf(!hasFfmpeg())("audio files (needs ffmpeg + ffprobe)", () => {
  it("a voice sample becomes 24 kHz mono WAV, cut to its first 20 s", async () => {
    const dir = tmp();
    makeWav(join(dir, "long.wav"), 30);
    const out = await prepareVoice(TOOLS, join(dir, "long.wav"), join(dir, "voice.wav"));
    expect(out.duration_s).toBeCloseTo(20, 0);
    expect(ffprobeDuration(join(dir, "voice.wav"))).toBeCloseTo(20, 0);
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

  it("keeps the voice in the bucket by content and on the production, with who vouched for it", async () => {
    const { db, bucket } = world();
    const prod = seedProduction(db);
    const dir = tmp();
    makeWav(join(dir, "giong.wav"), 8);
    const v = await importProductionAudio({ db, bucket, ...TOOLS }, {
      productionId: prod, kind: "voice", file: join(dir, "giong.wav"), source: { kind: "upload", filename: "giong.wav" },
      origin: "own", referenceText: "Xin chào các bạn.", userId: "auth0|u1",
    });
    const saved = ProductionVoiceSchema.parse(JSON.parse(getProduction(db, prod)!.voice!));
    expect(saved).toMatchObject({ mode: "clone", origin: "own", reference_text: "Xin chào các bạn.", confirmed_by: "auth0|u1", source: { kind: "upload" } });
    expect(v).toEqual(saved);
    const key = (saved as { reference: string }).reference.replace(/^library:/, "library/");
    expect(key).toMatch(new RegExp(`^library/studio/${prod}/voice/[0-9a-f]{64}\\.wav$`));
    expect(bucket.objects.has(key)).toBe(true);
  });

  it("music: kept as AAC with its gain and ducking; stages see only the track", async () => {
    const { db, bucket } = world();
    const prod = seedProduction(db);
    const dir = tmp();
    makeWav(join(dir, "nhac.wav"), 12);
    await importProductionAudio({ db, bucket, ...TOOLS }, {
      productionId: prod, kind: "music", file: join(dir, "nhac.wav"), source: { kind: "link", url: "https://a.b/nhac.wav" }, userId: "auth0|u1",
    });
    const m = ProductionMusicSchema.parse(JSON.parse(getProduction(db, prod)!.music!));
    expect(m).toMatchObject({ gain_db: -18, ducking: true, source: { kind: "link" } });
    expect(m.track).toMatch(new RegExp(`^library:studio/${prod}/music/[0-9a-f]{64}\\.m4a$`));
    expect(bucket.objects.has(m.track.replace(/^library:/, "library/"))).toBe(true);
  });

  it("declining narration is remembered on the production", () => {
    const { db } = world();
    const prod = seedProduction(db);
    declineNarration(db, prod, "auth0|u1");
    expect(ProductionVoiceSchema.parse(JSON.parse(getProduction(db, prod)!.voice!))).toMatchObject({ mode: "none", decided_by: "auth0|u1" });
  });
});
