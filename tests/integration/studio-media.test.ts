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
import { newId, type FitReport, type LibraryItem, type Narration, type NarrationTiming, type Review, type ShotsIndex, type Timeline, type Transcript } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { hasFfmpeg } from "../media.js";
import { addVoice, cli, freshLibraryWorld, ingestShoot, requestCreate, requestStatus, setMaxReplans, stageId, status, studioWorkerUntil, writeActiveStyle } from "./library-helpers.js";

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

/** `ffmpeg -i <path> -af volumedetect -f null -`, parsing `max_volume: <n> dB` -- the same technique
 * `media-checkers.ts`'s `peakVolumeDb` and `assemble-wrapper.test.ts` use. A file with an audio stream that
 * is silent end to end reports about -91 dB. */
function peakVolumeDb(path: string): number | null {
  const r = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-i", path, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = (r.stderr ?? "").match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return m ? Number(m[1]) : null;
}

function ffprobeHasAudio(path: string): boolean {
  const bin = process.env.FFPROBE_PATH ?? "ffprobe";
  const r = spawnSync(bin, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1", path], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

/** Every stage's state plus, for the stages that did not succeed, the check verdicts of their last attempt --
 * an assertion message that says WHY a run stopped instead of just which state it ended in. */
function why(project: string, runId: string): string {
  const store = new SqliteStateStore(join(project, "data", "state", "harness.db"));
  try {
    return JSON.stringify(
      store.listStageRuns(runId).map((s) => {
        if (s.state === "SUCCEEDED" || s.state === "PENDING") return [s.stage_key, s.state];
        const attempt = store.listAttempts(s.stage_run_id).at(-1);
        const checks = attempt ? store.listCheckResults(attempt.attempt_id).filter((c) => c.verdict !== "pass").map((c) => [c.check_id, c.verdict, c.evidence]) : [];
        return [s.stage_key, s.state, attempt?.error_summary ?? null, checks];
      }),
    );
  } finally {
    store.close();
  }
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

  // Task-10 fix round: `voice: none` over drone/b-roll clips with NO audio track is the third voice mode and
  // the one 1.2.0 could not finish. `assemble` always mixes an `anullsrc` pad now, so the episode comes out
  // ~99.7% silent and `audio-integrity` used to fail it against the studio profile's `max_silence_ratio: 0.9`
  // -- a FAILED run, not a rejected review, so the SP4 replan loop never saw it and the request sat at
  // `claimed` waiting for a human. `audio-integrity` now passes that one case with evidence
  // `{ reason: "silent by brief" }`, proven from the brief (`voice: none`) and `shots.json` (no source has
  // audio); everything else about the checker is unchanged.
  it("finishes a voice: none episode cut from footage that has no audio track at all", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    const sourceIds = ingestShoot(world, "shoot-a", 2, { withAudio: false });

    const requestId = requestCreate(world, {
      topic: "Chỉ có hình, không có tiếng", style: styleId, sourceHint: "shoot-a",
      voice: "none", duration: [1, 120], language: "en",
    });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 300, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const manifest = readJson<LibraryItem>(join(world.lib, "items", fulfilled.item_ids[0]!, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;

    const final = status(world.studio, runId);
    expect(final.run.state).toBe("SUCCEEDED");
    expect(final.stages.map((s) => s.stage_key).sort()).toEqual([...STAGE_KEYS].sort());
    for (const s of final.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");

    // the scenario really was audio-free end to end, so the pass above came from the new allowance and not
    // from footage that quietly had sound after all
    const shots = readJson<ShotsIndex>(artifactPath(world.studio, runId, "media-index", "shots"));
    expect(shots.sources.map((s) => s.source_id).sort()).toEqual([...sourceIds].sort());
    expect(shots.sources.every((s) => !s.has_audio), JSON.stringify(shots.sources.map((s) => s.has_audio))).toBe(true);
    const transcript = readJson<Transcript>(artifactPath(world.studio, runId, "media-transcribe", "transcript"));
    expect(transcript.sources.every((s) => s.segments.length === 0)).toBe(true);
    // `voice: none` writes no narration at all, and media-tts never touches the engine
    const timing = readJson<NarrationTiming>(artifactPath(world.studio, runId, "media-tts", "narration_timing"));
    expect(timing.lines).toEqual([]);
    expect(ffprobeHasAudio(artifactPath(world.studio, runId, "assemble", "episode_video"))).toBe(true);
  }, 300_000);

  // Final-review Important 7: a shoot that MIXES clips with sound and clips without is the headline 5A
  // scenario, and `assemble.mjs` -- the wrapper the go-live runbook tells operators to copy -- decided for
  // the whole programme from `hasAudioStream(clips[0])`. With the first clip silent, `voice: original` fell
  // through to the silent-track-only branch and threw away every other clip's audio.
  it("finishes a voice: original episode from a shoot that mixes clips with and without audio", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    // clip 0 silent, clip 1 with sound: the order that used to silence the whole episode
    const sourceIds = ingestShoot(world, "shoot-a", 2, { withAudio: true, silentClips: [0] });

    const requestId = requestCreate(world, {
      topic: "Nửa có tiếng, nửa không", style: styleId, sourceHint: "shoot-a",
      voice: "original", duration: [1, 120], language: "en",
    });

    studioWorkerUntil(world, () => requestStatus(world, requestId).status === "fulfilled", 300, env);
    const fulfilled = requestStatus(world, requestId);
    expect(fulfilled.status, JSON.stringify(fulfilled)).toBe("fulfilled");

    const manifest = readJson<LibraryItem>(join(world.lib, "items", fulfilled.item_ids[0]!, "manifest.json"));
    expect(manifest.status).toBe("approved");
    const runId = manifest.lineage.run_id;
    const final = status(world.studio, runId);
    expect(final.run.state, why(world.studio, runId)).toBe("SUCCEEDED");

    // the shoot really was mixed, and the finished episode really does carry sound
    const shots = readJson<ShotsIndex>(artifactPath(world.studio, runId, "media-index", "shots"));
    expect(shots.sources.map((s) => s.source_id).sort()).toEqual([...sourceIds].sort());
    expect(shots.sources.map((s) => s.has_audio).sort()).toEqual([false, true]);
    const episode = artifactPath(world.studio, runId, "assemble", "episode_video");
    expect(ffprobeHasAudio(episode)).toBe(true);
    expect(peakVolumeDb(episode), "the episode is entirely silent: the clip that had sound was dropped").toBeGreaterThan(-60);
  }, 300_000);

  // Final-review Critical 1, the same shape as the `voice: none` case above: an episode whose fitted duration
  // lands outside the request's `target_duration_seconds` used to FAIL `brief-duration` on `assemble` -- a
  // FAILED run, so `library-apply-review` never ran, the request stayed `claimed` and the SP4 replan loop
  // never saw it. In 1.2.0 that is reachable with nothing broken (`fitEdl` appends/reuses footage on its own,
  // and the fake `edit-plan` does not fit a multi-source EDL to any target), so the verdict belongs to
  // `library-review` -- which rejects on `within_target === false` and reopens the request.
  //
  // The fake agent cannot converge here (its 1.2.0 EDL ignores the target entirely), so the assertion is the
  // designed terminal state: `max_replans: 0` means exactly one run, then `request.auto_accept_exhausted` and
  // a request left `open` for a human -- never `claimed`, and no FAILED run anywhere in the project.
  it("rejects an episode that overshoots the brief's target instead of failing the run", () => {
    const world = freshLibraryWorld({ media: false, media1_2: true });
    setMaxReplans(world.studio, 0);
    const env = { FAKE_REVIEW_MODE: "approve" };

    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);
    ingestShoot(world, "shoot-a", 2, { withAudio: true });

    // Two clips' worth of picture (~4 s) against a 1-2 s target: out of range, and well inside the studio
    // profile's own `duration-range` policy of [1, 1800], so this really is the brief's check talking.
    const requestId = requestCreate(world, {
      topic: "Dài hơn khoảng đích", style: styleId, sourceHint: "shoot-a",
      voice: "none", duration: [1, 2], language: "en",
    });

    const runOf = (): string | undefined => {
      const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
      try {
        return store.listEvents({ event_type: "request.auto_accepted" }).find((e) => e.payload.request_id === requestId)?.payload.run_id as string | undefined;
      } finally {
        store.close();
      }
    };
    studioWorkerUntil(world, () => {
      const runId = runOf();
      return runId !== undefined && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status(world.studio, runId).run.state);
    }, 120, env);

    const runId = runOf();
    expect(runId, "the autopilot never planned a run for the request").toBeDefined();
    const final = status(world.studio, runId!);
    expect(final.run.state, why(world.studio, runId!)).toBe("SUCCEEDED");
    for (const s of final.stages) expect(s.state, s.stage_key).toBe("SUCCEEDED");

    // the episode really did overshoot, and `media-fit-edl` said so
    const report = readJson<FitReport>(artifactPath(world.studio, runId!, "media-fit-edl", "fit_report"));
    expect(report.within_target).toBe(false);
    expect(report.target_duration_seconds).toEqual([1, 2]);
    expect(ffprobeDuration(artifactPath(world.studio, runId!, "assemble", "episode_video"))).toBeGreaterThan(2);

    const review = readJson<Review>(artifactPath(world.studio, runId!, "library-review", "review"));
    expect(review.decision).toBe("rejected");
    expect(review.note, review.note).toContain("khoảng đích");

    const store = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      // `brief-duration` passed rather than failing, and said why -- this is the fix, not a side effect of
      // the episode happening to land in range.
      const assembleStage = store.listStageRuns(runId!).find((s) => s.stage_key === "assemble")!;
      const attempt = store.listAttempts(assembleStage.stage_run_id).at(-1)!;
      const briefDuration = store.listCheckResults(attempt.attempt_id).find((c) => c.check_id === "brief-duration")!;
      expect(briefDuration.verdict).toBe("pass");
      expect(briefDuration.evidence.reason).toBe("deferred to library-review");
      expect(briefDuration.evidence.within_target).toBe(false);
      // the exported item was rejected in the kho, which is what reopened the request
      expect(store.listLibraryItems({}).find((i) => i.lineage.run_id === runId)?.status).toBe("rejected");
    } finally {
      store.close();
    }

    // reopened for the replan loop, never parked at `claimed` behind a failure
    expect(requestStatus(world, requestId).status).toBe("open");

    // the designed terminal state: budget spent, request still `open`, and not one FAILED run
    studioWorkerUntil(world, () => {
      const s = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
      try {
        return s.listEvents({ event_type: "request.auto_accept_exhausted" }).some((e) => e.payload.request_id === requestId);
      } finally {
        s.close();
      }
    }, 10, env);
    const after = new SqliteStateStore(join(world.studio, "data", "state", "harness.db"));
    try {
      expect(after.listEvents({ event_type: "request.auto_accept_exhausted" }).some((e) => e.payload.request_id === requestId)).toBe(true);
      expect(after.listRuns({}).filter((r) => r.state === "FAILED").map((r) => r.run_id)).toEqual([]);
    } finally {
      after.close();
    }
    expect(requestStatus(world, requestId).status).toBe("open");
  }, 300_000);
});
