/**
 * Moving uploads made before the media library into it (plan 2026-10-29 P5): footage on the bucket becomes the
 * uploader's items without a copy; audio and reference videos on the disk go to the bucket and to the project's trash.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSource, createProject, createVideo, listMediaItems, migrateMediaLibrary, projectAudioFiles, projectMediaFile, referenceMedia, seedWorkspace,
  sweepMediaLibrary, deleteMediaItem, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-29T08:00:00.000Z";
const OWNER = "auth0|owner";
const EDITOR = "auth0|editor";
const ASSET = "6f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";

const opened: StudioDb[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.close(); });

async function setup() {
  const w = await world();
  opened.push(w.db);
  await w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = await createProject(w.db, "team-1", { name: "Hoa Lư", description: "", language: "vi", aspect: "16:9" }, OWNER, NOW);
  const v1 = await createVideo(w.db, project.id, { title: "Tràng An", createdBy: OWNER }, NOW);
  const v2 = await createVideo(w.db, project.id, { title: "Hang Múa", createdBy: OWNER }, NOW);
  const root = join(w.dir, "workspaces");
  const ws = seedWorkspace(root, project);
  // before the library: footage on the bucket under the project, in two videos
  const key = `library/studio/projects/${project.id}/footage/${ASSET}.mp4`;
  await w.bucket.put(key, Buffer.from("video"));
  for (const v of [v1, v2]) {
    await addSource(w.db, { projectId: project.id, videoId: v.id, kind: "upload_asset", ref: ASSET, mediaType: "video", label: "Thuyền.mp4", meta: { key, bytes: 5 }, addedBy: EDITOR }, NOW);
  }
  // audio and a reference video on the disk, with their rows; an audio file put through the Files tab (no row); a document
  const file = (rel: string, body: string) => { mkdirSync(join(ws, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(ws, ...rel.split("/")), body); };
  file("context/audio/Biển sáng.mp3", "a".repeat(2048));
  file("context/references/Mẫu.mp4", "v".repeat(4096));
  file("context/audio/nhac/Gió.wav", "w".repeat(1024));
  file("context/uploads/ghi-chu.md", "# ghi chú");
  await addSource(w.db, { projectId: project.id, kind: "upload", ref: "context/audio/Biển sáng.mp3", mediaType: "audio", label: "Biển sáng.mp3", addedBy: EDITOR }, NOW);
  await addSource(w.db, { projectId: project.id, kind: "upload", ref: "context/references/Mẫu.mp4", mediaType: "video", label: "Mẫu.mp4", meta: { reference: true }, addedBy: EDITOR }, NOW);
  await addSource(w.db, { projectId: project.id, kind: "upload", ref: "context/audio/Mất.mp3", mediaType: "audio", label: "Mất.mp3", addedBy: EDITOR }, NOW);
  return { ...w, project, v1, v2, root, ws, key };
}

describe("migrating uploads into the media library", () => {
  it("a dry run says what it would do and changes nothing", async () => {
    const s = await setup();
    const lines: string[] = [];
    const r = await migrateMediaLibrary(s.db, s.bucket, { workspacesRoot: s.root, apply: false, now: NOW, log: (l) => lines.push(l) });
    expect(r).toEqual({
      footage: { items: 1, sources: 2 },
      files: { items: 3, sources: 3, bytes: 2048 + 4096 + 1024 },
      skipped: [{ project: s.project.id, ref: "context/audio/Mất.mp3", reason: "không còn file trên đĩa" }],
    });
    expect(lines.join("\n")).toContain("context/references/Mẫu.mp4");
    expect((await listMediaItems(s.db, EDITOR)).total).toBe(0);
    expect(existsSync(join(s.ws, "context", "audio", "Biển sáng.mp3"))).toBe(true);
    expect(await s.bucket.list("library/studio/users/")).toEqual([]);
  });

  it("applies: footage keeps its key, disk files go to the uploader's library and the trash, and a second run has nothing left", async () => {
    const s = await setup();
    const r = await migrateMediaLibrary(s.db, s.bucket, { workspacesRoot: s.root, apply: true, now: NOW });
    expect(r.footage).toEqual({ items: 1, sources: 2 });
    expect(r.files).toEqual({ items: 3, sources: 3, bytes: 7168 });
    // the editor's footage, audio and reference video; the Files-tab audio is the project owner's
    const mine = (await listMediaItems(s.db, EDITOR)).items;
    expect(mine.map((m) => [m.name, m.kind]).sort()).toEqual([["Biển sáng.mp3", "audio"], ["Mẫu.mp4", "video"], ["Thuyền.mp4", "video"]]);
    expect(mine.find((m) => m.name === "Thuyền.mp4")).toMatchObject({ id: ASSET });
    expect(await s.db.get("SELECT key FROM media_items WHERE id = ?", [ASSET])).toEqual({ key: s.key });
    expect((await listMediaItems(s.db, OWNER)).items.map((m) => m.name)).toEqual(["Gió.wav"]);
    expect(await s.db.all("SELECT video_id FROM project_sources WHERE ref = ? AND media_id = ?", [ASSET, ASSET])).toHaveLength(2);
    // the project reads them from the bucket under the same paths
    const audio = await projectMediaFile(s.db, s.project.id, "context/audio/Biển sáng.mp3");
    expect(audio!.key).toMatch(/^library\/studio\/users\/.+\/media\/.+\.mp3$/);
    expect((await s.bucket.get(audio!.key)).toString()).toBe("a".repeat(2048));
    expect([...(await referenceMedia(s.db, s.project.id)).keys()]).toEqual(["context/references/Mẫu.mp4"]);
    expect((await projectAudioFiles(s.db, s.ws, s.project.id)).map((f) => [f.path, !!f.key]).sort()).toEqual([["context/audio/Biển sáng.mp3", true], ["context/audio/nhac/Gió.wav", true]]);
    // off the disk, into this run's trash; the document stays
    expect(existsSync(join(s.ws, "context", "audio", "Biển sáng.mp3"))).toBe(false);
    expect(existsSync(join(s.ws, ".trash", "media-library-2026-10-29T08-00-00-000Z", "context", "references", "Mẫu.mp4"))).toBe(true);
    expect(existsSync(join(s.ws, "context", "uploads", "ghi-chu.md"))).toBe(true);
    const again = await migrateMediaLibrary(s.db, s.bucket, { workspacesRoot: s.root, apply: true, now: NOW });
    expect(again).toMatchObject({ footage: { items: 0, sources: 0 }, files: { items: 0, sources: 0, bytes: 0 } });
  });

  it("footage of the old key is deleted from the bucket once its item is deleted and no project uses it", async () => {
    const s = await setup();
    await migrateMediaLibrary(s.db, s.bucket, { workspacesRoot: s.root, apply: true, now: NOW });
    await s.db.run("DELETE FROM project_sources WHERE ref = ?", [ASSET]);
    await deleteMediaItem(s.db, EDITOR, ASSET, NOW);
    await sweepMediaLibrary(s.db, s.bucket, new Date("2026-11-30T00:00:00Z"));
    expect(await s.bucket.exists(s.key)).toBeNull();
  });
});
