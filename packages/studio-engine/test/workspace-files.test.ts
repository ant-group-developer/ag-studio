import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accessFor, createProject, deleteWorkspaceFile, getFileVersion, listFileVersions, listWorkspaceTree, normalizeRelPath, projectDir,
  readWorkspaceFile, scanWorkspace, seedWorkspace, StudioRunError, writeWorkspaceFile,
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

  it("reads a binary file as such, and a missing one as not found", () => {
    const { dir } = setup();
    writeFileSync(join(dir, "context", "pic.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]));
    expect(readWorkspaceFile(dir, "context/pic.jpg")).toMatchObject({ binary: true, text: null, mime: "image/jpeg", size: 5 });
    expect(failure(() => readWorkspaceFile(dir, "context/nope.md"))).toBe("not_found:");
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
});
