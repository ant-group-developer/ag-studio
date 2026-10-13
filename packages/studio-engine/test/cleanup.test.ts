/**
 * The cleanup sweep: what it removes, and above all what it keeps (running jobs and turns, things still pointed at,
 * recent files).
 */
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJob, createProject, createThread, createVideo, postUserMessage, sweepProjectAudio, sweepRawUploads, sweepScratch, sweepStudioData, sweepTrash, sweepVoiceStore, voicePath,
} from "../src/index.js";
import { world } from "./helpers.js";
import { listAudit, logAudit } from "../src/index.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAYS = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

function aged(path: string, at: Date) { utimesSync(path, at, at); }

describe("the cleanup sweep", () => {
  let s: ReturnType<typeof world>;
  afterEach(() => { s?.core.close(); s = undefined as never; });

  function project() {
    s.db.run("INSERT OR IGNORE INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW.toISOString(), NOW.toISOString()]);
    return createProject(s.db, "team-1", { name: "Du lịch chậm", description: "", language: "vi", aspect: "16:9" }, "u", NOW.toISOString());
  }

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

  it("deletes old project audio nothing points at; keeps the project's voice and music, what a timeline uses, and recent files", async () => {
    s = world();
    const p = project();
    const video = createVideo(s.db, p.id, { title: "Tập 1", createdBy: "u" }, NOW.toISOString());
    const key = (name: string) => `library/studio/projects/${p.id}/${name}`;
    s.db.run("UPDATE projects SET voice = ?, music = ? WHERE id = ?", [
      JSON.stringify({ kind: "sample", audio: `library:studio/projects/${p.id}/voice/v1.wav` }),
      JSON.stringify({ audio: `library:studio/projects/${p.id}/music/m1.m4a` }), p.id,
    ]);
    s.db.run("INSERT INTO video_revisions (id, video_id, revision, base_revision, data, author_id, created_at) VALUES ('r1', ?, 1, 0, ?, 'u', ?)",
      [video.id, JSON.stringify({ music: { src: `library:studio/projects/${p.id}/music/m0.m4a` } }), NOW.toISOString()]);
    for (const k of ["voice/v1.wav", "music/m1.m4a", "music/m0.m4a", "voice/old.wav", "music/new.m4a"]) await s.bucket.put(key(k), Buffer.from("x"));
    for (const k of ["voice/v1.wav", "music/m1.m4a", "music/m0.m4a", "voice/old.wav"]) s.bucket.modified.set(key(k), DAYS(30));
    expect(await sweepProjectAudio(s.db, s.bucket, DAYS(7))).toBe(1);
    expect([...s.bucket.objects.keys()].sort()).toEqual(["music/m0.m4a", "music/m1.m4a", "music/new.m4a", "voice/v1.wav"].map(key));
  });

  it("removes scratch folders of jobs and turns no longer running; keeps running ones and recent ones", () => {
    s = world();
    const p = project();
    const dataRoot = mkdtempSync(join(tmpdir(), "data-"));
    const running = createJob(s.db, { projectId: p.id, kind: "research", title: "Crawl", request: {}, createdBy: "u" }, NOW.toISOString());
    const thread = createThread(s.db, { projectId: p.id, kind: "project", title: "Kênh", createdBy: "u" }, NOW.toISOString());
    const { turn } = postUserMessage(s.db, { threadId: thread.id, text: "chào", actor: { id: "u", role: "owner" } }, NOW.toISOString());
    const folders = {
      [join(dataRoot, "job-runs", running.id)]: DAYS(2),
      [join(dataRoot, "job-runs", "gone-old")]: DAYS(2),
      [join(dataRoot, "job-runs", "gone-new")]: HOURS(1),
      [join(dataRoot, "agent-runs", turn!.id)]: DAYS(2),
      [join(dataRoot, "agent-runs", "ended-old")]: DAYS(2),
    };
    for (const [dir, at] of Object.entries(folders)) { mkdirSync(dir, { recursive: true }); aged(dir, at); }
    expect(sweepScratch(s.db, dataRoot, HOURS(6).getTime())).toBe(2);
    expect(Object.keys(folders).map((d) => existsSync(d))).toEqual([true, false, true, true, false]);
  });

  it("empties each project's .trash of what was deleted long enough ago", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const trash = join(root, "p1", ".trash");
    mkdirSync(join(trash, "old"), { recursive: true });
    writeFileSync(join(trash, "new.md"), "x");
    aged(join(trash, "old"), DAYS(30));
    aged(join(trash, "new.md"), DAYS(1));
    mkdirSync(join(root, "p2"));
    expect(sweepTrash(root, DAYS(14).getTime())).toBe(1);
    expect([existsSync(join(trash, "old")), existsSync(join(trash, "new.md"))]).toEqual([false, true]);
  });

  it("files a browser put on the bucket and nobody took go after a day; other objects stay", async () => {
    s = world();
    for (const k of ["uploads/p1/old", "uploads/library/old", "uploads/p1/new", "library/music/a.m4a"]) await s.bucket.put(k, Buffer.from("x"));
    for (const k of ["uploads/p1/old", "uploads/library/old", "library/music/a.m4a"]) s.bucket.modified.set(k, DAYS(2));
    expect(await sweepRawUploads(s.bucket, DAYS(1))).toBe(2);
    expect([...s.bucket.objects.keys()].sort()).toEqual(["library/music/a.m4a", "uploads/p1/new"]);
  });

  it("one sweep reports each kind; without a voice store or workspaces those parts are skipped", async () => {
    s = world();
    const dataRoot = mkdtempSync(join(tmpdir(), "data-"));
    const dir = join(dataRoot, "job-runs", "gone");
    mkdirSync(dir, { recursive: true });
    aged(dir, DAYS(1));
    logAudit(s.db, { at: DAYS(91).toISOString(), actorKind: "user", kind: "http", action: "old", outcome: "ok" });
    logAudit(s.db, { at: DAYS(89).toISOString(), actorKind: "user", kind: "http", action: "kept", outcome: "ok" });
    expect(await sweepStudioData({ db: s.db, bucket: s.bucket, dataRoot }, { now: NOW })).toEqual({ voiceLines: 0, audioObjects: 0, rawUploads: 0, scratch: 1, trash: 0, auditRows: 1 });
    expect(listAudit(s.db, {}).items.map((r) => r.action)).toEqual(["kept"]);
  });
});
