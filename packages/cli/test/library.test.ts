import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** Writes a schema-valid, `active` EditStyle straight into the kho, as `style-export` would have. */
function writeStyleFile(root: string, styleId: string): void {
  const dir = join(root, "styles", styleId);
  mkdirSync(dir, { recursive: true });
  const style = {
    schema_version: "harness.edit-style/v1", style_id: styleId, revision: 1, name: "Test style", status: "active",
    learned_from: [],
    params: {
      cut_rhythm: "medium", shot_seconds: [2, 5], transitions: [], text_overlay: { style: "bold", density: "low" },
      subtitles: "burn-in", music: { mood: "upbeat", ducking: true }, opening: { seconds: 3, structure: "hook" }, aspect_ratio: "16:9", pace_notes: "",
    },
    evidence: [], created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  };
  writeFileSync(join(dir, "style.json"), JSON.stringify(style, null, 2) + "\n");
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

  it("doctor reports the three library:* rows for a project with a library root", () => {
    const root = mkdtempSync(join(tmpdir(), "kho-doctor-"));
    mkdirSync(join(root, "styles"), { recursive: true });
    const p = libraryProject(root, "studio", "doctor");
    expect(cli(p, "db", "migrate").code).toBe(0);
    const d = cli(p, "doctor", "--json");
    expect(d.code, d.err).toBe(0);
    const rows: { check: string; ok: boolean }[] = JSON.parse(d.out);
    const byCheck = new Map(rows.map((r) => [r.check, r]));
    expect(byCheck.get("library:root")).toMatchObject({ ok: true });
    expect(byCheck.get("library:write")).toMatchObject({ ok: true });
    expect(byCheck.get("library:index")).toMatchObject({ ok: true });
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
  });
});
