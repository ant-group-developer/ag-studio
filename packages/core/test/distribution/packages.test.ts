import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  ChannelConfigSchema, newId, type ChannelPackageDraft, type ContentItem, type Run,
} from "@harness/contracts";
import {
  buildUploadManifest, commitPackage, createDraftPackage, episodeDirName, findDraftForRun,
  manifestDigest, posixPath, youtubeLimitProblems, type LoadedChannel,
} from "../../src/index.js";
import { openTempStore } from "../helpers.js";

const now = "2026-09-14T00:00:00.000Z";
const sha = (c: string) => "sha256:" + c.repeat(64);

const CHANNEL_CONFIG = ChannelConfigSchema.parse({
  schema_version: "harness.channel-config/v1",
  channel_id: "channel-a",
  display_name: "Channel A",
  portfolio_id: "portfolio-main",
  repo_dir: "D:/legacy-channel-a",
  youtube: { expected_channel_id: "UCxxxxxxxxxxxxxxxxxxxxxx", account_email_ref: "secret://youtube/channel-a-email" },
  publication: { timezone: "America/New_York", publish_times: ["13:00"] },
  episode: { start: 15, dir_pattern: "episode-{nn}" },
});

function loadedChannel(overrides: Partial<LoadedChannel> = {}): LoadedChannel {
  return { config: CHANNEL_CONFIG, dir: "D:/legacy-channel-a", config_revision: sha("e"), ...overrides };
}

function sampleRun(): Run {
  return {
    schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-main", portfolio_id: "portfolio-main",
    workflow_release: { id: "channel-publish", version: "1.0.0", digest: sha("f") },
    profile_snapshot: { id: "channel", revision: 1 },
    content_id: newId("content_item"), variant_id: newId("content_variant"),
    options: {}, state: "RUNNING", effective_config_snapshot: {}, effective_config_digest: sha("a"),
    total_cost_usd: 0, created_at: now, updated_at: now,
  };
}

function sampleContent(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [],
    revision: 1, title: "Episode", created_at: now, library_item_id: newId("library_item"),
    library_channel_id: "channel-a", ...overrides,
  };
}

const SAMPLE_HYPOTHESIS = {
  schema_version: "harness.hypothesis/v1" as const, hypothesis_id: newId("hypothesis"),
  basis: [{ kind: "market" as const, note: "competitors post at 9am" }],
  chosen: { title: "Why This Works", thumbnail_candidate: "candidate-1.png", overlay_text: [], angle: "" },
  rejected: [{ title: "Alt Title", angle: "", why: "weaker hook" }],
  expected: { metric: "ctr" as const, target: 0.05, horizon_hours: 72 },
  status: "open" as const, created_at: now,
};

function sampleDraft(): ChannelPackageDraft {
  return {
    schema_version: "harness.channel-package-draft/v1",
    metadata: { title: "Episode 15", description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "en" },
    hypothesis: SAMPLE_HYPOTHESIS,
  };
}

