/**
 * The cleanup sweep: what it removes, and above all what it keeps (open runs, things still pointed at, recent files).
 */
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryBucket, replaceEpisodes, startPlanRun, sweepAgentSessions, sweepProductionAudio, sweepShotFrames,
  sweepVoiceStore, sweepWorkspaces, voicePath,
} from "../src/index.js";
import { seedProduction, world } from "./helpers.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAYS = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("sweepWorkspaces", () => {
  function workspace(root: string, run: string, ageDays: number) {
    const dir = join(root, run, "stage", "attempt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "proxy.mp4"), "x");
    const t = DAYS(ageDays);
    for (const d of [dir, join(root, run, "stage"), join(root, run)]) utimesSync(d, t, t);
  }

  it("removes old workspaces of ended runs; keeps open runs, recent ones and unknown runs", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    workspace(root, "run_done_old", 30);
    workspace(root, "run_failed_old", 30);
    workspace(root, "run_open_old", 30);
    workspace(root, "run_done_new", 2);
    workspace(root, "run_unknown", 30);
    const states: Record<string, string> = { run_done_old: "SUCCEEDED", run_failed_old: "FAILED", run_open_old: "WAITING", run_done_new: "SUCCEEDED" };
    expect(sweepWorkspaces(root, DAYS(14).getTime(), (id) => states[id] ?? null)).toBe(2);
    expect(["run_done_old", "run_failed_old", "run_open_old", "run_done_new", "run_unknown"].map((r) => existsSync(join(root, r))))
      .toEqual([false, false, true, true, true]);
  });
});

describe("the rest of the sweep", () => {
  let s: ReturnType<typeof world>;
  afterEach(() => s?.core.close());

  it("forgets agent sessions whose workspace is gone", () => {
    s = world();
    const kept = mkdtempSync(join(tmpdir(), "session-"));
    for (const [run, cwd] of [["r1", kept], ["r2", join(kept, "gone")]] as const) {
      s.db.run("INSERT INTO studio_agent_sessions (run_id, stage_key, attempt_id, session_id, cwd, created_at) VALUES (?, 'source-survey', 'a', 's', ?, ?)", [run, cwd, NOW.toISOString()]);
    }
    expect(sweepAgentSessions(s.db)).toBe(1);
    expect(s.db.all("SELECT run_id FROM studio_agent_sessions")).toEqual([{ run_id: "r1" }]);
  });

  it("drops voice lines not read for a long time, their WAV with them", () => {
    s = world();
    const dir = mkdtempSync(join(tmpdir(), "voice-"));
    for (const [key, used] of [["a".repeat(64), DAYS(200)], ["b".repeat(64), DAYS(10)]] as const) {
      writeFileSync(voicePath(dir, key), "RIFF");
      s.db.run("INSERT INTO studio_voice_lines (key, duration_s, words, language, created_at, last_used_at) VALUES (?, 1, '[]', 'vi', ?, ?)", [key, used.toISOString(), used.toISOString()]);
    }
    expect(sweepVoiceStore(s.db, dir, DAYS(90).toISOString())).toBe(1);
    expect(existsSync(voicePath(dir, "a".repeat(64)))).toBe(false);
    expect(existsSync(voicePath(dir, "b".repeat(64)))).toBe(true);
    expect(s.db.all("SELECT key FROM studio_voice_lines")).toEqual([{ key: "b".repeat(64) }]);
  });

  it("deletes old production audio nothing points at; keeps what the production or a timeline uses, recent files, and productions with a run open", async () => {
    s = world();
    const bucket = new MemoryBucket();
    const prod = seedProduction(s.db);
    const key = (rel: string) => `library/studio/${prod}/${rel}`;
    const put = async (rel: string, ageDays: number) => { await bucket.put(key(rel), Buffer.from("x")); bucket.modified.set(key(rel), DAYS(ageDays)); };
    await put("voice/current.wav", 30);
    await put("music/in-timeline.m4a", 30);
    await put("voice/replaced.wav", 30);
    await put("music/just-replaced.m4a", 1);
    s.db.run("UPDATE productions SET voice = ? WHERE id = ?", [JSON.stringify({ mode: "clone", reference: `library:studio/${prod}/voice/current.wav` }), prod]);
    replaceEpisodes(s.db, prod, [{ id: "ep-1", idx: 1, title: "T", hook: "h", plan: "{}" }], "plan-run");
    s.db.run("INSERT INTO episode_revisions (id, episode_id, revision, base_revision, data, author_id, created_at) VALUES ('rev-1', 'ep-1', 1, 0, ?, 'system', ?)",
      [JSON.stringify({ music: { track: `library:studio/${prod}/music/in-timeline.m4a`, gain_db: -18 } }), NOW.toISOString()]);

    expect(await sweepProductionAudio(s.core, s.db, bucket, DAYS(7))).toBe(1);
    expect([...bucket.objects.keys()].sort()).toEqual([key("music/in-timeline.m4a"), key("music/just-replaced.m4a"), key("voice/current.wav")]);

    // a run open: nothing of this production is touched
    await put("voice/replaced-again.wav", 30);
    s.db.run("UPDATE productions SET keywords = ? WHERE id = ?", [JSON.stringify(["phở sáng"]), prod]);
    startPlanRun(s.core, s.db, prod);
    expect(await sweepProductionAudio(s.core, s.db, bucket, DAYS(7))).toBe(0);
    expect(bucket.objects.has(key("voice/replaced-again.wav"))).toBe(true);
  });

  it("deletes the shot frames of episodes a new series plan replaced", async () => {
    s = world();
    const bucket = new MemoryBucket();
    const prod = seedProduction(s.db);
    replaceEpisodes(s.db, prod, [{ id: "ep-new", idx: 1, title: "T", hook: "h", plan: "{}" }], "plan-run");
    for (const k of [`productions/${prod}/episodes/ep-new/shots/s1.jpg`, `productions/${prod}/episodes/ep-old/shots/s1.jpg`, `productions/${prod}/episodes/ep-old/renders/final.mp4`]) {
      await bucket.put(k, Buffer.from("x"));
    }
    expect(await sweepShotFrames(s.db, bucket)).toBe(1);
    expect([...bucket.objects.keys()].sort()).toEqual([`productions/${prod}/episodes/ep-new/shots/s1.jpg`, `productions/${prod}/episodes/ep-old/renders/final.mp4`]);
  });
});
