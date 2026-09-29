import { existsSync, readFileSync, statSync } from "node:fs";
import type { Command } from "commander";
import { HarnessError, idSchema, type MusicTrack, type VoiceParams } from "@harness/contracts";
import { addMusicTrack, addVoice, loadBrand, retireMusicTrack, retireVoice, setBrand } from "@harness/core";
import { probeDurationSync } from "@harness/adapter-ffprobe";
import { requireLibrary } from "./library-stage.js";
import { print, withContext } from "./shared.js";

/** `--ref-text` (voices add): an existing *file*'s UTF-8 content (trimmed), or the raw string as-is. Either
 * way, empty is CONFIG_INVALID -- a blank transcript would silently produce an unusable voice profile.
 * `existsSync(raw)` alone is also true for a directory, which `readFileSync` would then reject with a raw
 * `EISDIR` instead of this function's own clear error -- `statSync(raw).isFile()` guards that (fix round 1). */
function resolveRefText(raw: string): string {
  const isFile = existsSync(raw) && statSync(raw).isFile();
  const text = isFile ? readFileSync(raw, "utf8").trim() : raw;
  if (!text) throw new HarnessError("CONFIG_INVALID", "--ref-text must not be empty", { value: raw });
  return text;
}

const VOICE_ORIGINS = ["synthetic", "own", "licensed"] as const;
const VOICE_ID_SCHEMA = idSchema("voice_profile");
const MUSIC_ORIGINS = ["own", "licensed", "royalty_free"] as const;

function parseMood(raw: string): string[] {
  const mood = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (mood.length === 0) throw new HarnessError("CONFIG_INVALID", "--mood must list at least one mood tag", { value: raw });
  return mood;
}

