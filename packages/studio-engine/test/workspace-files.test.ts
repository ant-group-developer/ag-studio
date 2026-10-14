import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accessFor, createProject, deleteWorkspaceFile, getFileVersion, listFileVersions, listWorkspaceTree, normalizeRelPath, projectDir,
  readWorkspaceFile, scanWorkspace, statWorkspaceFile, seedWorkspace, StudioRunError, turnChangedFiles, versionDiff, writeWorkspaceFile,
} from "../src/index.js";
import { world } from "./helpers.js";

const NOW = "2026-10-10T08:00:00.000Z";

function setup() {
  const w = world();
  w.db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES ('team-1', 'Team', ?, ?)", [NOW, NOW]);
  const project = createProject(w.db, "team-1", { name: "Du lịch Việt", channelUrl: "@dulichviet", description: "Đi bộ chậm", language: "vi", aspect: "16:9" }, "auth0|u1", NOW);
  const root = mkdtempSync(join(tmpdir(), "ws-root-"));
  const dir = seedWorkspace(root, project, NOW);
  return { ...w, project, root, dir };
}
const failure = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof StudioRunError ? `${e.code}:${String(e.details.code ?? "")}` : String(e); }
  return null;
};

describe("workspace paths", () => {
  it("normalises a relative path and refuses anything that could leave the project", () => {
    expect(normalizeRelPath("context\\notes.md")).toBe("context/notes.md");
    expect(normalizeRelPath("./videos/v1/brief.md")).toBe("videos/v1/brief.md");
    for (const bad of ["", "/etc/passwd", "C:/x.md", "c:\\x", "../x", "a/../../x", "a/./../b/../../c", "x\u0000y", "a//b/" + "z".repeat(400)]) {
      expect(failure(() => normalizeRelPath(bad))).toBe("invalid:bad_path");
    }
  });

  it("puts each project in its own folder under the root, and only for a project-shaped id", () => {
    expect(projectDir("/r", "11111111-1111-4111-8111-111111111111")).toBe(join("/r", "11111111-1111-4111-8111-111111111111"));
    expect(failure(() => projectDir("/r", "../x"))).toBe("invalid:bad_project");
  });

  it("says who may read and write what", () => {
    expect(accessFor("CLAUDE.md", "user")).toBe("write");
    expect(accessFor("CLAUDE.md", "agent")).toBe("write");
    expect(accessFor(".studio/playbook.yaml", "user")).toBe("write");
    expect(accessFor(".studio/playbook.yaml", "agent")).toBe("read");
    expect(accessFor(".studio/status.json", "user")).toBe("read");
    expect(accessFor("inputs/a1/shots.json", "user")).toBe("read");
    expect(accessFor("videos/v1/renders/preview.md", "agent")).toBe("read");
    expect(accessFor("videos/v1/brief.md", "agent")).toBe("write");
    expect(accessFor(".claude/settings.json", "user")).toBe("none");
    expect(accessFor(".git/config", "agent")).toBe("none");
  });
});

describe("seeding a workspace", () => {
  it("writes CLAUDE.md about the channel, the lessons file it imports, and the folders", () => {
    const { dir } = setup();
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("# Du lịch Việt");
    expect(claude).toContain("@dulichviet");
    expect(claude).toContain("Đi bộ chậm");
    expect(claude).toContain("@memory/lessons.md");
    for (const d of ["context", "research", "channel", "videos", "skills", "memory", ".studio"]) expect(existsSync(join(dir, d))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".studio", "workspace.json"), "utf8"))).toMatchObject({ project_id: expect.any(String) });
  });
});

