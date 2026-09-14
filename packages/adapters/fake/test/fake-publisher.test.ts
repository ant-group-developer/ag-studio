import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublisherChannel } from "@harness/contracts";
import { FakePublisher } from "../src/index.js";

function channel(): PublisherChannel {
  return { channel_id: "channel-a", repo_dir: "D:/legacy-channel-a", legacy_project_id: "project-01", expected_channel_id: "UCfake000000000000000001" };
}

function fixture(): { episodeDir: string; queuePath: string } {
  const root = mkdtempSync(join(tmpdir(), "fake-publisher-"));
  const episodeDir = join(root, "outputs", "project-01", "episodes", "episode-05");
  mkdirSync(episodeDir, { recursive: true });
  const queuePath = join(root, "outputs", "project-01", "publish-queue.json");
  return { episodeDir, queuePath };
}

describe("FakePublisher", () => {
  describe("upload", () => {
    it("writes a publish-queue.json entry in the episode_dir's grandparent on a successful upload", async () => {
      const { episodeDir, queuePath } = fixture();
      const publisher = new FakePublisher();
      const outcome = await publisher.upload({ channel: channel(), episode_no: 5, episode_dir: episodeDir, intent_at: "2026-09-14T00:00:00.000Z", timeout_seconds: 60 });
      expect(outcome).toEqual({ kind: "uploaded", video_id: "fake-1", receipt: expect.any(Object) });
      expect(publisher.uploads).toEqual([{ episode_no: 5, video_id: "fake-1" }]);
      const queue = JSON.parse(readFileSync(queuePath, "utf8"));
      expect(queue).toEqual([{ ep: 5, videoId: "fake-1", addedAt: "2026-09-14T00:00:00.000Z", via: "fake" }]);
    });

    it("allocates increasing fake-N video ids across uploads", async () => {
      const { episodeDir } = fixture();
      const publisher = new FakePublisher();
      const a = await publisher.upload({ channel: channel(), episode_no: 1, episode_dir: episodeDir, intent_at: "2026-09-14T00:00:00.000Z", timeout_seconds: 60 });
      const b = await publisher.upload({ channel: channel(), episode_no: 2, episode_dir: episodeDir, intent_at: "2026-09-14T00:00:00.000Z", timeout_seconds: 60 });
      expect(a.kind === "uploaded" && a.video_id).toBe("fake-1");
      expect(b.kind === "uploaded" && b.video_id).toBe("fake-2");
    });

    it("still writes the queue entry when the outcome is unknown (video created, script died)", async () => {
      const { episodeDir, queuePath } = fixture();
      const publisher = new FakePublisher({ upload: "unknown" });
      const outcome = await publisher.upload({ channel: channel(), episode_no: 6, episode_dir: episodeDir, intent_at: "2026-09-14T00:00:00.000Z", timeout_seconds: 60 });
      expect(outcome.kind).toBe("unknown");
      expect(existsSync(queuePath)).toBe(true);
      const queue = JSON.parse(readFileSync(queuePath, "utf8"));
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ ep: 6, via: "fake" });
    });

    it("does not write the queue when the upload is refused", async () => {
      const { episodeDir, queuePath } = fixture();
      const publisher = new FakePublisher({ upload: "refused" });
      const outcome = await publisher.upload({ channel: channel(), episode_no: 7, episode_dir: episodeDir, intent_at: "2026-09-14T00:00:00.000Z", timeout_seconds: 60 });
      expect(outcome).toEqual({ kind: "refused", reason: expect.any(String) });
      expect(existsSync(queuePath)).toBe(false);
      expect(publisher.uploads).toEqual([]);
    });

    it("does not write the queue when the upload is busy", async () => {
      const { episodeDir, queuePath } = fixture();
      const publisher = new FakePublisher({ upload: "busy" });
      const outcome = await publisher.upload({ channel: channel(), episode_no: 7, episode_dir: episodeDir, intent_at: "2026-09-14T00:00:00.000Z", timeout_seconds: 60 });
      expect(outcome).toEqual({ kind: "busy", reason: expect.any(String) });
      expect(existsSync(queuePath)).toBe(false);
    });

    it("does not write the queue when writeQueue is false, even on success", async () => {
      const { episodeDir, queuePath } = fixture();
      const publisher = new FakePublisher({ writeQueue: false });
      await publisher.upload({ channel: channel(), episode_no: 8, episode_dir: episodeDir, intent_at: "2026-09-14T00:00:00.000Z", timeout_seconds: 60 });
      expect(existsSync(queuePath)).toBe(false);
    });
  });

  describe("schedule", () => {
    it("records video_id and at on a successful schedule", async () => {
      const publisher = new FakePublisher();
      const outcome = await publisher.schedule({ channel: channel(), video_id: "yt-1", at: "2026-09-20T13:00:00.000Z", timeout_seconds: 60 });
      expect(outcome).toEqual({ kind: "scheduled" });
      expect(publisher.schedules).toEqual([{ video_id: "yt-1", at: "2026-09-20T13:00:00.000Z" }]);
    });

    it("returns refused/busy without recording when configured", async () => {
      const publisher = new FakePublisher({ schedule: "refused" });
      const outcome = await publisher.schedule({ channel: channel(), video_id: "yt-1", at: "2026-09-20T13:00:00.000Z", timeout_seconds: 60 });
      expect(outcome).toEqual({ kind: "refused", reason: expect.any(String) });
      expect(publisher.schedules).toEqual([]);
    });
  });

  describe("lookup", () => {
    it("counts calls and returns the configured static outcome", async () => {
      const publisher = new FakePublisher({ lookup: { found: true, video_id: "yt-9", visibility: "public" } });
      const outcome = await publisher.lookup({ channel: channel(), video_id: "yt-9" });
      expect(outcome).toEqual({ found: true, video_id: "yt-9", visibility: "public" });
      expect(publisher.lookups).toBe(1);
    });

    it("delegates to a function outcome, passing through video_id/title", async () => {
      const publisher = new FakePublisher({ lookup: (p) => ({ found: true, video_id: p.video_id ?? "unexpected", visibility: "public" }) });
      const outcome = await publisher.lookup({ channel: channel(), video_id: "yt-42" });
      expect(outcome).toEqual({ found: true, video_id: "yt-42", visibility: "public" });
    });

    it("defaults to found:false when no lookup outcome is configured", async () => {
      const publisher = new FakePublisher();
      expect(await publisher.lookup({ channel: channel(), video_id: "yt-1" })).toEqual({ found: false });
    });
  });
});
