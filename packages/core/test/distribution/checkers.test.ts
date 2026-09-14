import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelConfigSchema, newId, type Checker, type CheckerInput, type ChannelPackageDraft,
  type PackageReceipt, type PublicationJob, type SecretResolver, type StageRequest, type StageResult,
} from "@harness/contracts";
import { ChannelRegistry, distributionCheckers, EnvSecretResolver, manifestDigest, posixPath, sha256File, type LoadedChannel } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

const sha = "sha256:" + "a".repeat(64);

function baseRequest(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    schema_version: "harness.stage-request/v1", run_id: newId("run"), stage_run_id: newId("stage_run"), attempt_id: newId("attempt"),
    project_id: "p", portfolio_id: "pf", stage_key: "build-package",
    workflow: { id: "channel-publish", version: "1.0.0", digest: sha }, profile_snapshot: { id: "channel", revision: 1 },
    inputs: [], workspace_uri: "", stage_config: {}, options: {}, source_items: [], resources: [], expected_outputs: [],
    policy: {}, limits: { deadline_at: "2026-09-14T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 }, capabilities: [], fencing_token: 1,
    ...overrides,
  };
}

function baseResult(outputs: StageResult["outputs"]): StageResult {
  return {
    schema_version: "harness.stage-result/v1", attempt_id: newId("attempt"), outcome: "succeeded", outputs,
    checks: [], usage: { wall_seconds: 1, cost_usd: 0 }, external_operations: [], errors: [],
  };
}

function checkerById(checkers: Checker[], id: string): Checker {
  const c = checkers.find((c) => c.id === id);
  if (!c) throw new Error(`no checker ${id}`);
  return c;
}

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "distribution-checkers-ws-"));
}

const SAMPLE_HYPOTHESIS = {
  schema_version: "harness.hypothesis/v1" as const, hypothesis_id: newId("hypothesis"),
  basis: [{ kind: "market" as const, note: "competitors post at 9am" }],
  chosen: { title: "Why This Works", thumbnail_candidate: "thumb-01.png", overlay_text: [], angle: "" },
  rejected: [{ title: "Alt Title", angle: "", why: "weaker hook" }],
  expected: { metric: "ctr" as const, target: 0.05, horizon_hours: 72 },
  status: "open" as const, created_at: "2026-09-14T00:00:00.000Z",
};

function sampleDraft(overrides: Partial<ChannelPackageDraft["metadata"]> = {}): ChannelPackageDraft {
  return {
    schema_version: "harness.channel-package-draft/v1",
    metadata: { title: "Episode 15", description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "en", ...overrides },
    hypothesis: SAMPLE_HYPOTHESIS,
  };
}

class StubSecretResolver implements SecretResolver {
  constructor(private readonly values: Record<string, string>) {}
  resolve(ref: string): string {
    const v = this.values[ref];
    if (v === undefined) throw new Error(`cannot resolve ${ref}`);
    return v;
  }
  resolvedValues(): string[] { return Object.values(this.values); }
}

function noopChannels(): ChannelRegistry { return new ChannelRegistry([]); }