describe("reading and writing files", () => {
  it("lists the tree without hidden folders, with sizes and what the person may do", () => {
    const { dir } = setup();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "x.json"), "{}");
    const tree = listWorkspaceTree(dir);
    const paths = tree.map((e) => e.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("memory/lessons.md");
    expect(paths.some((p) => p.startsWith(".claude"))).toBe(false);
    expect(tree.find((e) => e.path === "CLAUDE.md")).toMatchObject({ kind: "file", access: "write" });
    expect(tree.find((e) => e.path === ".studio/workspace.json")).toMatchObject({ kind: "file", access: "read" });
  });

  it("writes a file atomically, records a version, and refuses a write based on a stale copy", () => {
    const { db, project, dir } = setup();
    const first = writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/notes.md", content: "# Ghi chú\n", baseSha256: null, author: { kind: "user", id: "auth0|u1" }, now: NOW });
    const read = readWorkspaceFile(dir, "context/notes.md");
    expect(read).toMatchObject({ path: "context/notes.md", text: "# Ghi chú\n", sha256: first.sha256, binary: false });
    // somebody else wrote in between: the base no longer matches
    writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/notes.md", content: "khác\n", baseSha256: first.sha256, author: { kind: "agent", id: "agent", messageId: "m1" }, now: NOW });
    expect(failure(() => writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/notes.md", content: "của tôi\n", baseSha256: first.sha256, author: { kind: "user", id: "u" }, now: NOW })))
      .toBe("conflict:file_conflict");
    // a new file must not exist yet when the base says so
    expect(failure(() => writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/notes.md", content: "x", baseSha256: null, author: { kind: "user", id: "u" }, now: NOW })))
      .toBe("conflict:file_conflict");
    const versions = listFileVersions(db, project.id, "context/notes.md");
    expect(versions.map((v) => [v.author_kind, v.message_id])).toEqual([["agent", "m1"], ["user", null]]);
    expect(getFileVersion(db, project.id, versions[1]!.id)?.content).toBe("# Ghi chú\n");
  });

  it("refuses writes to read-only and hidden places, and through a link out of the project", () => {
    const { db, project, dir, root } = setup();
    const w = (path: string) => failure(() => writeWorkspaceFile(db, { projectId: project.id, dir, path, content: "x", author: { kind: "user", id: "u" }, now: NOW }));
    expect(w(".studio/status.json")).toBe("rejected:read_only");
    expect(w("inputs/a1/README.md")).toBe("rejected:read_only");
    expect(w(".claude/settings.json")).toBe("rejected:read_only");
    const outside = join(root, "outside");
    mkdirSync(outside);
    let linked = true;
    try { symlinkSync(outside, join(dir, "context", "link"), "junction"); } catch { linked = false; }
    if (linked) {
      expect(w("context/link/x.md")).toBe("invalid:bad_path");
      expect(failure(() => readWorkspaceFile(dir, "context/link/x.md"))).toBe("invalid:bad_path");
    }
  });

  it("reads a binary file as such from its size alone (no read, no checksum), and a missing one as not found", () => {
    const { dir } = setup();
    writeFileSync(join(dir, "context", "pic.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]));
    expect(readWorkspaceFile(dir, "context/pic.jpg")).toMatchObject({ binary: true, text: null, mime: "image/jpeg", size: 5, sha256: null });
    expect(statWorkspaceFile(dir, "context/pic.jpg")).toMatchObject({ path: "context/pic.jpg", abs: join(dir, "context", "pic.jpg"), size: 5, mime: "image/jpeg" });
    expect(failure(() => readWorkspaceFile(dir, "context/nope.md"))).toBe("not_found:");
    expect(failure(() => statWorkspaceFile(dir, "context"))).toBe("not_found:");
    // a text file too large to show is told the same way; one that only looks like text keeps its checksum
    writeFileSync(join(dir, "context", "big.md"), "x".repeat(64));
    expect(readWorkspaceFile(dir, "context/big.md", { maxTextBytes: 32 })).toMatchObject({ binary: true, text: null, size: 64, sha256: null });
    expect(readWorkspaceFile(dir, "context/big.md")).toMatchObject({ binary: false, text: "x".repeat(64), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    writeFileSync(join(dir, "context", "nul.md"), Buffer.from([0x61, 0x00]));
    expect(readWorkspaceFile(dir, "context/nul.md")).toMatchObject({ binary: true, text: null, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("deletes a file with a version that says so", () => {
    const { db, project, dir } = setup();
    const w = writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/a.md", content: "a", author: { kind: "user", id: "u" }, now: NOW });
    deleteWorkspaceFile(db, { projectId: project.id, dir, path: "context/a.md", baseSha256: w.sha256, author: { kind: "user", id: "u" }, now: NOW });
    expect(existsSync(join(dir, "context", "a.md"))).toBe(false);
    expect(listFileVersions(db, project.id, "context/a.md")[0]).toMatchObject({ sha256: "", size: 0 });
  });
});

describe("scanning the workspace after an agent turn", () => {
  it("records the text files the agent added, changed or deleted, once", () => {
    const { db, project, dir } = setup();
    scanWorkspace(db, { projectId: project.id, dir, author: { kind: "studio", id: null }, now: NOW });
    writeFileSync(join(dir, "channel", "branding.md"), "# Branding\n");
    writeFileSync(join(dir, "CLAUDE.md"), readFileSync(join(dir, "CLAUDE.md"), "utf8") + "\n- Không dùng nhạc buồn.\n");
    mkdirSync(join(dir, "inputs", "a1"), { recursive: true });
    writeFileSync(join(dir, "inputs", "a1", "shots.json"), "[]");
    const out = scanWorkspace(db, { projectId: project.id, dir, author: { kind: "agent", id: "agent", messageId: "m7" }, now: NOW });
    expect(out.changed.sort()).toEqual(["CLAUDE.md", "channel/branding.md"]);
    expect(out.deleted).toEqual([]);
    expect(listFileVersions(db, project.id, "channel/branding.md")[0]).toMatchObject({ author_kind: "agent", message_id: "m7" });
    expect(scanWorkspace(db, { projectId: project.id, dir, author: { kind: "agent", id: "agent" }, now: NOW }).changed).toEqual([]);
    rmSync(join(dir, "channel", "branding.md"));
    expect(scanWorkspace(db, { projectId: project.id, dir, author: { kind: "agent", id: "agent" }, now: NOW }).deleted).toEqual(["channel/branding.md"]);
  });

  it("a turn's changed files: each path once against the version before the turn, with lines added and removed", () => {
    const { db, project, dir } = setup();
    writeFileSync(join(dir, "context", "notes.md"), "một\nhai\nba\n");
    writeFileSync(join(dir, "context", "gone.md"), "x\ny\n");
    writeFileSync(join(dir, "context", "same.md"), "giữ\n");
    scanWorkspace(db, { projectId: project.id, dir, author: { kind: "user", id: "u" }, now: NOW });
    const agent = { kind: "agent" as const, id: "u", messageId: "m1" };
    // edited twice in the turn: compared with the version before the turn
    writeFileSync(join(dir, "context", "notes.md"), "một\nHAI\nba\n");
    scanWorkspace(db, { projectId: project.id, dir, author: agent, now: NOW });
    writeFileSync(join(dir, "context", "notes.md"), "một\nHAI\nba\nbốn\n");
    writeFileSync(join(dir, "context", "new.md"), "mới\n");
    writeFileSync(join(dir, "context", "tmp.md"), "tạm\n");
    writeFileSync(join(dir, "context", "same.md"), "đổi\n");
    rmSync(join(dir, "context", "gone.md"));
    scanWorkspace(db, { projectId: project.id, dir, author: agent, now: NOW });
    // made then removed, or put back as it was: not listed
    rmSync(join(dir, "context", "tmp.md"));
    writeFileSync(join(dir, "context", "same.md"), "giữ\n");
    scanWorkspace(db, { projectId: project.id, dir, author: agent, now: NOW });
    const before = (p: string) => listFileVersions(db, project.id, p).find((v) => v.message_id !== "m1")!.id;
    expect(turnChangedFiles(db, project.id, "m1")).toEqual([
      { path: "context/gone.md", change: "deleted", version_id: listFileVersions(db, project.id, "context/gone.md")[0]!.id, before_version_id: before("context/gone.md"), added: 0, removed: 2 },
      { path: "context/new.md", change: "added", version_id: listFileVersions(db, project.id, "context/new.md")[0]!.id, before_version_id: null, added: 1, removed: 0 },
      { path: "context/notes.md", change: "modified", version_id: listFileVersions(db, project.id, "context/notes.md")[0]!.id, before_version_id: before("context/notes.md"), added: 2, removed: 1 },
    ]);
    expect(turnChangedFiles(db, project.id, "other")).toEqual([]);
  });

  it("what a version changed: against the one before it, or a chosen base; binary or too big cannot be shown", () => {
    const { db, project, dir } = setup();
    const author = { kind: "user" as const, id: "u" };
    const first = writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/a.md", content: "một\nhai\nba\n", author });
    expect(versionDiff(db, project.id, first.versionId)).toMatchObject({
      path: "context/a.md", before_version_id: null, added: 3, removed: 0,
      hunks: [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: 3 }],
    });
    const second = writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/a.md", content: "một\nHAI\nba\n", author });
    const third = writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/a.md", content: "một\nHAI\nba\nbốn\n", author });
    expect(versionDiff(db, project.id, third.versionId)).toEqual({
      path: "context/a.md", version_id: third.versionId, before_version_id: second.versionId, added: 1, removed: 0,
      hunks: [{ old_start: 1, old_lines: 3, new_start: 1, new_lines: 4, lines: [
        { kind: "context", text: "một" }, { kind: "context", text: "HAI" }, { kind: "context", text: "ba" }, { kind: "add", text: "bốn" },
      ] }],
    });
    expect(versionDiff(db, project.id, third.versionId, { base: first.versionId })).toMatchObject({ before_version_id: first.versionId, added: 2, removed: 1 });
    // a file a turn made (and then edited): against nothing
    expect(versionDiff(db, project.id, third.versionId, { base: null })).toMatchObject({ before_version_id: null, added: 4, removed: 0 });
    deleteWorkspaceFile(db, { projectId: project.id, dir, path: "context/a.md", author });
    expect(versionDiff(db, project.id, listFileVersions(db, project.id, "context/a.md")[0]!.id)).toMatchObject({ added: 0, removed: 4 });
    const other = writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/b.md", content: "x\n", author });
    expect(failure(() => versionDiff(db, project.id, third.versionId, { base: other.versionId }))).toBe("invalid:bad_base");
    expect(failure(() => versionDiff(db, project.id, "nope"))).toBe("not_found:");
    const big = writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/big.md", content: "a\n".repeat(600_000), author });
    expect(versionDiff(db, project.id, big.versionId)).toEqual({ path: "context/big.md", version_id: big.versionId, before_version_id: null, unavailable: "too_large" });
    const png = writeWorkspaceFile(db, { projectId: project.id, dir, path: "context/logo.png", content: Buffer.from([0x89, 0x50, 0, 1]), author });
    expect(versionDiff(db, project.id, png.versionId)).toMatchObject({ unavailable: "binary" });
  });

  it("a turn's changed file too big to keep as text has no line counts", () => {
    const { db, project, dir } = setup();
    scanWorkspace(db, { projectId: project.id, dir, author: { kind: "studio", id: null }, now: NOW });
    writeFileSync(join(dir, "context", "big.md"), "a\n".repeat(600_000));
    scanWorkspace(db, { projectId: project.id, dir, author: { kind: "agent", id: "u", messageId: "m2" }, now: NOW });
    expect(turnChangedFiles(db, project.id, "m2")).toEqual([expect.objectContaining({ path: "context/big.md", change: "added" })]);
    expect(turnChangedFiles(db, project.id, "m2")[0]).not.toHaveProperty("added");
  });
});
