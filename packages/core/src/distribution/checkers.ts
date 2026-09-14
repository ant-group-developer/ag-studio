import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ChannelPackageDraftSchema, PackageReceiptSchema, type Checker, type SecretResolver, type StateStore } from "@harness/contracts";
import { sha256File } from "../artifacts/checksum.js";
import type { ChannelRegistry } from "./channels.js";
import { manifestDigest, youtubeLimitProblems } from "./packages.js";

const skip = (reason: string) => ({ verdict: "skip" as const, evidence: { reason } });

/**
 * `upload-manifest.json`'s `videoPath`/`thumbnailPath` are absolute, forward-slash paths per the design spec
 * (§3: "videoPath, thumbnailPath tuyệt đối gạch xuôi") — the legacy Playwright uploader reads them as-is. Only
 * fall back to resolving relative to `episode_dir` for a path that genuinely isn't absolute (e.g. a fixture);
 * `path.join(episode_dir, absolutePath)` would otherwise concatenate the two into a broken doubled path.
 */
function resolveManifestPath(episodeDir: string, p: string): string {
  return isAbsolute(p) ? p : join(episodeDir, p);
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface DistributionCheckerDeps { store: StateStore; channels: ChannelRegistry; secrets: SecretResolver }

/**
 * Distribution checkers layered on top of BUILTIN_CHECKERS (spec §3.2/§4.1 of sub-project 3):
 *
 * `youtube-limits` and `hypothesis-complete` both validate the `channel_package_draft` output written by the
 * build-package stage (the metadata/hypothesis draft, before checksums exist). `package-integrity` and
 * `channel-identity` both validate the `channel_package` output (the `PackageReceiptSchema` receipt written
 * once the package is committed). `duplicate-upload` also reads a `channel_package` receipt, but checks the
 * control-plane store instead of the filesystem.
 */
export function distributionCheckers(d: DistributionCheckerDeps): Checker[] {
  const youtubeLimits: Checker = {
    id: "youtube-limits",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.type === "channel_package_draft");
      if (outputs.length === 0) return skip("no matching output");
      for (const o of outputs) {
        const path = join(input.workspaceDir, o.path);
        const json = readJson(path);
        if (!json.ok) return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: json.reason } };
        const parsed = ChannelPackageDraftSchema.safeParse(json.value);
        if (!parsed.success) {
          return { verdict: "fail", evidence: { path: o.path, reason: "invalid draft", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        const problems = youtubeLimitProblems(parsed.data.metadata);
        if (problems.length > 0) return { verdict: "fail", evidence: { path: o.path, problems } };
      }
      return { verdict: "pass", evidence: {} };
    },
  };

  const hypothesisComplete: Checker = {
    id: "hypothesis-complete",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.type === "channel_package_draft");
      if (outputs.length === 0) return skip("no matching output");
      const thumbInput = input.request.inputs.find((i) => i.type === "thumbnail_set");
      for (const o of outputs) {
        const path = join(input.workspaceDir, o.path);
        const json = readJson(path);
        if (!json.ok) return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: json.reason } };
        const parsed = ChannelPackageDraftSchema.safeParse(json.value);
        if (!parsed.success) {
          return { verdict: "fail", evidence: { path: o.path, reason: "invalid draft", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        const draft = parsed.data;
        if (draft.hypothesis.expected.target <= 0) {
          return { verdict: "fail", evidence: { path: o.path, reason: "expected.target must be > 0", target: draft.hypothesis.expected.target } };
        }
        if (!thumbInput) return { verdict: "fail", evidence: { path: o.path, reason: "no thumbnail_set input" } };
        const thumbDir = join(input.workspaceDir, thumbInput.path);
        let files: string[];
        try {
          files = readdirSync(thumbDir);
        } catch (e) {
          return { verdict: "fail", evidence: { path: thumbInput.path, reason: "unreadable thumbnail_set", error: e instanceof Error ? e.message : String(e) } };
        }
        const candidate = draft.hypothesis.chosen.thumbnail_candidate;
        if (!files.includes(candidate)) {
          return { verdict: "fail", evidence: { path: o.path, reason: "thumbnail_candidate not found in thumbnail_set", candidate, files } };
        }
      }
      return { verdict: "pass", evidence: {} };
    },
  };

  const packageIntegrity: Checker = {
    id: "package-integrity",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.type === "channel_package");
      if (outputs.length === 0) return skip("no matching output");
      for (const o of outputs) {
        const path = join(input.workspaceDir, o.path);
        const json = readJson(path);
        if (!json.ok) return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: json.reason } };
        const parsed = PackageReceiptSchema.safeParse(json.value);
        if (!parsed.success) {
          return { verdict: "fail", evidence: { path: o.path, reason: "invalid receipt", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        const receipt = parsed.data;
        const manifestPath = join(receipt.episode_dir, receipt.manifest_path);
        const manifestJson = readJson(manifestPath);
        if (!manifestJson.ok) return { verdict: "fail", evidence: { path: manifestPath, reason: "manifest unreadable", error: manifestJson.reason } };
        if (manifestDigest(manifestJson.value) !== receipt.manifest_digest) {
          return { verdict: "fail", evidence: { path: manifestPath, reason: "manifest digest mismatch" } };
        }
        const manifest = manifestJson.value as { videoPath?: unknown; thumbnailPath?: unknown };
        if (typeof manifest.videoPath !== "string" || typeof manifest.thumbnailPath !== "string") {
          return { verdict: "fail", evidence: { path: manifestPath, reason: "manifest missing videoPath/thumbnailPath" } };
        }
        const videoPath = resolveManifestPath(receipt.episode_dir, manifest.videoPath);
        if (!existsSync(videoPath)) return { verdict: "fail", evidence: { path: videoPath, reason: "missing video" } };
        const actualVideo = await sha256File(videoPath);
        if (actualVideo.checksum !== receipt.video_checksum) {
          return { verdict: "fail", evidence: { path: videoPath, reason: "video checksum mismatch", declared: receipt.video_checksum, actual: actualVideo.checksum } };
        }
        const thumbnailPath = resolveManifestPath(receipt.episode_dir, manifest.thumbnailPath);
        if (!existsSync(thumbnailPath)) return { verdict: "fail", evidence: { path: thumbnailPath, reason: "missing thumbnail" } };
        const actualThumbnail = await sha256File(thumbnailPath);
        if (actualThumbnail.checksum !== receipt.thumbnail_checksum) {
          return { verdict: "fail", evidence: { path: thumbnailPath, reason: "thumbnail checksum mismatch", declared: receipt.thumbnail_checksum, actual: actualThumbnail.checksum } };
        }
      }
      return { verdict: "pass", evidence: {} };
    },
  };

  const channelIdentity: Checker = {
    id: "channel-identity",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.type === "channel_package");
      if (outputs.length === 0) return skip("no matching output");
      for (const o of outputs) {
        const path = join(input.workspaceDir, o.path);
        const json = readJson(path);
        if (!json.ok) return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: json.reason } };
        const parsed = PackageReceiptSchema.safeParse(json.value);
        if (!parsed.success) {
          return { verdict: "fail", evidence: { path: o.path, reason: "invalid receipt", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        const receipt = parsed.data;
        const channel = d.channels.get(receipt.channel_id);
        const configPath = join(resolve(channel.config.repo_dir), "channel.config.json");
        const configJson = readJson(configPath);
        if (!configJson.ok) return { verdict: "fail", evidence: { path: configPath, reason: "channel.config.json unreadable", error: configJson.reason } };
        const config = configJson.value as { projectId?: unknown; youtube?: { channelId?: unknown; accountEmail?: unknown } };
        if (config.youtube?.channelId !== channel.config.youtube.expected_channel_id) {
          return { verdict: "fail", evidence: { path: configPath, reason: "channelId mismatch", expected: channel.config.youtube.expected_channel_id, actual: config.youtube?.channelId ?? null } };
        }
        if (config.projectId !== channel.config.legacy_project_id) {
          return { verdict: "fail", evidence: { path: configPath, reason: "projectId mismatch", expected: channel.config.legacy_project_id, actual: config.projectId ?? null } };
        }
        let expectedEmail: string;
        try {
          expectedEmail = d.secrets.resolve(channel.config.youtube.account_email_ref);
        } catch (e) {
          return { verdict: "fail", evidence: { reason: "secret unresolved", ref: channel.config.youtube.account_email_ref, error: e instanceof Error ? e.message : String(e) } };
        }
        if (config.youtube?.accountEmail !== expectedEmail) {
          return { verdict: "fail", evidence: { path: configPath, reason: "accountEmail mismatch" } };
        }
      }
      return { verdict: "pass", evidence: {} };
    },
  };

  const duplicateUpload: Checker = {
    id: "duplicate-upload",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.type === "channel_package");
      if (outputs.length === 0) return skip("no matching output");
      for (const o of outputs) {
        const path = join(input.workspaceDir, o.path);
        const json = readJson(path);
        if (!json.ok) return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: json.reason } };
        const parsed = PackageReceiptSchema.safeParse(json.value);
        if (!parsed.success) {
          return { verdict: "fail", evidence: { path: o.path, reason: "invalid receipt", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        const receipt = parsed.data;
        const job = d.store.getPublicationJob(receipt.publication_job_id);
        if (!job) return { verdict: "fail", evidence: { reason: "publication job not found", publication_job_id: receipt.publication_job_id } };

        const sameKey = d.store.listPublicationJobs({ idempotency_key: job.idempotency_key })
          .filter((j) => j.publication_job_id !== receipt.publication_job_id && j.state !== "FAILED");
        if (sameKey.length > 0) {
          return { verdict: "fail", evidence: { reason: "another non-FAILED job shares this idempotency_key", jobs: sameKey.map((j) => j.publication_job_id) } };
        }

        const active = new Set(["PROCESSING", "SCHEDULED", "PUBLISHED"]);
        const sameTarget = d.store.listPublicationJobs({ library_item_id: job.library_item_id, channel_id: job.channel_id })
          .filter((j) => j.publication_job_id !== receipt.publication_job_id && active.has(j.state));
        if (sameTarget.length > 0) {
          return { verdict: "fail", evidence: { reason: "another active job already targets this library_item_id + channel_id", jobs: sameTarget.map((j) => j.publication_job_id) } };
        }
      }
      return { verdict: "pass", evidence: {} };
    },
  };

  return [youtubeLimits, hypothesisComplete, packageIntegrity, channelIdentity, duplicateUpload];
}