describe("distributionCheckers", () => {
  describe("youtube-limits", () => {
    function fixture(ws: string, draft: ChannelPackageDraft) {
      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "output", "package.json"), JSON.stringify(draft));
      const request = baseRequest();
      const result = baseResult([{ path: "output/package.json", type: "channel_package_draft", checksum: sha, size_bytes: 1, kind: "file" }]);
      return { request, result };
    }

    it("passes when metadata is within youtube limits", async () => {
      const ws = tmpWorkspace();
      const { request, result } = fixture(ws, sampleDraft());
      const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "youtube-limits");
      expect(await checker.check({ request, result, workspaceDir: ws } satisfies CheckerInput)).toEqual({ verdict: "pass", evidence: {} });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails when the title is over 100 characters", async () => {
      const ws = tmpWorkspace();
      const { request, result } = fixture(ws, sampleDraft({ title: "x".repeat(120) }));
      const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "youtube-limits");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.problems).toEqual([{ field: "title", length: 120, max: 100 }]);
      rmSync(ws, { recursive: true, force: true });
    });

    it("skips when there is no channel_package_draft output", async () => {
      const ws = tmpWorkspace();
      const request = baseRequest();
      const result = baseResult([]);
      const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "youtube-limits");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "skip", evidence: { reason: "no matching output" } });
      rmSync(ws, { recursive: true, force: true });
    });
  });

  describe("hypothesis-complete", () => {
    function fixture(ws: string, draft: ChannelPackageDraft) {
      mkdirSync(join(ws, "output"), { recursive: true });
      mkdirSync(join(ws, "input", "thumbnails"), { recursive: true });
      writeFileSync(join(ws, "input", "thumbnails", "thumb-01.png"), "png-bytes");
      writeFileSync(join(ws, "output", "package.json"), JSON.stringify(draft));
      const request = baseRequest({ inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "input/thumbnails", type: "thumbnail_set", kind: "directory" }] });
      const result = baseResult([{ path: "output/package.json", type: "channel_package_draft", checksum: sha, size_bytes: 1, kind: "file" }]);
      return { request, result };
    }

    it("passes when the chosen thumbnail candidate exists in the thumbnail_set input", async () => {
      const ws = tmpWorkspace();
      const { request, result } = fixture(ws, sampleDraft());
      const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "hypothesis-complete");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "pass", evidence: {} });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails when the chosen thumbnail candidate is not a file in the thumbnail_set input", async () => {
      const ws = tmpWorkspace();
      const draft = sampleDraft();
      draft.hypothesis.chosen.thumbnail_candidate = "nope.png";
      const { request, result } = fixture(ws, draft);
      const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "hypothesis-complete");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.candidate).toBe("nope.png");
      rmSync(ws, { recursive: true, force: true });
    });
  });

  describe("package-integrity", () => {
    async function fixture() {
      const episodeDir = mkdtempSync(join(tmpdir(), "distribution-checkers-episode-"));
      writeFileSync(join(episodeDir, "video.mp4"), "video-bytes");
      writeFileSync(join(episodeDir, "thumb.png"), "thumb-bytes");
      const videoChecksum = (await sha256File(join(episodeDir, "video.mp4"))).checksum;
      const thumbnailChecksum = (await sha256File(join(episodeDir, "thumb.png"))).checksum;
      const manifest = { videoPath: "video.mp4", thumbnailPath: "thumb.png", visibility: "private", title: "T" };
      writeFileSync(join(episodeDir, "upload-manifest.json"), JSON.stringify(manifest));
      const receipt: PackageReceipt = {
        schema_version: "harness.package-receipt/v1", package_id: newId("channel_package"), publication_job_id: newId("publication_job"),
        channel_id: "channel-a", episode_no: 1, episode_dir: episodeDir, manifest_path: "upload-manifest.json",
        video_checksum: videoChecksum, thumbnail_checksum: thumbnailChecksum, manifest_digest: manifestDigest(manifest),
      };
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "output", "receipt.json"), JSON.stringify(receipt));
      const request = baseRequest();
      const result = baseResult([{ path: "output/receipt.json", type: "channel_package", checksum: sha, size_bytes: 1, kind: "file" }]);
      return { episodeDir, ws, request, result, receipt };
    }

    it("passes when the video and thumbnail on disk match the receipt's checksums", async () => {
      const { episodeDir, ws, request, result } = await fixture();
      const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "package-integrity");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "pass", evidence: {} });
      rmSync(episodeDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    });

    it("passes when the manifest's videoPath/thumbnailPath are absolute forward-slash paths (the real legacy format)", async () => {
      // Design spec §3: upload-manifest.json's videoPath/thumbnailPath are written as absolute,
      // forward-slash paths (the legacy Playwright uploader reads them as-is) — not relative to episode_dir.
      const episodeDir = mkdtempSync(join(tmpdir(), "distribution-checkers-episode-"));
      writeFileSync(join(episodeDir, "video.mp4"), "video-bytes");
      writeFileSync(join(episodeDir, "thumb.png"), "thumb-bytes");
      const videoChecksum = (await sha256File(join(episodeDir, "video.mp4"))).checksum;
      const thumbnailChecksum = (await sha256File(join(episodeDir, "thumb.png"))).checksum;
      const manifest = {
        videoPath: posixPath(join(episodeDir, "video.mp4")),
        thumbnailPath: posixPath(join(episodeDir, "thumb.png")),
        visibility: "private", title: "T",
      };
      writeFileSync(join(episodeDir, "upload-manifest.json"), JSON.stringify(manifest));
      const receipt: PackageReceipt = {
        schema_version: "harness.package-receipt/v1", package_id: newId("channel_package"), publication_job_id: newId("publication_job"),
        channel_id: "channel-a", episode_no: 1, episode_dir: episodeDir, manifest_path: "upload-manifest.json",
        video_checksum: videoChecksum, thumbnail_checksum: thumbnailChecksum, manifest_digest: manifestDigest(manifest),
      };
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "output", "receipt.json"), JSON.stringify(receipt));
      const request = baseRequest();
      const result = baseResult([{ path: "output/receipt.json", type: "channel_package", checksum: sha, size_bytes: 1, kind: "file" }]);
      const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "package-integrity");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "pass", evidence: {} });
      rmSync(episodeDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails and names the videoPath when the video file was altered after the receipt was written", async () => {
      const { episodeDir, ws, request, result } = await fixture();
      const videoPath = join(episodeDir, "video.mp4");
      writeFileSync(videoPath, "tampered-bytes");
      const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "package-integrity");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.path).toBe(videoPath);
      rmSync(episodeDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    });
  });

  describe("channel-identity", () => {
    async function fixture(configOverrides: Record<string, unknown> = {}) {
      const repoDir = mkdtempSync(join(tmpdir(), "distribution-checkers-repo-"));
      writeFileSync(join(repoDir, "channel.config.json"), JSON.stringify({
        projectId: "project-01", youtube: { channelId: "UCfake000000000000000001", accountEmail: "owner@example.com" }, ...configOverrides,
      }));
      const channelConfig = ChannelConfigSchema.parse({
        schema_version: "harness.channel-config/v1", channel_id: "channel-a", display_name: "Channel A", portfolio_id: "portfolio-main",
        repo_dir: repoDir, legacy_project_id: "project-01",
        youtube: { expected_channel_id: "UCfake000000000000000001", account_email_ref: "secret://youtube-c1/email" },
        publication: { timezone: "America/New_York", publish_times: ["13:00"] },
      });
      const loaded: LoadedChannel = { config: channelConfig, dir: repoDir, config_revision: sha };
      const channels = new ChannelRegistry([loaded]);
      const receipt: PackageReceipt = {
        schema_version: "harness.package-receipt/v1", package_id: newId("channel_package"), publication_job_id: newId("publication_job"),
        channel_id: "channel-a", episode_no: 1, episode_dir: repoDir, manifest_path: "upload-manifest.json",
        video_checksum: sha, thumbnail_checksum: sha, manifest_digest: sha,
      };
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "output", "receipt.json"), JSON.stringify(receipt));
      const request = baseRequest();
      const result = baseResult([{ path: "output/receipt.json", type: "channel_package", checksum: sha, size_bytes: 1, kind: "file" }]);
      return { repoDir, ws, request, result, channels };
    }

    it("passes when channel.config.json matches expected_channel_id, legacy_project_id and the resolved secret email", async () => {
      const { repoDir, ws, request, result, channels } = await fixture();
      process.env.HARNESS_SECRET_YOUTUBE_C1_EMAIL = "owner@example.com";
      try {
        const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels, secrets: new EnvSecretResolver() }), "channel-identity");
        expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "pass", evidence: {} });
      } finally {
        delete process.env.HARNESS_SECRET_YOUTUBE_C1_EMAIL;
      }
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails when channel.config.json's youtube.channelId does not match expected_channel_id", async () => {
      const { repoDir, ws, request, result, channels } = await fixture({ youtube: { channelId: "UCwrongwrongwrongwrongwr0", accountEmail: "owner@example.com" } });
      process.env.HARNESS_SECRET_YOUTUBE_C1_EMAIL = "owner@example.com";
      try {
        const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels, secrets: new EnvSecretResolver() }), "channel-identity");
        const outcome = await checker.check({ request, result, workspaceDir: ws });
        expect(outcome.verdict).toBe("fail");
      } finally {
        delete process.env.HARNESS_SECRET_YOUTUBE_C1_EMAIL;
      }
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails when channel.config.json's youtube.accountEmail does not match the resolved secret", async () => {
      const { repoDir, ws, request, result, channels } = await fixture({ youtube: { channelId: "UCfake000000000000000001", accountEmail: "someone-else@example.com" } });
      process.env.HARNESS_SECRET_YOUTUBE_C1_EMAIL = "owner@example.com";
      try {
        const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels, secrets: new EnvSecretResolver() }), "channel-identity");
        const outcome = await checker.check({ request, result, workspaceDir: ws });
        expect(outcome.verdict).toBe("fail");
      } finally {
        delete process.env.HARNESS_SECRET_YOUTUBE_C1_EMAIL;
      }
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails with 'secret unresolved' when the account_email_ref cannot be resolved", async () => {
      const { repoDir, ws, request, result, channels } = await fixture();
      delete process.env.HARNESS_SECRET_YOUTUBE_C1_EMAIL;
      const checker = checkerById(distributionCheckers({ store: openTempStore().store, channels, secrets: new EnvSecretResolver() }), "channel-identity");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.reason).toBe("secret unresolved");
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    });
  });

  describe("duplicate-upload", () => {
    function samplePkgReceipt(overrides: Partial<PackageReceipt> = {}): PackageReceipt {
      return {
        schema_version: "harness.package-receipt/v1", package_id: newId("channel_package"), publication_job_id: newId("publication_job"),
        channel_id: "channel-a", episode_no: 1, episode_dir: "D:/legacy/episode-1", manifest_path: "upload-manifest.json",
        video_checksum: sha, thumbnail_checksum: sha, manifest_digest: sha, ...overrides,
      };
    }

    function samplePublicationJob(overrides: Partial<PublicationJob> = {}): PublicationJob {
      const now = "2026-09-14T00:00:00.000Z";
      return {
        schema_version: "harness.publication-job/v1", publication_job_id: newId("publication_job"), package_id: newId("channel_package"),
        channel_id: "channel-a", library_item_id: newId("library_item"), run_id: newId("run"),
        idempotency_key: sha, state: "READY", youtube_video_id: null, operation_id: null, scheduled_at: null,
        published_at: null, last_verified_at: null, note: null, receipt: null, created_at: now, updated_at: now,
        ...overrides,
      };
    }

    async function fixture(secondJobOverrides: Partial<PublicationJob>) {
      const { store } = openTempStore();
      const libraryItemId = newId("library_item");
      const job = samplePublicationJob({ library_item_id: libraryItemId, channel_id: "channel-a", idempotency_key: sha, state: "PROCESSING" });
      store.insertPublicationJob(job);
      const other = samplePublicationJob({ library_item_id: libraryItemId, channel_id: "channel-a", idempotency_key: "sha256:" + "b".repeat(64), ...secondJobOverrides });
      store.insertPublicationJob(other);
      const receipt = samplePkgReceipt({ publication_job_id: job.publication_job_id, channel_id: "channel-a" });
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "output", "receipt.json"), JSON.stringify(receipt));
      const request = baseRequest();
      const result = baseResult([{ path: "output/receipt.json", type: "channel_package", checksum: sha, size_bytes: 1, kind: "file" }]);
      return { store, ws, request, result };
    }

    it("passes when no other job targets the same idempotency_key or library_item_id + channel_id", async () => {
      const { store, ws, request, result } = await fixture({ state: "FAILED" });
      const checker = checkerById(distributionCheckers({ store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "duplicate-upload");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "pass", evidence: {} });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails when a second job is PROCESSING for the same library_item_id + channel_id", async () => {
      const { store, ws, request, result } = await fixture({ state: "PROCESSING" });
      const checker = checkerById(distributionCheckers({ store, channels: noopChannels(), secrets: new StubSecretResolver({}) }), "duplicate-upload");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      rmSync(ws, { recursive: true, force: true });
    });
  });
});
