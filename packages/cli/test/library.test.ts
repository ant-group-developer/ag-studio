import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { newId, type ContentItem, type Run } from "@harness/contracts";
import { HARNESS_ROOT, SqliteStateStore } from "@harness/core";

const MAIN = join(HARNESS_ROOT, "packages", "cli", "src", "main.ts");
const SHA = "sha256:" + "a".repeat(64);

function cli(project: string, ...args: string[]) {
  return cliEnv(project, {}, ...args);
}
function cliEnv(project: string, env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, "--project", project, ...args], { encoding: "utf8", env: { ...process.env, HARNESS_LOG_LEVEL: "error", ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** Copies `fixtures/ops-project-minimal` and optionally rewrites `project.yaml` (e.g. to add `library` or
 * give the copy its own `project_id` so two copies can share one kho root without colliding). */
function freshProject(edit?: (cfg: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-lib-"));
  cpSync(join(HARNESS_ROOT, "fixtures", "ops-project-minimal"), dir, { recursive: true });
  if (edit) {
    const path = join(dir, "project.yaml");
    const cfg = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    edit(cfg);
    writeFileSync(path, stringify(cfg));
  }
  return dir;
}

function libraryProject(root: string, role: "studio" | "channel", idSuffix: string): string {
  return freshProject((cfg) => { cfg.project_id = `${cfg.project_id}-${idSuffix}`; cfg.library = { root, role }; });
}

/** A schema-valid EditStyle document, at whatever point of the draft -> active lifecycle the caller needs. */
function styleJson(styleId: string, status: "draft" | "active" | "retired" = "active"): string {
  const style = {
    schema_version: "harness.edit-style/v1", style_id: styleId, revision: 1, name: "Test style", status,
    learned_from: [],
    params: {
      cut_rhythm: "medium", shot_seconds: [2, 5], transitions: [], text_overlay: { style: "bold", density: "low" },
      subtitles: "burn-in", music: { mood: "upbeat", ducking: true }, opening: { seconds: 3, structure: "hook" }, aspect_ratio: "16:9", pace_notes: "",
    },
    evidence: [], created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
  return JSON.stringify(style, null, 2) + "\n";
}

/** Writes a schema-valid, `active` EditStyle straight into the kho, as `style-export` would have. */
function writeStyleFile(root: string, styleId: string): void {
  const dir = join(root, "styles", styleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "style.json"), styleJson(styleId, "active"));
}

/** Writes a schema-valid `pending_review` LibraryItem manifest straight into the kho, as `library-export`
 * would have -- the files it lists need not exist on disk, since neither `applyReview` nor `claimItem` verify
 * checksums (only `syncLibrary` does that, and this scenario never syncs the item before reviewing it). */
function writeItemManifest(root: string, itemId: string, styleId: string, runId: string, contentId: string): void {
  const dir = join(root, "items", itemId);
  mkdirSync(dir, { recursive: true });
  const item = {
    schema_version: "harness.library-item/v1", item_id: itemId, status: "pending_review", title_hint: "Hand-written item", summary: "",
    style: { style_id: styleId, revision: 1 }, duration_seconds: 42, media: null,
    files: [{ path: "episode.mp4", checksum: SHA, size_bytes: 1, mime_type: "video/mp4" }],
    lineage: { project_id: "project-studio", run_id: runId, content_id: contentId, source_ids: [] },
    review: { note: "" }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(item, null, 2) + "\n");
}

/** Like `writeItemManifest`, but the data file really exists and the manifest carries its real checksum --
 * what `library sync` needs to have something to verify. Returns the data file's path. */
function writeRealItem(root: string, itemId: string, styleId: string): string {
  const dir = join(root, "items", itemId);
  mkdirSync(dir, { recursive: true });
  const body = `episode bytes for ${itemId}\n`;
  const dataPath = join(dir, "episode.mp4");
  writeFileSync(dataPath, body);
  const item = {
    schema_version: "harness.library-item/v1", item_id: itemId, status: "approved", title_hint: "Real item", summary: "",
    style: { style_id: styleId, revision: 1 }, duration_seconds: 42, media: null,
    files: [{ path: "episode.mp4", checksum: "sha256:" + createHash("sha256").update(body).digest("hex"), size_bytes: Buffer.byteLength(body), mime_type: "video/mp4" }],
    lineage: { project_id: "project-studio", run_id: newId("run"), content_id: newId("content_item"), source_ids: [] },
    review: { note: "" }, created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(item, null, 2) + "\n");
  return dataPath;
}

describe("harness library CLI", () => {
  it("a channel request flows through studio sync/accept/review to a channel pick", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-"));
    const channelDir = libraryProject(root, "channel", "channel");
    const studioDir = libraryProject(root, "studio", "studio");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);
    expect(cli(studioDir, "db", "migrate").code).toBe(0);

    // studio has already produced and exported an active style before this scenario starts
    const styleId = newId("edit_style");
    writeStyleFile(root, styleId);

    // 1. channel creates an open request; it lands as a file in the kho
    const created = cli(channelDir, "library", "request", "create", "--portfolio", "portfolio-main", "--channel", "channel-main", "--topic", "Sample topic", "--style", styleId, "--json");
    expect(created.code, created.err).toBe(0);
    const request = JSON.parse(created.out);
    expect(request.request_id).toMatch(/^req_/);
    expect(request.status).toBe("open");
    const requestFile = join(root, "requests", `${request.request_id}.json`);
    expect(existsSync(requestFile)).toBe(true);
    expect(JSON.parse(readFileSync(requestFile, "utf8")).status).toBe("open");

    // 2. studio syncs and now sees both the style and the request in its own DB mirror
    const sync = cli(studioDir, "library", "sync", "--json");
    expect(sync.code, sync.err).toBe(0);
    const syncReport = JSON.parse(sync.out);
    expect(syncReport.imported.styles).toContain(styleId);
    expect(syncReport.imported.requests).toContain(request.request_id);
    expect(syncReport.corrupt).toHaveLength(0);

    const listed = cli(studioDir, "library", "list", "requests", "--json");
    expect(listed.code, listed.err).toBe(0);
    const requests = JSON.parse(listed.out);
    expect(requests).toHaveLength(1);
    expect(requests[0].request_id).toBe(request.request_id);

    // 3. studio accepts the request against a locally-known source, minting a local ContentItem (no kho write)
    const raw = join(studioDir, "raw.txt");
    writeFileSync(raw, "raw source bytes");
    const ingested = cli(studioDir, "source", "ingest", raw, "--json");
    expect(ingested.code, ingested.err).toBe(0);
    const sourceId = JSON.parse(ingested.out).source_id;

    const accepted = cli(studioDir, "library", "accept", "--request", request.request_id, "--source", sourceId, "--json");
    expect(accepted.code, accepted.err).toBe(0);
    const acceptedContentId = JSON.parse(accepted.out).content_id;
    expect(acceptedContentId).toMatch(/^content_/);
    // accept never claims the request -- it is still open on disk
    expect(JSON.parse(readFileSync(requestFile, "utf8")).status).toBe("open");

    // 4. a library-export'd item (hand-written here, standing in for the real export stage) is reviewed
    const itemId = newId("library_item");
    writeItemManifest(root, itemId, styleId, newId("run"), acceptedContentId);
    const reviewed = cli(studioDir, "library", "review", itemId, "--approve", "--note", "looks good", "--json");
    expect(reviewed.code, reviewed.err).toBe(0);
    const reviewOut = JSON.parse(reviewed.out);
    expect(reviewOut.status).toBe("approved");
    const manifestPath = join(root, "items", itemId, "manifest.json");
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).status).toBe("approved");

    // 5. channel picks the now-approved item, claiming it and minting its own local ContentItem
    const picked = cli(channelDir, "library", "pick", itemId, "--channel", "channel-main", "--json");
    expect(picked.code, picked.err).toBe(0);
    const pickedContentId = JSON.parse(picked.out).content_id;
    expect(pickedContentId).toMatch(/^content_/);
    expect(existsSync(join(root, "items", itemId, "claims", "channel-main.json"))).toBe(true);

    // picking again is idempotent: same claim, same content_id, no error
    const pickedAgain = cli(channelDir, "library", "pick", itemId, "--channel", "channel-main", "--json");
    expect(pickedAgain.code, pickedAgain.err).toBe(0);
    expect(JSON.parse(pickedAgain.out).content_id).toBe(pickedContentId);
  });

  it("rejects every `library` subcommand with CONFIG_INVALID when project.yaml has no library", () => {
    const p = freshProject();
    expect(cli(p, "db", "migrate").code).toBe(0);
    const r = cli(p, "library", "sync");
    expect(r.code).toBe(1);
    expect(r.err).toContain("CONFIG_INVALID");
  });

  it("`library sync` exits 1 when the kho holds a corrupt request file", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-corrupt-"));
    const studioDir = libraryProject(root, "studio", "corrupt");
    expect(cli(studioDir, "db", "migrate").code).toBe(0);
    mkdirSync(join(root, "requests"), { recursive: true });
    const corruptPath = join(root, "requests", "broken.json");
    writeFileSync(corruptPath, "{ not valid json");

    const sync = cli(studioDir, "library", "sync", "--json");
    expect(sync.code).toBe(1);
    const report = JSON.parse(sync.out);
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0].path).toBe(corruptPath);
  });

  it("`library request create --count` accepts only 1", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-count-"));
    const channelDir = libraryProject(root, "channel", "count");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);
    const styleId = newId("edit_style");
    writeStyleFile(root, styleId);

    const many = cli(channelDir, "library", "request", "create", "--portfolio", "portfolio-main", "--topic", "t", "--style", styleId, "--count", "3", "--json");
    expect(many.code).toBe(1);
    expect(many.err).toContain("CONFIG_INVALID");
    expect(many.err).toContain("--count");

    const one = cli(channelDir, "library", "request", "create", "--portfolio", "portfolio-main", "--topic", "t", "--style", styleId, "--count", "1", "--json");
    expect(one.code, one.err).toBe(0);
    expect(JSON.parse(one.out).count).toBe(1);
  });

  it("`library withdraw` moves an approved item to withdrawn in the kho", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-withdraw-"));
    const studioDir = libraryProject(root, "studio", "withdraw");
    expect(cli(studioDir, "db", "migrate").code).toBe(0);
    const styleId = newId("edit_style");
    writeStyleFile(root, styleId);

    const itemId = newId("library_item");
    writeItemManifest(root, itemId, styleId, newId("run"), newId("content_item"));
    expect(cli(studioDir, "library", "review", itemId, "--approve", "--json").code).toBe(0);

    const withdrawn = cli(studioDir, "library", "withdraw", itemId, "--note", "kênh không dùng nữa", "--json");
    expect(withdrawn.code, withdrawn.err).toBe(0);
    expect(JSON.parse(withdrawn.out).status).toBe("withdrawn");
    const onDisk = JSON.parse(readFileSync(join(root, "items", itemId, "manifest.json"), "utf8"));
    expect(onDisk.status).toBe("withdrawn");
    expect(onDisk.review.note).toContain("kênh không dùng nữa");

    // a pending_review item is not withdrawable
    const otherId = newId("library_item");
    writeItemManifest(root, otherId, styleId, newId("run"), newId("content_item"));
    const refused = cli(studioDir, "library", "withdraw", otherId);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("INVALID_TRANSITION");
  });

  it("`library sync --verify` re-hashes data files of unchanged items; the cheap sync does not", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-verify-"));
    const studioDir = libraryProject(root, "studio", "verify");
    expect(cli(studioDir, "db", "migrate").code).toBe(0);
    const styleId = newId("edit_style");
    writeStyleFile(root, styleId);

    const itemId = newId("library_item");
    const dataPath = writeRealItem(root, itemId, styleId);
    expect(cli(studioDir, "library", "sync", "--json").code).toBe(0);

    writeFileSync(dataPath, "tampered bytes");

    const cheap = cli(studioDir, "library", "sync", "--json");
    expect(cheap.code).toBe(0);
    expect(JSON.parse(cheap.out).corrupt).toHaveLength(0);

    const audit = cli(studioDir, "library", "sync", "--verify", "--json");
    expect(audit.code).toBe(1);
    const report = JSON.parse(audit.out);
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0].path).toBe(dataPath);
  });

  it("`library sync` fails with IO_ERROR when the kho root is not mounted", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-unmounted-"));
    const studioDir = libraryProject(root, "studio", "unmounted");
    expect(cli(studioDir, "db", "migrate").code).toBe(0);
    rmSync(root, { recursive: true, force: true });

    const sync = cli(studioDir, "library", "sync", "--json");
    expect(sync.code).toBe(1);
    expect(sync.err).toContain("IO_ERROR");
    expect(sync.err).toContain(root);
    expect(existsSync(root)).toBe(false); // nothing scaffolded a local kho behind our back
  });

  it("`library styles activate` moves a draft style to active on studio and is refused on channel", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-activate-"));
    const studioDir = libraryProject(root, "studio", "activate");
    const channelDir = libraryProject(root, "channel", "activate-channel");
    expect(cli(studioDir, "db", "migrate").code).toBe(0);
    expect(cli(channelDir, "db", "migrate").code).toBe(0);
    const styleId = newId("edit_style");
    const dir = join(root, "styles", styleId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "style.json"), styleJson(styleId, "draft"));

    const refused = cli(channelDir, "library", "styles", "activate", styleId, "--json");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("CONFIG_INVALID");
    expect(JSON.parse(readFileSync(join(dir, "style.json"), "utf8")).status).toBe("draft");

    const activated = cli(studioDir, "library", "styles", "activate", styleId, "--json");
    expect(activated.code, activated.err).toBe(0);
    const out = JSON.parse(activated.out);
    expect(out.status).toBe("active");
    expect(out.revision).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, "style.json"), "utf8")).status).toBe("active");

    // idempotent: activating an already-active style again does not bump revision
    const again = cli(studioDir, "library", "styles", "activate", styleId, "--json");
    expect(again.code, again.err).toBe(0);
    expect(JSON.parse(again.out).revision).toBe(2);
  });

  it("`library request create --source-hint/--source-id` writes source_hint into the kho file", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-source-hint-"));
    const channelDir = libraryProject(root, "channel", "source-hint");
    expect(cli(channelDir, "db", "migrate").code).toBe(0);
    const styleId = newId("edit_style");
    writeStyleFile(root, styleId);

    const collectionOnly = cli(channelDir, "library", "request", "create", "--portfolio", "portfolio-main", "--topic", "t", "--style", styleId, "--source-hint", "main", "--json");
    expect(collectionOnly.code, collectionOnly.err).toBe(0);
    const r1 = JSON.parse(collectionOnly.out);
    expect(r1.source_hint).toEqual({ collection: "main" });
    const onDisk1 = JSON.parse(readFileSync(join(root, "requests", `${r1.request_id}.json`), "utf8"));
    expect(onDisk1.source_hint).toEqual({ collection: "main" });

    const srcA = newId("source_item");
    const srcB = newId("source_item");
    const withIds = cli(channelDir, "library", "request", "create", "--portfolio", "portfolio-main", "--topic", "t2", "--style", styleId, "--source-id", srcA, "--source-id", srcB, "--json");
    expect(withIds.code, withIds.err).toBe(0);
    const r2 = JSON.parse(withIds.out);
    expect(r2.source_hint.source_ids).toEqual([srcA, srcB]);
    expect(r2.source_hint.collection).toBeUndefined();
  });

  it("doctor reports the library:* rows for a project with a library root", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-doctor-"));
    mkdirSync(join(root, "styles"), { recursive: true });
    mkdirSync(join(root, "voices"), { recursive: true }); // sub-project 5A: library:voices also needs its directory
    const p = libraryProject(root, "studio", "doctor");
    expect(cli(p, "db", "migrate").code).toBe(0);
    const d = cli(p, "doctor", "--json");
    expect(d.code, d.err).toBe(0);
    const rows: { check: string; ok: boolean }[] = JSON.parse(d.out);
    const byCheck = new Map(rows.map((r) => [r.check, r]));
    expect(byCheck.get("library:root")).toMatchObject({ ok: true });
    expect(byCheck.get("library:write")).toMatchObject({ ok: true });
    expect(byCheck.get("library:index")).toMatchObject({ ok: true });
    expect(byCheck.get("library:voices")).toMatchObject({ ok: true });
  });

  describe("built-in `library stage intake` (run by hand, outside any real workflow)", () => {
    function stageWorkspace(): string {
      const dir = mkdtempSync(join(tmpdir(), "lib-stage-ws-"));
      mkdirSync(join(dir, "output"), { recursive: true });
      return dir;
    }
    function writeStageRequest(workspaceDir: string, run: Run): void {
      const stageRequest = {
        schema_version: "harness.stage-request/v1", run_id: run.run_id, stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
        project_id: run.project_id, portfolio_id: run.portfolio_id, stage_key: "intake",
        workflow: { id: "library-production", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "studio", revision: 1 },
        inputs: [], workspace_uri: "file://" + workspaceDir, stage_config: {}, options: {}, source_items: [], resources: [], expected_outputs: [],
        policy: {}, limits: { deadline_at: new Date(Date.now() + 3_600_000).toISOString(), max_cost_usd: 5, max_attempts: 3 },
        capabilities: [], fencing_token: 1,
      };
      writeFileSync(join(workspaceDir, "stage-request.json"), JSON.stringify(stageRequest, null, 2));
    }
    function insertRun(dbDir: string, content: ContentItem): Run {
      const store = new SqliteStateStore(join(dbDir, "data", "state", "harness.db"));
      const now = new Date().toISOString();
      store.insertContentItem(content);
      const run: Run = {
        schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-studio-intake", portfolio_id: "portfolio-main",
        workflow_release: { id: "library-production", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "studio", revision: 1 },
        content_id: content.content_id, options: {}, state: "READY", effective_config_snapshot: {}, effective_config_digest: SHA,
        total_cost_usd: 0, created_at: now, updated_at: now,
      };
      store.insertRun(run);
      store.close();
      return run;
    }

    it("writes output/brief.json and a succeeded stage-result.json when the content carries a matching library_brief", () => {
      const root = mkdtempSync(join(tmpdir(), "kho-intake-"));
      const studioDir = libraryProject(root, "studio", "intake");
      expect(cli(studioDir, "db", "migrate").code).toBe(0);
      const styleId = newId("edit_style");
      writeStyleFile(root, styleId);

      const content: ContentItem = {
        schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [], revision: 1, title: "Intake content", created_at: new Date().toISOString(),
        library_brief: { topic: "Intake topic", style_id: styleId, style_revision: 1, voice: "none", language: "vi" },
      };
      const run = insertRun(studioDir, content);

      const workspaceDir = stageWorkspace();
      writeStageRequest(workspaceDir, run);
      const r = cliEnv(studioDir, { HARNESS_WORKSPACE: workspaceDir }, "library", "stage", "intake");
      expect(r.code, r.err).toBe(0);

      const result = JSON.parse(readFileSync(join(workspaceDir, "stage-result.json"), "utf8"));
      expect(result.outcome).toBe("succeeded");
      const brief = JSON.parse(readFileSync(join(workspaceDir, "output", "brief.json"), "utf8"));
      expect(brief.topic).toBe("Intake topic");
      expect(brief.style_id).toBe(styleId);
      expect(brief.style_snapshot.style_id).toBe(styleId);
      expect(brief.style_snapshot.status).toBe("active");
    });

    it("fails with kind contract when the content has no library_brief", () => {
      const root = mkdtempSync(join(tmpdir(), "kho-intake-nobrief-"));
      const studioDir = libraryProject(root, "studio", "intake-nobrief");
      expect(cli(studioDir, "db", "migrate").code).toBe(0);

      const content: ContentItem = {
        schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [], revision: 1, title: "No brief", created_at: new Date().toISOString(),
      };
      const run = insertRun(studioDir, content);

      const workspaceDir = stageWorkspace();
      writeStageRequest(workspaceDir, run);
      const r = cliEnv(studioDir, { HARNESS_WORKSPACE: workspaceDir }, "library", "stage", "intake");
      expect(r.code, r.err).toBe(0); // the built-in stage always exits 0; failure is encoded in stage-result.json

      const result = JSON.parse(readFileSync(join(workspaceDir, "stage-result.json"), "utf8"));
      expect(result.outcome).toBe("failed");
      expect(result.errors[0].kind).toBe("contract");
      expect(existsSync(join(workspaceDir, "output", "brief.json"))).toBe(false);
    });

    function writeRequestFile(root: string, requestId: string, styleId: string, notes: string): void {
      mkdirSync(join(root, "requests"), { recursive: true });
      const request = {
        schema_version: "harness.content-request/v1", request_id: requestId,
        requested_by: { portfolio_id: "portfolio-main" }, topic: "Intake topic", style_id: styleId, style_revision: 1,
        voice: "none", language: "vi", count: 1, status: "open", item_ids: [], notes,
        created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
      };
      writeFileSync(join(root, "requests", `${requestId}.json`), JSON.stringify(request, null, 2) + "\n");
    }

    it("copies request.notes into brief.json.request_notes when the brief carries a request_id", () => {
      const root = mkdtempSync(join(tmpdir(), "kho-intake-notes-"));
      const studioDir = libraryProject(root, "studio", "intake-notes");
      expect(cli(studioDir, "db", "migrate").code).toBe(0);
      const styleId = newId("edit_style");
      writeStyleFile(root, styleId);
      const requestId = newId("content_request");
      writeRequestFile(root, requestId, styleId, "lý do cũ");

      const content: ContentItem = {
        schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [], revision: 1, title: "Intake content", created_at: new Date().toISOString(),
        library_brief: { request_id: requestId, topic: "Intake topic", style_id: styleId, style_revision: 1, voice: "none", language: "vi" },
      };
      const run = insertRun(studioDir, content);

      const workspaceDir = stageWorkspace();
      writeStageRequest(workspaceDir, run);
      const r = cliEnv(studioDir, { HARNESS_WORKSPACE: workspaceDir }, "library", "stage", "intake");
      expect(r.code, r.err).toBe(0);

      const result = JSON.parse(readFileSync(join(workspaceDir, "stage-result.json"), "utf8"));
      expect(result.outcome, JSON.stringify(result.errors)).toBe("succeeded");
      const brief = JSON.parse(readFileSync(join(workspaceDir, "output", "brief.json"), "utf8"));
      expect(brief.request_notes).toBe("lý do cũ");

      // intake is still the one place a request moves open -> claimed
      const onDisk = JSON.parse(readFileSync(join(root, "requests", `${requestId}.json`), "utf8"));
      expect(onDisk.status).toBe("claimed");
    });

    it("leaves brief.json.request_notes empty when the brief has no request_id", () => {
      const root = mkdtempSync(join(tmpdir(), "kho-intake-norequest-"));
      const studioDir = libraryProject(root, "studio", "intake-norequest");
      expect(cli(studioDir, "db", "migrate").code).toBe(0);
      const styleId = newId("edit_style");
      writeStyleFile(root, styleId);

      const content: ContentItem = {
        schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [], revision: 1, title: "Intake content", created_at: new Date().toISOString(),
        library_brief: { topic: "Intake topic", style_id: styleId, style_revision: 1, voice: "none", language: "vi" },
      };
      const run = insertRun(studioDir, content);

      const workspaceDir = stageWorkspace();
      writeStageRequest(workspaceDir, run);
      const r = cliEnv(studioDir, { HARNESS_WORKSPACE: workspaceDir }, "library", "stage", "intake");
      expect(r.code, r.err).toBe(0);

      const brief = JSON.parse(readFileSync(join(workspaceDir, "output", "brief.json"), "utf8"));
      expect(brief.request_notes).toBe("");
    });

    it("fails with kind contract when brief.request_id points at a request the kho does not have", () => {
      const root = mkdtempSync(join(tmpdir(), "kho-intake-missing-request-"));
      const studioDir = libraryProject(root, "studio", "intake-missing-request");
      expect(cli(studioDir, "db", "migrate").code).toBe(0);
      const styleId = newId("edit_style");
      writeStyleFile(root, styleId);

      const content: ContentItem = {
        schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [], revision: 1, title: "Intake content", created_at: new Date().toISOString(),
        library_brief: { request_id: newId("content_request"), topic: "Intake topic", style_id: styleId, style_revision: 1, voice: "none", language: "vi" },
      };
      const run = insertRun(studioDir, content);

      const workspaceDir = stageWorkspace();
      writeStageRequest(workspaceDir, run);
      const r = cliEnv(studioDir, { HARNESS_WORKSPACE: workspaceDir }, "library", "stage", "intake");
      expect(r.code, r.err).toBe(0);

      const result = JSON.parse(readFileSync(join(workspaceDir, "stage-result.json"), "utf8"));
      expect(result.outcome).toBe("failed");
      expect(result.errors[0].kind).toBe("contract");
    });
  });

  describe("built-in `library stage apply-review`", () => {
    function workspaceWithReview(reviewContent: string, exportReceiptContent: string): string {
      const dir = mkdtempSync(join(tmpdir(), "lib-apply-review-ws-"));
      mkdirSync(join(dir, "output"), { recursive: true });
      mkdirSync(join(dir, "input"), { recursive: true });
      writeFileSync(join(dir, "input", "review.json"), reviewContent);
      writeFileSync(join(dir, "input", "export-receipt.json"), exportReceiptContent);
      const inputs = [
        { artifact_id: newId("artifact"), checksum: SHA, path: "input/review.json", type: "review", kind: "file" },
        { artifact_id: newId("artifact"), checksum: SHA, path: "input/export-receipt.json", type: "export_receipt", kind: "file" },
      ];
      const stageRequest = {
        schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
        project_id: "project-studio", portfolio_id: "portfolio-main", stage_key: "apply-review",
        workflow: { id: "library-production", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "studio", revision: 1 },
        inputs, workspace_uri: "file://" + dir, stage_config: {}, options: {}, source_items: [], resources: [], expected_outputs: [],
        policy: {}, limits: { deadline_at: new Date(Date.now() + 3_600_000).toISOString(), max_cost_usd: 5, max_attempts: 3 },
        capabilities: [], fencing_token: 1,
      };
      writeFileSync(join(dir, "stage-request.json"), JSON.stringify(stageRequest, null, 2));
      return dir;
    }

    it("records checks_failed and rejects the item when a check fails", () => {
      const root = mkdtempSync(join(tmpdir(), "kho-apply-review-"));
      const studioDir = libraryProject(root, "studio", "apply-review");
      expect(cli(studioDir, "db", "migrate").code).toBe(0);
      const styleId = newId("edit_style");
      writeStyleFile(root, styleId);
      const itemId = newId("library_item");
      writeItemManifest(root, itemId, styleId, newId("run"), newId("content_item"));

      const review = { decision: "rejected", note: "audio missing", checks: [{ id: "audio_present", pass: false }] };
      const receipt = { item_id: itemId };
      const workspaceDir = workspaceWithReview(JSON.stringify(review), JSON.stringify(receipt));
      const r = cliEnv(studioDir, { HARNESS_WORKSPACE: workspaceDir }, "library", "stage", "apply-review");
      expect(r.code, r.err).toBe(0);

      const result = JSON.parse(readFileSync(join(workspaceDir, "stage-result.json"), "utf8"));
      expect(result.outcome, JSON.stringify(result.errors)).toBe("succeeded");
      const applyReceipt = JSON.parse(readFileSync(join(workspaceDir, "output", "apply-receipt.json"), "utf8"));
      expect(applyReceipt.status).toBe("rejected");
      expect(applyReceipt.checks_failed).toBe(1);
      expect(JSON.parse(readFileSync(join(root, "items", itemId, "manifest.json"), "utf8")).status).toBe("rejected");
    });

    it("still accepts an old review.json with no schema_version, note, or checks", () => {
      const root = mkdtempSync(join(tmpdir(), "kho-apply-review-legacy-"));
      const studioDir = libraryProject(root, "studio", "apply-review-legacy");
      expect(cli(studioDir, "db", "migrate").code).toBe(0);
      const styleId = newId("edit_style");
      writeStyleFile(root, styleId);
      const itemId = newId("library_item");
      writeItemManifest(root, itemId, styleId, newId("run"), newId("content_item"));

      const review = { decision: "approved" };
      const receipt = { item_id: itemId };
      const workspaceDir = workspaceWithReview(JSON.stringify(review), JSON.stringify(receipt));
      const r = cliEnv(studioDir, { HARNESS_WORKSPACE: workspaceDir }, "library", "stage", "apply-review");
      expect(r.code, r.err).toBe(0);

      const result = JSON.parse(readFileSync(join(workspaceDir, "stage-result.json"), "utf8"));
      expect(result.outcome, JSON.stringify(result.errors)).toBe("succeeded");
      const applyReceipt = JSON.parse(readFileSync(join(workspaceDir, "output", "apply-receipt.json"), "utf8"));
      expect(applyReceipt.status).toBe("approved");
      expect(applyReceipt.checks_failed).toBe(0);
    });
  });

  // `style-export` depends on style-review *and* analyze-style, and both stages emit a `style` artifact, so
  // the real workspace always carries two style inputs -- in stage order, draft first.
  describe("built-in `library stage style-export` with both style inputs present", () => {
    function workspaceWithStyles(styles: { name: string; content: string }[]): string {
      const dir = mkdtempSync(join(tmpdir(), "lib-style-export-ws-"));
      mkdirSync(join(dir, "output"), { recursive: true });
      const inputs = styles.map(({ name, content }) => {
        const rel = `input/${name}/style.json`;
        mkdirSync(join(dir, "input", name), { recursive: true });
        writeFileSync(join(dir, rel), content);
        return { artifact_id: newId("artifact"), checksum: SHA, path: rel, type: "style", kind: "file" };
      });
      const stageRequest = {
        schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
        project_id: "project-studio", portfolio_id: "portfolio-main", stage_key: "style-export",
        workflow: { id: "style-study", version: "1.0.0", digest: SHA }, profile_snapshot: { id: "studio", revision: 1 },
        inputs, workspace_uri: "file://" + dir, stage_config: {}, options: {}, source_items: [], resources: [], expected_outputs: [],
        policy: {}, limits: { deadline_at: new Date(Date.now() + 3_600_000).toISOString(), max_cost_usd: 5, max_attempts: 3 },
        capabilities: [], fencing_token: 1,
      };
      writeFileSync(join(dir, "stage-request.json"), JSON.stringify(stageRequest, null, 2));
      return dir;
    }

    it("exports the reviewed active style, not the draft the analyze-style gate produced first", () => {
      const root = mkdtempSync(join(tmpdir(), "kho-style-export-"));
      const studioDir = libraryProject(root, "studio", "style-export");
      expect(cli(studioDir, "db", "migrate").code).toBe(0);
      const styleId = newId("edit_style");

      const workspaceDir = workspaceWithStyles([
        { name: "analyze", content: styleJson(styleId, "draft") },
        { name: "review", content: styleJson(styleId, "active") },
      ]);
      const r = cliEnv(studioDir, { HARNESS_WORKSPACE: workspaceDir }, "library", "stage", "style-export");
      expect(r.code, r.err).toBe(0);

      const result = JSON.parse(readFileSync(join(workspaceDir, "stage-result.json"), "utf8"));
      expect(result.outcome, JSON.stringify(result.errors)).toBe("succeeded");
      expect(JSON.parse(readFileSync(join(root, "styles", styleId, "style.json"), "utf8")).status).toBe("active");
    });

    it("fails with kind contract when no style input has been reviewed to active", () => {
      const root = mkdtempSync(join(tmpdir(), "kho-style-export-draft-"));
      const studioDir = libraryProject(root, "studio", "style-export-draft");
      expect(cli(studioDir, "db", "migrate").code).toBe(0);
      const styleId = newId("edit_style");

      const workspaceDir = workspaceWithStyles([{ name: "analyze", content: styleJson(styleId, "draft") }]);
      const r = cliEnv(studioDir, { HARNESS_WORKSPACE: workspaceDir }, "library", "stage", "style-export");
      expect(r.code, r.err).toBe(0);

      const result = JSON.parse(readFileSync(join(workspaceDir, "stage-result.json"), "utf8"));
      expect(result.outcome).toBe("failed");
      expect(result.errors[0].kind).toBe("contract");
      expect(existsSync(join(root, "styles", styleId, "style.json"))).toBe(false);
    });
  });
});