describe("youtubeLimitProblems", () => {
  it("flags a title over 100 characters", () => {
    const m = { title: "x".repeat(101), description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "en" };
    expect(youtubeLimitProblems(m)).toEqual([{ field: "title", length: 101, max: 100 }]);
  });

  it("flags a tags_total over 500 characters", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag-${i}-`.repeat(4));
    const m = { title: "ok", description: "", tags, playlists: [], hashtags: [], pinned_comment: "", language: "en" };
    const problems = youtubeLimitProblems(m);
    const totalLen = tags.join(",").length;
    expect(totalLen).toBeGreaterThan(500);
    expect(problems).toContainEqual({ field: "tags_total", length: totalLen, max: 500 });
  });

  it("returns [] for metadata within limits", () => {
    const m = { title: "ok", description: "fine", tags: ["a", "b"], playlists: [], hashtags: [], pinned_comment: "", language: "en" };
    expect(youtubeLimitProblems(m)).toEqual([]);
  });
});

describe("buildUploadManifest", () => {
  it("returns the exact keys, in order, with visibility private", () => {
    const manifest = buildUploadManifest({
      metadata: { title: "T", description: "D", tags: ["a"], playlists: ["p"], hashtags: ["#x"], pinned_comment: "pc", language: "en" },
      videoPath: "episode-15/full-episode/episode-15-full-episode.mp4",
      thumbnailPath: "episode-15/thumbnails/a.png",
    });
    expect(Object.keys(manifest)).toEqual([
      "videoPath", "thumbnailPath", "visibility", "title", "description", "playlists", "tags", "pinnedComment", "hashtags",
    ]);
    expect(manifest.visibility).toBe("private");
    expect(manifest.title).toBe("T");
    expect(manifest.pinnedComment).toBe("pc");
  });
});

describe("manifestDigest", () => {
  it("is stable regardless of key order", () => {
    const a = manifestDigest({ title: "T", visibility: "private" });
    const b = manifestDigest({ visibility: "private", title: "T" });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("episodeDirName", () => {
  it("pads to at least two digits", () => {
    expect(episodeDirName("episode-{nn}", 7)).toBe("episode-07");
  });
  it("does not truncate numbers already 3+ digits", () => {
    expect(episodeDirName("episode-{nn}", 123)).toBe("episode-123");
  });
});

describe("createDraftPackage / findDraftForRun / commitPackage", () => {
  it("allocates increasing episode numbers per channel starting at episode.start", () => {
    const { store, clock } = openTempStore();
    const channel = loadedChannel();
    const repoEpisodesDir = "D:/legacy-channel-a/outputs/project-01/episodes";

    const run1 = sampleRun();
    const content1 = sampleContent({ content_id: run1.content_id });
    const pkg1 = createDraftPackage({ store, clock }, {
      channel, run: run1, content: content1, draft: sampleDraft(), variant_id: run1.variant_id!,
      video_artifact_id: newId("artifact"), thumbnail_artifact_id: newId("artifact"), repoEpisodesDir,
    });
    expect(pkg1.episode_no).toBe(15);
    expect(pkg1.episode_dir).toBe(posixPath(join(repoEpisodesDir, "episode-15")));
    expect(pkg1.status).toBe("draft");
    expect(pkg1.metadata_revision).toBe(1);
    expect(pkg1.channel_config_revision).toBe(channel.config_revision);
    expect(pkg1.video_checksum).toBe(sha("0"));
    expect(pkg1.thumbnail_checksum).toBe(sha("0"));
    expect(pkg1.manifest_digest).toBe(sha("0"));

    const run2 = sampleRun();
    const content2 = sampleContent({ content_id: run2.content_id });
    const pkg2 = createDraftPackage({ store, clock }, {
      channel, run: run2, content: content2, draft: sampleDraft(), variant_id: run2.variant_id!,
      video_artifact_id: newId("artifact"), thumbnail_artifact_id: newId("artifact"), repoEpisodesDir,
    });
    expect(pkg2.episode_no).toBe(16);

    expect(findDraftForRun(store, run1.run_id)?.package_id).toBe(pkg1.package_id);
    expect(findDraftForRun(store, newId("run"))).toBeUndefined();

    const committed = commitPackage({ store, clock }, {
      package_id: pkg1.package_id, video_checksum: sha("1"), thumbnail_checksum: sha("2"), manifest_digest: sha("3"),
    });
    expect(committed.status).toBe("committed");
    expect(committed.video_checksum).toBe(sha("1"));
    expect(committed.thumbnail_checksum).toBe(sha("2"));
    expect(committed.manifest_digest).toBe(sha("3"));
    expect(findDraftForRun(store, run1.run_id)).toBeUndefined();
    expect(store.getChannelPackage(pkg1.package_id)?.status).toBe("committed");
  });
});
