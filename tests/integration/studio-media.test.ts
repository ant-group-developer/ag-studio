// Sub-project 5A Task 10: the FIRST end-to-end drive of `library-production@1.2.0`. Tasks 1-9 were each
// tested in isolation (the task-8 stage tests stop at `media-fit-edl` and fabricate the agent stages); this
// runs all 15 stages through two real workers -- a channel project that writes the voice profile and the
// request, and a studio project whose autopilot claims it -- with the fake agent CLI and `FakeMediaEngine`
// standing in for `claude -p` / WhisperX / OmniVoice, and no studio command beyond `worker --once`.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId, type LibraryItem, type Narration, type NarrationTiming, type ShotsIndex, type Timeline, type Transcript } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { addVoice, cli, freshLibraryWorld, ingestShoot, requestCreate, requestStatus, stageId, status, studioWorkerUntil, writeActiveStyle } from "./library-helpers.js";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** Every artifact this run produced for `stageKey`, by type -- same technique as `studio-autopilot.test.ts`
 * (`status --json`'s artifacts carry a `uri` even though `StatusJson` does not declare the field). */
function artifactPath(project: string, runId: string, stageKey: string, type: string): string {
  const sid = stageId(project, runId, stageKey);
  const found = status(project, runId).artifacts.find((a) => a.stage_run_id === sid && a.type === type) as unknown as { uri: string } | undefined;
  expect(found, `no ${type} artifact for stage ${stageKey} on run ${runId}`).toBeDefined();
  return fileURLToPath(found!.uri);
}

function ffprobeDuration(path: string): number {
  const bin = process.env.FFPROBE_PATH ?? "ffprobe";
  const r = spawnSync(bin, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe ${path} failed: ${r.stderr}`);
  return Number(r.stdout.trim());
}

function ffprobeHasAudio(path: string): boolean {
  const bin = process.env.FFPROBE_PATH ?? "ffprobe";
  const r = spawnSync(bin, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1", path], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

const STAGE_KEYS = [
  "intake", "media-index", "media-transcribe", "watch-source", "survey-source", "plan-edit", "media-tts",
  "media-fit-edl", "cut", "assemble", "watch-episode", "thumbnail-candidates", "library-export",
  "library-review", "library-apply-review",
];

describe.skipIf(!hasFfmpeg())("studio media: library-production@1.2.0 end to end on a multi-clip shoot", () => {
  it("runs a three-clip shoot through all 15 stages into an approved item with only worker --once at the studio", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const voiceId = addVoice(world);
    const sourceIds = ingestShoot(world, "shoot-a", 3, { withAudio: true });
    expect(sourceIds).toHaveLength(3);

    const requestId = requestCreate(world, {
      topic: "Buổi quay chợ nổi", style: styleId, sourceHint: "shoot-a",
      voice: "tts", voiceId, duration: [5, 120], language: "en",
    });
    expect(requestStatus(world, requestId).status).toBe("open");

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 400, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");
    const itemId = fulfilled.item_ids[0]!;

    const manifest = readJson<LibraryItem>(join(world.lib, "items", itemId, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;

    // ---- the run itself: 1.2.0, all 15 stages SUCCEEDED, exactly one attempt each ----
    const final = status(world.studio, runId);
    expect(final.run.state).toBe("SUCCEEDED");
    expect(final.stages.map((s) => s.stage_key).sort()).toEqual([...STAGE_KEYS].sort());
    for (const s of final.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");

    const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      const run = store.getRun(runId)!;
      expect(`${run.workflow_release.id}@${run.workflow_release.version}`).toBe("library-production@1.2.0");

      // ---- artifacts ----
      const shots = readJson<ShotsIndex>(artifactPath(world.studio, runId, "media-index", "shots"));
      expect(shots.sources.map((s) => s.source_id).sort()).toEqual([...sourceIds].sort());
      for (const s of shots.sources) expect(s.shots.length, `${s.file_name} has no shots`).toBeGreaterThan(0);

      const transcript = readJson<Transcript>(artifactPath(world.studio, runId, "media-transcribe", "transcript"));
      expect(transcript.sources).toHaveLength(3);
      expect(transcript.sources.every((s) => s.segments.length > 0), JSON.stringify(transcript.sources.map((s) => s.segments.length))).toBe(true);

      const narration = readJson<Narration>(artifactPath(world.studio, runId, "plan-edit", "narration"));
      const timing = readJson<NarrationTiming>(artifactPath(world.studio, runId, "media-tts", "narration_timing"));
      expect(narration.lines.length).toBeGreaterThan(0);
      expect(timing.lines).toHaveLength(narration.lines.length);
      expect(timing.voice_id).toBe(voiceId);
      const voiceDir = artifactPath(world.studio, runId, "media-tts", "voice_set");
      expect(readdirSync(voiceDir).filter((f) => f.endsWith(".wav"))).toHaveLength(narration.lines.length);

      // ---- timeline vs the real assembled episode ----
      const timeline = readJson<Timeline>(artifactPath(world.studio, runId, "media-fit-edl", "timeline"));
      const episode = artifactPath(world.studio, runId, "assemble", "episode_video");
      const episodeSeconds = ffprobeDuration(episode);
      expect(Math.abs(timeline.total_seconds - episodeSeconds), `timeline ${timeline.total_seconds}s vs episode ${episodeSeconds}s`).toBeLessThanOrEqual(0.5);
      expect(ffprobeHasAudio(episode), "assembled episode has no audio stream").toBe(true);

      // ---- events ----
      const transcribed = store.listEvents({ event_type: "media.transcribed" }).filter((e) => e.payload.run_id === runId);
      expect(transcribed).toHaveLength(1);
      expect(transcribed[0]!.payload.sources).toBe(3);
      const ttsDone = store.listEvents({ event_type: "media.tts_done" }).filter((e) => e.payload.run_id === runId);
      expect(ttsDone).toHaveLength(1);
      expect(ttsDone[0]!.payload.lines).toBe(narration.lines.length);
    } finally {
      store.close();
    }

    // ---- the channel can pick the finished item ----
    const picked = cli(world.channel, ["library", "sync", "--json"]);
    expect(picked.code, picked.err).toBe(0);
  }, 600_000);
});
