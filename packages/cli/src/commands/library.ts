import { existsSync, readFileSync, statSync } from "node:fs";
import type { Command } from "commander";
import { HarnessError, idSchema, type ContentRequest, type LibraryBrief, type MusicTrack, type VoiceParams } from "@harness/contracts";
import { activateStyle, addMusicTrack, addVoice, applyReview, claimItem, createRequest, loadBrand, retireMusicTrack, retireVoice, setBrand, syncLibrary, withdrawItem } from "@harness/core";
import { probeDurationSync } from "@harness/adapter-ffprobe";
import { registerLibraryStage, requireLibrary } from "./library-stage.js";
import { print, withContext } from "./shared.js";

function parseDuration(raw: string | undefined): [number, number] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) throw new HarnessError("CONFIG_INVALID", '--duration must be "min,max" (non-negative numbers)', { value: raw });
  return [parts[0]!, parts[1]!];
}

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
  const library = program.command("library").description("kho nội dung: sync, requests, styles, items (spec §4.2)");
  registerLibraryStage(library);

  library.command("sync")
    .option("--verify", "re-hash the data files of every item, not just new/changed ones (audit; slow)", false)
    .option("--json", "machine output", false)
    .description("pull styles/requests/items from the kho filesystem into the local DB mirror")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        const lib = requireLibrary(ctx);
        const report = await syncLibrary({ store: ctx.store, fs: lib.fs, role: lib.role, clock: ctx.clock }, { verify: Boolean(o.verify) });
        print(o.json, report, () =>
          [
            `imported: styles=${report.imported.styles.length} requests=${report.imported.requests.length} items=${report.imported.items.length} voices=${report.imported.voices.length} brands=${report.imported.brands.length} tracks=${report.imported.tracks.length}`,
            `updated:  styles=${report.updated.styles.length} requests=${report.updated.requests.length} items=${report.updated.items.length} voices=${report.updated.voices.length} brands=${report.updated.brands.length} tracks=${report.updated.tracks.length}`,
            `corrupt: ${report.corrupt.length}`, ...report.corrupt.map((c) => `  ! ${c.path}: ${c.reason}`),
            `missing: ${report.missing.length}`, ...report.missing.map((m) => `  ? ${m.kind} ${m.id}`),
          ].join("\n"));
        if (report.corrupt.length > 0) process.exitCode = 1;
      });
    });

  library.command("list <kind>").option("--status <status>").option("--json", "machine output", false)
    .description("list items|requests|styles from the local DB mirror (run `library sync` first)")
    .action(async (kind: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireLibrary(ctx);
        const filter = o.status ? { status: o.status } : {};
        if (kind === "items") { const rows = ctx.store.listLibraryItems(filter); print(o.json, rows, () => rows.map((r) => `${r.item_id} ${r.status.padEnd(14)} ${r.title_hint}`).join("\n") || "no items"); }
        else if (kind === "requests") { const rows = ctx.store.listContentRequests(filter); print(o.json, rows, () => rows.map((r) => `${r.request_id} ${r.status.padEnd(10)} ${r.topic}`).join("\n") || "no requests"); }
        else if (kind === "styles") { const rows = ctx.store.listEditStyles(filter); print(o.json, rows, () => rows.map((r) => `${r.style_id} rev${r.revision} ${r.status.padEnd(8)} ${r.name}`).join("\n") || "no styles"); }
        else throw new HarnessError("CONFIG_INVALID", `unknown list kind "${kind}", expected items|requests|styles`, { kind });
      });
    });

  const request = library.command("request").description("content requests (channel role)");
  request.command("create")
    .requiredOption("--portfolio <id>").option("--channel <id>").requiredOption("--topic <topic>").option("--style <style_id>")
    .option("--duration <min,max>").option("--voice <voice>", "none|tts|original").option("--voice-id <id>", "voice profile id, required when --voice tts").option("--language <code>")
    .option("--count <n>", "must be 1 (one request buys one item until a re-claim mechanism exists)").option("--due <date>")
    .option("--source-hint <collection>", "named source collection an auto-accept run may pull from")
    .option("--source-id <src_id>", "source item id to narrow auto-accept to (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--json", "machine output", false)
    .description("create an open content request in the kho")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        // `count` is pinned to 1 by ContentRequestSchema: `intake` claims a request once and the first item
        // fulfills it, so anything larger would leave the request stuck at `claimed`.
        if (o.count !== undefined && Number(o.count) !== 1) {
          throw new HarnessError("CONFIG_INVALID", "--count must be 1: one content request buys one item (no re-claim mechanism yet)", { count: o.count });
        }
        const target_duration_seconds = parseDuration(o.duration);
        const sourceIds: string[] = o.sourceId;
        const source_hint: ContentRequest["source_hint"] | undefined = (o.sourceHint || sourceIds.length > 0)
          ? { ...(sourceIds.length > 0 ? { source_ids: sourceIds } : {}), ...(o.sourceHint ? { collection: o.sourceHint } : {}) }
          : undefined;
        const r = createRequest({ store: ctx.store, fs: lib.fs, clock: ctx.clock }, {
          requested_by: { portfolio_id: o.portfolio, ...(o.channel ? { channel_id: o.channel } : {}) },
          topic: o.topic,
          ...(o.style ? { style_id: o.style } : {}),
          ...(target_duration_seconds ? { target_duration_seconds } : {}),
          ...(o.voice ? { voice: o.voice } : {}),
          ...(o.voiceId ? { voice_id: o.voiceId } : {}),
          ...(o.language ? { language: o.language } : {}),
          ...(o.due ? { due_at: o.due } : {}),
          ...(source_hint ? { source_hint } : {}),
        });
        print(o.json, r, () => `${r.request_id} ${r.status}`);
      });
    });

  library.command("accept")
    .option("--request <id>", "accept from an existing open request").option("--topic <topic>", "manual topic (with --style)").option("--style <style_id>", "manual style (with --topic)")
    .option("--source <src_id>", "source id (repeatable, at least one)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--title <title>").option("--json", "machine output", false)
    .description("build a library_brief (from a request, or by hand) and create the ContentItem library-production plans against; does not claim the request")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireLibrary(ctx);
        if (o.source.length === 0) throw new HarnessError("CONFIG_INVALID", "--source is required (repeatable, at least one)", {});
        const manual = Boolean(o.topic || o.style);
        if (Boolean(o.request) === manual) throw new HarnessError("CONFIG_INVALID", "pass exactly one of --request or (--topic and --style)", { request: o.request, topic: o.topic, style: o.style });

        let topic: string; let style_id: string; let request_id: string | undefined;
        let voice: "none" | "tts" | "original" = "none"; let language = "vi"; let target_duration_seconds: [number, number] | undefined;
        if (o.request) {
          const req = ctx.store.getContentRequest(o.request);
          if (!req) throw new HarnessError("NOT_FOUND", `content request not found: ${o.request}; run library sync first`, { request_id: o.request });
          if (!req.style_id) throw new HarnessError("CONFIG_INVALID", `content request ${o.request} has no style_id`, { request_id: o.request });
          topic = req.topic; style_id = req.style_id; request_id = req.request_id; voice = req.voice; language = req.language;
          target_duration_seconds = req.target_duration_seconds;
        } else {
          if (!o.topic || !o.style) throw new HarnessError("CONFIG_INVALID", "both --topic and --style are required without --request", {});
          topic = o.topic; style_id = o.style;
        }

        const style = ctx.store.getEditStyle(style_id);
        if (!style || style.status !== "active") throw new HarnessError("CONFIG_INVALID", `edit style ${style_id} not found or not active; run library sync first`, { style_id });

        const library_brief: LibraryBrief = { topic, style_id, style_revision: style.revision, voice, language, ...(target_duration_seconds ? { target_duration_seconds } : {}), ...(request_id ? { request_id } : {}) };
        const content = ctx.catalog.createContent({ source_ids: o.source, title: o.title ?? topic, library_brief });
        print(o.json, { content_id: content.content_id }, () => content.content_id);
      });
    });

  library.command("review <item_id>")
    .option("--approve", "approve the item", false).option("--reject", "reject the item", false).option("--note <note>")
    .option("--json", "machine output", false)
    .description("apply a review decision to a pending_review item without going through a gate (studio role)")
    .action(async (itemId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        if (Boolean(o.approve) === Boolean(o.reject)) throw new HarnessError("CONFIG_INVALID", "pass exactly one of --approve or --reject", {});
        const decision = o.approve ? "approved" : "rejected";
        const { item, request } = applyReview({ store: ctx.store, fs: lib.fs, clock: ctx.clock }, { item_id: itemId, decision, by: "cli", ...(o.note ? { note: o.note } : {}) });
        print(o.json, { item_id: item.item_id, status: item.status, request_id: request?.request_id, request_status: request?.status },
          () => `${item.item_id} ${item.status}`);
      });
    });

  library.command("withdraw <item_id>")
    .option("--note <note>", "why it is being withdrawn (appended to the review note)").option("--json", "machine output", false)
    .description("retire an approved|rejected item (studio role); `withdrawn` is the kho's stand-in for deletion, and is not reversible")
    .action(async (itemId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        const item = withdrawItem({ store: ctx.store, fs: lib.fs, clock: ctx.clock }, { item_id: itemId, ...(o.note ? { note: o.note } : {}) });
        print(o.json, { item_id: item.item_id, status: item.status }, () => `${item.item_id} ${item.status}`);
      });
    });

  library.command("pick <item_id>")
    .requiredOption("--channel <channel_id>").option("--portfolio <id>", "portfolio to attribute the picked content to (defaults to project.yaml's first portfolio)").option("--json", "machine output", false)
    .description("claim an approved item into a local ContentItem (channel role); prints content_id for `plan --content`")
    .action(async (itemId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        const portfolio_id = o.portfolio ?? ctx.project.portfolios[0]?.portfolio_id;
        if (!portfolio_id) throw new HarnessError("CONFIG_INVALID", "no --portfolio given and project.yaml declares no portfolios", { projectDir: ctx.projectDir });
        const { content } = claimItem({ store: ctx.store, fs: lib.fs, clock: ctx.clock, catalog: ctx.catalog }, { item_id: itemId, channel_id: o.channel, portfolio_id });
        print(o.json, { content_id: content.content_id }, () => content.content_id);
      });
    });

  const styles = library.command("styles").description("edit styles");
  styles.command("show <style_id>").option("--json", "machine output", false)
    .description("print a synced edit style")
    .action(async (styleId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        requireLibrary(ctx);
        const style = ctx.store.getEditStyle(styleId);
        if (!style) throw new HarnessError("NOT_FOUND", `edit style not found: ${styleId}; run library sync first`, { style_id: styleId });
        print(o.json, style, () => `${style.style_id} rev${style.revision} ${style.status} "${style.name}"`);
      });
    });

  styles.command("activate <style_id>")
    .option("--note <note>", "optional note").option("--json", "machine output", false)
    .description("draft|retired -> active in the kho (studio role); idempotent on an already-active style")
    .action(async (styleId: string, o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const lib = requireLibrary(ctx);
        const style = activateStyle({ store: ctx.store, fs: lib.fs, clock: ctx.clock }, { style_id: styleId, ...(o.note ? { note: o.note } : {}) });
        print(o.json, style, () => `${style.style_id} rev${style.revision} ${style.status}`);
      });
    });

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
        // Fail fast on a malformed/path-traversal-shaped --voice-id before resolving --ref-text or spending
        // any ffmpeg work -- addVoice validates this too, but this gives an immediate, CLI-specific error.
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
    .description("list voice profiles from the local DB mirror (run `library sync` first)")
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
    .description("list music tracks from the local DB mirror (run `library sync` first)")
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
