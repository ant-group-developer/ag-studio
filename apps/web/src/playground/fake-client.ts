/**
 * In-memory `EditorClient` for the dev playground (`apps/web/playground.html`): lets the editor be looked at
 * and exercised without Auth0 or a running API. Mirrors the real API's contract closely enough to drive
 * `useEditor`/`Autosaver` through their normal paths (including a 409 conflict, on demand).
 */
import { estimateSpeechSeconds } from "@studio/timeline";
import type { TimelineV2 } from "@harness/contracts";
import { StudioHttpError, type EditorJob, type TimelineRevisionView } from "../api/studio-client";
import type { EditorClient } from "../modules/editor/types";
import { sampleTimeline } from "../modules/editor/state/fixtures";

export interface FakeEditorClientHandle {
  client: EditorClient;
  /** The next `saveRevision` call answers 409, as if someone else had just saved. */
  simulateConflictOnNextSave: () => void;
}

export function createFakeEditorClient(): FakeEditorClientHandle {
  let revision = 1;
  let data: TimelineV2 = sampleTimeline();
  let conflictNext = false;
  const jobs = new Map<string, EditorJob>();
  let jobCounter = 0;
  const nextJobId = () => `job-${++jobCounter}`;

  const client: EditorClient = {
    async getTimeline(): Promise<TimelineRevisionView> {
      return {
        revision,
        base_revision: revision,
        data,
        author_id: "playground",
        label: null,
        created_at: new Date().toISOString(),
        issues: [],
      };
    },

    async saveRevision(_id, baseRevision, newData) {
      if (conflictNext) {
        conflictNext = false;
        throw new StudioHttpError(409, { code: "revision_conflict", currentRevision: revision });
      }
      void baseRevision;
      revision += 1;
      data = newData;
      return { revision, issues: [] };
    },

    async ttsLine(_id, lineId, text) {
      const jobId = nextJobId();
      const job: EditorJob = {
        id: jobId,
        kind: "tts_line",
        status: "queued",
        request: { lineId, text },
        result: null,
        error: null,
        created_at: new Date().toISOString(),
      };
      jobs.set(jobId, job);
      // "Completes after one poll": still queued the instant it's created, done by the time anyone polls it.
      setTimeout(() => {
        jobs.set(jobId, {
          ...job,
          status: "completed",
          result: { line_id: lineId, text, key: `audio/playground-${jobId}.wav`, duration: estimateSpeechSeconds(text) },
        });
      }, 50);
      return job;
    },

    async renderPreview(_id, revisionArg) {
      const jobId = nextJobId();
      const job: EditorJob = {
        id: jobId,
        kind: "render_preview",
        status: "queued",
        request: { revision: revisionArg },
        result: null,
        error: null,
        created_at: new Date().toISOString(),
      };
      jobs.set(jobId, job);
      setTimeout(() => {
        jobs.set(jobId, {
          ...job,
          status: "completed",
          result: { key: "previews/playground.mp4", duration_s: 10, watermarked: true, revision: revisionArg },
          urlHidden: "footage_scope",
        });
      }, 50);
      return job;
    },

    async getEditorJob(_id, jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new StudioHttpError(404, { message: `job ${jobId} không tồn tại` });
      return job;
    },

    async audioUrl() {
      // `media` also resolves to null in the playground, so nothing ever plays this URL.
      return { url: "" };
    },

    async submitGate() {
      return { stageState: "SUCCEEDED", runState: "WAITING_HUMAN" };
    },

    async getStageDocument<T>(_id: string, stage: string): Promise<T> {
      if (stage !== "catalog") throw new StudioHttpError(404, { message: "không có tài liệu stage trong playground" });
      // the sample timeline's segments, plus a few the timeline does not use yet, as a studio.catalog/v1
      const extra = ["cat-1", "cat-2", "cat-3"].map((id, i) => [id, { asset_id: "asset-2", start_ms: i * 6000, end_ms: (i + 1) * 6000, caption: ["ngõ phố cổ", "xe đạp bán hoa", "quán cà phê"][i]!, orientation: "landscape" }] as const);
      const segments = [...Object.entries(sampleTimeline().segments), ...extra].map(([id, g]) => ({
        id, asset_id: g.asset_id, start_ms: g.start_ms, end_ms: g.end_ms, duration_s: (g.end_ms - g.start_ms) / 1000,
        caption_vi: g.caption, caption_en: "", tags: [], keywords_vi: [], subjects: [], actions: [], shot_size: null, camera_motion: null,
        time_of_day: null, setting: null, people_count: null, orientation: g.orientation, quality: 4, usable: true, approved: false,
      }));
      return { schema_version: "studio.catalog/v1", production_id: "playground", folder_ids: [], total_available: segments.length, truncated: false, segments } as T;
    },
  };

  return { client, simulateConflictOnNextSave: () => { conflictNext = true; } };
}