export function registerLibrary(program: Command): void {
  const library = program.command("library").description("kho nội dung: voices, brands, music");

  const voices = library.command("voices").description("channel-owned TTS voice profiles (spec §1.5)");

  voices.command("add")
    .option("--voice-id <id>", "bump an existing voice profile instead of minting a new one (revision + 1)")
    .requiredOption("--display-name <name>")
    .requiredOption("--ref <path>", "reference audio clip; converted to mono 24kHz PCM ref.wav (must be 3-30s long)")
    .requiredOption("--ref-text <text_or_path>", "transcript of the reference clip, or a path to a file holding it")
    .option("--language <code>", "defaults to vi")
    .requiredOption("--origin <origin>", "synthetic|own|licensed")
    .option("--origin-note <note>")
    .option("--speed <n>", "voice params: TTS playback speed 0.5-2 (default 1)")
    .option("--num-step <n>", "voice params: TTS diffusion steps 4-128 (default 32)")
    .option("--json", "machine output", false)
    .description("add or bump a channel-owned TTS voice profile in the kho (channel role); validates the reference clip before touching the kho")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const lib = requireLibrary(ctx);
        if (!VOICE_ORIGINS.includes(o.origin)) {
          throw new HarnessError("CONFIG_INVALID", `--origin must be one of ${VOICE_ORIGINS.join("|")}`, { origin: o.origin });
        }
        if (o.voiceId !== undefined && !VOICE_ID_SCHEMA.safeParse(o.voiceId).success) {
          throw new HarnessError("CONFIG_INVALID", `--voice-id is not a valid voice_id: ${o.voiceId}`, { voice_id: o.voiceId });
        }
        const ref_text = resolveRefText(o.refText);
        const params: Partial<VoiceParams> = {};
        if (o.speed !== undefined) params.speed = Number(o.speed);
        if (o.numStep !== undefined) params.num_step = Number(o.numStep);
        const voice = await addVoice(
          { fs: lib.fs, store: ctx.store, clock: ctx.clock, ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", probeDuration: (p: string) => probeDurationSync(p) },
          {
            ...(o.voiceId ? { voice_id: o.voiceId } : {}),
            display_name: o.displayName,
            ref_path: o.ref,
            ref_text,
            language: o.language ?? "vi",
            origin: o.origin,
            ...(o.originNote ? { origin_note: o.originNote } : {}),
            ...(Object.keys(params).length > 0 ? { params } : {}),
          },
        );
        print(o.json, voice, () => `${voice.voice_id} rev${voice.revision} ${voice.status}`);
      });
    });

  voices.command("list").option("--status <status>", "active|retired").option("--json", "machine output", false)
    .description("list voice profiles from the local DB mirror (run library sync first)")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireLibrary(ctx);
        const filter = o.status ? { status: o.status } : {};
        const rows = ctx.store.listVoiceProfiles(filter);
        print(o.json, rows, () => rows.map((r) => `${r.voice_id} rev${r.revision} ${r.status.padEnd(8)} ${r.display_name}`).join("\n") || "no voices");
      });
    });

  voices.command("retire <voice_id>")
    .option("--json", "machine output", false)
    .description("active -> retired in the kho (channel role); idempotent on an already-retired voice")
    .action(async (voiceId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        const voice = retireVoice({ fs: lib.fs, store: ctx.store, clock: ctx.clock }, voiceId);
        print(o.json, voice, () => `${voice.voice_id} ${voice.status}`);
      });
    });

  const brands = library.command("brands").description("channel-owned brand profiles: fonts, colors, logo, music (spec §2.1)");

  brands.command("set <channel_id>")
    .requiredOption("--from <path>", "path to a brand.json-shaped source file; fonts/logo it references are resolved relative to that file's directory")
    .option("--json", "machine output", false)
    .description("set or bump a channel's brand profile in the kho (channel role); validates fonts/logo before touching the kho")
    .action(async (channelId: string, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const lib = requireLibrary(ctx);
        const brand = await setBrand({ fs: lib.fs, store: ctx.store, clock: ctx.clock }, { channel_id: channelId, source_path: o.from });
        print(o.json, brand, () => `${brand.channel_id} rev${brand.revision}`);
      });
    });

  brands.command("show <channel_id>")
    .option("--json", "machine output", false)
    .description("print a channel's brand profile straight from the kho")
    .action(async (channelId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        const loaded = loadBrand(lib.fs, channelId);
        if (!loaded) throw new HarnessError("NOT_FOUND", `no brand for channel: ${channelId}`, { channel_id: channelId });
        print(o.json, loaded.brand, () => `${loaded.brand.channel_id} rev${loaded.brand.revision}`);
      });
    });

  const music = library.command("music").description("kho-wide background music tracks (spec §2.2)");

  music.command("add")
    .requiredOption("--track-id <id>", 'lowercase-kebab id, e.g. "calm-01"; immutable once added')
    .requiredOption("--file <path>", "audio file (wav|flac|mp3|m4a); must have an audio stream longer than 5s")
    .requiredOption("--display-name <name>")
    .requiredOption("--mood <a,b>", "comma-separated mood tags")
    .requiredOption("--origin <origin>", "own|licensed|royalty_free")
    .requiredOption("--origin-note <note>")
    .option("--loop-ok", "track may be looped to fill a longer episode", false)
    .option("--json", "machine output", false)
    .description("add a background music track to the kho (channel role); validates the file before touching the kho")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const lib = requireLibrary(ctx);
        if (!MUSIC_ORIGINS.includes(o.origin)) {
          throw new HarnessError("CONFIG_INVALID", `--origin must be one of ${MUSIC_ORIGINS.join("|")}`, { origin: o.origin });
        }
        const mood = parseMood(o.mood);
        const track = await addMusicTrack(
          { fs: lib.fs, store: ctx.store, clock: ctx.clock, prober: ctx.prober },
          {
            track_id: o.trackId,
            display_name: o.displayName,
            file_path: o.file,
            mood,
            origin: o.origin as MusicTrack["origin"],
            origin_note: o.originNote,
            loop_ok: Boolean(o.loopOk),
          },
        );
        print(o.json, track, () => `${track.track_id} ${track.active ? "active" : "retired"}`);
      });
    });

  music.command("list").option("--status <status>", "active|retired").option("--json", "machine output", false)
    .description("list music tracks from the local DB mirror (run library sync first)")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireLibrary(ctx);
        const filter = o.status ? { active: o.status === "active" } : {};
        const rows = ctx.store.listMusicTracks(filter);
        print(o.json, rows, () => rows.map((r) => `${r.track_id} ${(r.active ? "active" : "retired").padEnd(8)} ${r.display_name}`).join("\n") || "no tracks");
      });
    });

  music.command("retire <track_id>")
    .option("--json", "machine output", false)
    .description("active -> retired in the kho (channel role); the file itself is kept; idempotent on an already-retired track")
    .action(async (trackId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        const track = retireMusicTrack({ fs: lib.fs, store: ctx.store, clock: ctx.clock }, trackId);
        print(o.json, track, () => `${track.track_id} ${track.active ? "active" : "retired"}`);
      });
    });
}
