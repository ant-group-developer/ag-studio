import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { ChannelConfigSchema, ProductionProfileSchema, ProjectConfigSchema } from "../src/config.js";
import { ChannelPackageSchema, PublicationJobSchema } from "../src/entities.js";
import { ChannelPackageDraftSchema, HypothesisSchema } from "../src/distribution.js";

const MINIMAL_CHANNEL_CONFIG = {
  schema_version: "harness.channel-config/v1",
  channel_id: "channel-a",
  display_name: "Channel A",
  portfolio_id: "portfolio-main",
  repo_dir: "E:/channels/channel-a",
  youtube: { expected_channel_id: "UCxxxxxxxxxxxxxxxxxxxxxx", account_email_ref: "secret://youtube/channel-a-email" },
  publication: { timezone: "Asia/Ho_Chi_Minh", publish_times: ["09:00"] },
};

const SAMPLE_HYPOTHESIS = {
  schema_version: "harness.hypothesis/v1",
  hypothesis_id: newId("hypothesis"),
  basis: [{ kind: "market", note: "competitors post at 9am" }],
  chosen: { title: "Why This Works", thumbnail_candidate: "candidate-1.png" },
  rejected: [{ title: "Alt Title", why: "weaker hook" }],
  expected: { metric: "ctr", target: 0.05, horizon_hours: 72 },
  created_at: "2026-09-14T00:00:00.000Z",
};

describe("ChannelConfigSchema", () => {
  it("applies defaults for color, episode.start and overlay.enabled", () => {
    const parsed = ChannelConfigSchema.parse(MINIMAL_CHANNEL_CONFIG);
    expect(parsed.color).toBe("#5b8cff");
    expect(parsed.episode.start).toBe(1);
    expect(parsed.overlay.enabled).toBe(true);
    expect(parsed.legacy_project_id).toBe("project-01");
    expect(parsed.publication.visibility_default).toBe("private");
  });
  it("rejects an out-of-range publish time", () => {
    expect(ChannelConfigSchema.safeParse({
      ...MINIMAL_CHANNEL_CONFIG,
      publication: { ...MINIMAL_CHANNEL_CONFIG.publication, publish_times: ["25:00"] },
    }).success).toBe(false);
  });
  it("rejects a channel_id with an uppercase letter", () => {
    expect(ChannelConfigSchema.safeParse({ ...MINIMAL_CHANNEL_CONFIG, channel_id: "Bad_Id" }).success).toBe(false);
  });
});

describe("HypothesisSchema", () => {
  it("throws when rejected is missing", () => {
    const { rejected, ...withoutRejected } = SAMPLE_HYPOTHESIS;
    expect(HypothesisSchema.safeParse(withoutRejected).success).toBe(false);
  });
  it("throws when overlay_text has more than 3 lines", () => {
    expect(HypothesisSchema.safeParse({
      ...SAMPLE_HYPOTHESIS,
      chosen: { ...SAMPLE_HYPOTHESIS.chosen, overlay_text: ["a", "b", "c", "d"] },
    }).success).toBe(false);
  });
  it("defaults status to open", () => {
    expect(HypothesisSchema.parse(SAMPLE_HYPOTHESIS).status).toBe("open");
  });
});

describe("ChannelPackageDraftSchema", () => {
  it("parses a valid draft", () => {
    const parsed = ChannelPackageDraftSchema.parse({
      schema_version: "harness.channel-package-draft/v1",
      metadata: { title: "Episode 1" },
      hypothesis: SAMPLE_HYPOTHESIS,
    });
    expect(parsed.metadata.language).toBe("en");
    expect(parsed.hypothesis.status).toBe("open");
  });
});

describe("ProjectConfigSchema adapters/publication/dashboard blocks", () => {
  it("defaults adapters, publication and dashboard when absent from an old project.yaml", () => {
    const parsed = ProjectConfigSchema.parse({
      schema_version: "harness.project-config/v1", project_id: "project-main", template_release: "0.1.0", runtime: "claude",
      data_root: "E:/youtube-operations-data", portfolios: [{ portfolio_id: "portfolio-main", display_name: "Main" }],
    });
    expect(parsed.adapters.publisher).toBe("fake");
    expect(parsed.adapters.agent).toBe("fake");
    expect(parsed.dashboard.port).toBe(5200);
    expect(parsed.dashboard.refresh_seconds).toBe(60);
    expect(parsed.publication.verify_seconds).toBe(900);
    expect(parsed.publication.verify_grace_hours).toBe(2);
  });
});

describe("ProductionProfileSchema profile_id", () => {
  it("accepts the channel profile", () => {
    const parsed = ProductionProfileSchema.parse({
      schema_version: "harness.production-profile/v1", profile_id: "channel", revision: 1, status: "active",
      workflow_release: "channel-publish@1.0.0",
    });
    expect(parsed.profile_id).toBe("channel");
  });
});

describe("ChannelPackageSchema and PublicationJobSchema", () => {
  it("parses a full ChannelPackage sample", () => {
    const pkg = ChannelPackageSchema.parse({
      schema_version: "harness.channel-package/v1",
      package_id: newId("channel_package"),
      channel_id: "channel-a",
      variant_id: newId("content_variant"),
      content_id: newId("content_item"),
      library_item_id: newId("library_item"),
      run_id: newId("run"),
      episode_no: 1,
      episode_dir: "episode-01",
      manifest_digest: "sha256:" + "a".repeat(64),
      video_artifact_id: newId("artifact"),
      thumbnail_artifact_id: newId("artifact"),
      video_checksum: "sha256:" + "b".repeat(64),
      thumbnail_checksum: "sha256:" + "c".repeat(64),
      metadata: { title: "Episode 1" },
      hypothesis: SAMPLE_HYPOTHESIS,
      metadata_revision: 1,
      channel_config_revision: 1,
      status: "draft",
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-14T00:00:00.000Z",
    });
    expect(pkg.status).toBe("draft");
  });

  it("parses a full PublicationJob sample", () => {
    const job = PublicationJobSchema.parse({
      schema_version: "harness.publication-job/v1",
      publication_job_id: newId("publication_job"),
      package_id: newId("channel_package"),
      channel_id: "channel-a",
      library_item_id: newId("library_item"),
      run_id: newId("run"),
      idempotency_key: "sha256:" + "a".repeat(64),
      state: "DRAFT",
      youtube_video_id: null,
      operation_id: null,
      scheduled_at: null,
      published_at: null,
      last_verified_at: null,
      note: null,
      receipt: null,
      created_at: "2026-09-14T00:00:00.000Z",
      updated_at: "2026-09-14T00:00:00.000Z",
    });
    expect(job.state).toBe("DRAFT");
  });
});
