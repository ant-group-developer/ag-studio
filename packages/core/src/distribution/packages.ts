import { join } from "node:path";
import {
  HarnessError, newId,
  type Checksum, type ChannelPackage, type ChannelPackageDraft, type Clock, type ContentItem,
  type Hypothesis, type PackageMetadata, type Run, type StateStore,
} from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";
import { posixPath, type LoadedChannel } from "./channels.js";

/** Copied from the legacy channel repo's `scripts/lib/youtube-limits.mjs`. */
export const YOUTUBE_LIMITS = { title: 100, description: 5000, tags_total: 500, tag: 100, playlist: 150, tags_count: 500 } as const;

export interface LimitProblem { field: string; length: number; max: number }

/** `tags_total` is `tags.join(",").length`, matching how the legacy upload script joins tags for the API call. */
export function youtubeLimitProblems(m: PackageMetadata): LimitProblem[] {
  const problems: LimitProblem[] = [];
  if (m.title.length > YOUTUBE_LIMITS.title) problems.push({ field: "title", length: m.title.length, max: YOUTUBE_LIMITS.title });
  if (m.description.length > YOUTUBE_LIMITS.description) problems.push({ field: "description", length: m.description.length, max: YOUTUBE_LIMITS.description });
  if (m.tags.length > YOUTUBE_LIMITS.tags_count) problems.push({ field: "tags_count", length: m.tags.length, max: YOUTUBE_LIMITS.tags_count });
  const tagsTotal = m.tags.join(",").length;
  if (tagsTotal > YOUTUBE_LIMITS.tags_total) problems.push({ field: "tags_total", length: tagsTotal, max: YOUTUBE_LIMITS.tags_total });
  m.tags.forEach((tag, i) => {
    if (tag.length > YOUTUBE_LIMITS.tag) problems.push({ field: `tags[${i}]`, length: tag.length, max: YOUTUBE_LIMITS.tag });
  });
  m.playlists.forEach((playlist, i) => {
    if (playlist.length > YOUTUBE_LIMITS.playlist) problems.push({ field: `playlists[${i}]`, length: playlist.length, max: YOUTUBE_LIMITS.playlist });
  });
  return problems;
}

/** Matches the shape of the legacy repo's `templates/upload-manifest.template.json`. */
export function buildUploadManifest(p: { metadata: PackageMetadata; videoPath: string; thumbnailPath: string }): {
  videoPath: string; thumbnailPath: string; visibility: "private"; title: string; description: string;
  playlists: string[]; tags: string[]; pinnedComment: string; hashtags: string[];
} {
  return {
    videoPath: posixPath(p.videoPath),
    thumbnailPath: posixPath(p.thumbnailPath),
    visibility: "private",
    title: p.metadata.title,
    description: p.metadata.description,
    playlists: p.metadata.playlists,
    tags: p.metadata.tags,
    pinnedComment: p.metadata.pinned_comment,
    hashtags: p.metadata.hashtags,
  };
}

export function manifestDigest(manifest: unknown): Checksum {
  return canonicalDigest(manifest);
}

/** `{nn}` becomes the episode number, zero-padded to at least two digits (never truncated). */
export function episodeDirName(pattern: string, episodeNo: number): string {
  return pattern.replace("{nn}", String(episodeNo).padStart(2, "0"));
}

export interface PackageDeps { store: StateStore; clock: Clock }

const PLACEHOLDER_CHECKSUM: Checksum = "sha256:" + "0".repeat(64);

/**
 * One transaction: allocates the channel's next episode number, then inserts a `draft` `ChannelPackage`
 * with placeholder checksums (real checksums land later, at `commitPackage`).
 */
export function createDraftPackage(d: PackageDeps, p: {
  channel: LoadedChannel; run: Run; content: ContentItem; draft: ChannelPackageDraft;
  variant_id: string; video_artifact_id: string; thumbnail_artifact_id: string; repoEpisodesDir: string;
}): ChannelPackage {
  const libraryItemId = p.content.library_item_id;
  if (!libraryItemId) {
    throw new HarnessError("CONFIG_INVALID", `content ${p.content.content_id} has no library_item_id`, { content_id: p.content.content_id });
  }
  return d.store.transaction(() => {
    const channelId = p.channel.config.channel_id;
    const episodeNo = d.store.allocateEpisodeNo(channelId, p.channel.config.episode.start);
    const episodeDir = posixPath(join(p.repoEpisodesDir, episodeDirName(p.channel.config.episode.dir_pattern, episodeNo)));
    const now = d.clock.now();
    const pkg: ChannelPackage = {
      schema_version: "harness.channel-package/v1",
      package_id: newId("channel_package"),
      channel_id: channelId,
      variant_id: p.variant_id,
      content_id: p.content.content_id,
      library_item_id: libraryItemId,
      run_id: p.run.run_id,
      episode_no: episodeNo,
      episode_dir: episodeDir,
      manifest_digest: PLACEHOLDER_CHECKSUM,
      video_artifact_id: p.video_artifact_id,
      thumbnail_artifact_id: p.thumbnail_artifact_id,
      video_checksum: PLACEHOLDER_CHECKSUM,
      thumbnail_checksum: PLACEHOLDER_CHECKSUM,
      metadata: p.draft.metadata,
      hypothesis: p.draft.hypothesis,
      metadata_revision: 1,
      channel_config_revision: p.channel.config_revision,
      status: "draft",
      created_at: now,
      updated_at: now,
    };
    d.store.insertChannelPackage(pkg);
    return pkg;
  });
}

export function findDraftForRun(store: StateStore, runId: string): ChannelPackage | undefined {
  return store.listChannelPackages({ run_id: runId, status: "draft" })[0];
}

/**
 * `draft` → `committed`, with the real checksums computed once the video/thumbnail/manifest exist on disk.
 *
 * `metadata`/`hypothesis` come from the draft the caller actually built this manifest from, not from the row:
 * a `build-package` rerun reuses the existing `ChannelPackage` of the run (same `package_id`, same episode
 * number) but may be working from a *newer* `channel_package_draft` — writing only the checksums would leave
 * the row (and therefore `publish show`, `channel hypotheses`, the dashboard) describing the previous draft
 * while the manifest on disk and the upload itself carry the new one.
 */
export function commitPackage(d: PackageDeps, p: {
  package_id: string; video_checksum: Checksum; thumbnail_checksum: Checksum; manifest_digest: Checksum;
  metadata: PackageMetadata; hypothesis: Hypothesis;
}): ChannelPackage {
  return d.store.transaction(() => {
    const existing = d.store.getChannelPackage(p.package_id);
    if (!existing) throw new HarnessError("NOT_FOUND", `channel package not found: ${p.package_id}`, { package_id: p.package_id });
    const metadataChanged = canonicalDigest(p.metadata) !== canonicalDigest(existing.metadata);
    const updated: ChannelPackage = {
      ...existing,
      metadata: p.metadata,
      hypothesis: p.hypothesis,
      metadata_revision: metadataChanged ? existing.metadata_revision + 1 : existing.metadata_revision,
      video_checksum: p.video_checksum,
      thumbnail_checksum: p.thumbnail_checksum,
      manifest_digest: p.manifest_digest,
      status: "committed",
      updated_at: d.clock.now(),
    };
    d.store.updateChannelPackage(updated);
    return updated;
  });
}
