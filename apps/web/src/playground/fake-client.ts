/**
 * In-memory `EditorClient` for the dev playground (`apps/web/playground.html`): lets the editor be looked at
 * and exercised without Auth0 or a running API. Mirrors the real API's contract closely enough to drive
 * `useEditor`/`Autosaver` through their normal paths (including a 409 conflict, on demand).
 */
import type { StoredTimeline } from "@harness/contracts";
import { StudioHttpError, type EditorJob, type MusicTrackView, type TimelineRevisionView } from "../api/studio-client";
import type { EditorClient } from "../modules/editor/types";
import { sampleCutTimeline, sampleTimeline } from "../modules/editor/state/fixtures";

export interface FakeEditorClientHandle {
  client: EditorClient;
  /** The next `saveRevision` call answers 409, as if someone else had just saved. */
  simulateConflictOnNextSave: () => void;
}

/** `cut`: a shot-cut episode (cut 1.1.0) with the source sound on, a text look and a small music library. */
export function createFakeEditorClient(o: { cut?: boolean } = {}): FakeEditorClientHandle {
  let revision = 1;
  let data: StoredTimeline = o.cut
    ? { ...sampleCutTimeline(), source_audio: { muted: false }, text_style: { text_color: "#FFD166", outline_color: "#000000", box_color: "#1D3557", size: "m" } }
    : sampleTimeline();
  const library: MusicTrackView[] = o.cut ? [
    { trackId: "am-ap", displayName: "Sáng sớm", moods: ["ấm áp", "calm"], durationSeconds: 184, loopOk: true, origin: "own", originNote: "nhóm", active: true, track: "library:music/am-ap.m4a", listenUrl: "" },
    { trackId: "cho-dem", displayName: "Chợ đêm", moods: ["upbeat"], durationSeconds: 151, loopOk: false, origin: "royalty_free", originNote: "Pixabay", active: true, track: "library:music/cho-dem.m4a", listenUrl: "" },
  ] : [];
  let conflictNext = false;
  const jobs = new Map<string, EditorJob>();
  let jobCounter = 0;
  const nextJobId = () => `job-${++jobCounter}`;

  const client: EditorClient = {
    async getTimeline(): Promise<TimelineRevisionView> {
      return {
        revision,
        data,
        authorId: "playground",
        savedAt: new Date().toISOString(),
        issues: [],
      };
    },

    async saveRevision(_productionId, _episodeId, baseRevision, newData) {
      if (conflictNext) {
        conflictNext = false;
        throw new StudioHttpError(409, { code: "revision_conflict", currentRevision: revision });
      }
      void baseRevision;
      revision += 1;
      data = newData;
      return { revision, issues: [] };
    },

    async renderPreview(_productionId, _episodeId, revisionArg) {
      const jobId = nextJobId();
      const job: EditorJob = {
        id: jobId,
        kind: "render_preview",
        status: "queued",
        progress: null,
        request: { revision: revisionArg },
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
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

    async getEditorJob(_productionId, _episodeId, jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new StudioHttpError(404, { message: `job ${jobId} không tồn tại` });
      return job;
    },

    async getAssetMedia(_productionId, assetId) {
      // Return null for all assets in the playground (no media server)
      void assetId;
      return null as unknown as import("../api/studio-client").AssetMedia;
    },

    async listMusic() {
      // no library unless `?cut`: the music panel falls back to typing a track
      return { tracks: library };
    },

    async getProductionCatalog() {
      // Return a minimal catalog with the sample timeline's assets
      const t = sampleTimeline();
      return {
        schema_version: "studio.catalog/v2" as const,
        production_id: "playground",
        folder_ids: [],
        total_available: Object.keys(t.assets).length,
        truncated: false,
        assets: Object.entries(t.assets).map(([id, a]) => ({
          asset_id: id,
          name: a.title,
          title_vi: a.title,
          summary_vi: a.summary_vi,
          duration_s: a.duration_s,
          orientation: a.orientation ?? "landscape",
          genre: "general",
          topics: [],
          subjects: [],
          places: [],
          actions: [],
          keywords_vi: [],
          tags: [],
          mood: "",
          setting: "",
          time_of_day: "",
          people_count: "0",
          shot_variety: [],
          has_speech: false,
          quality: null,
          usable: true,
          approved: false,
          project_names: [],
        })),
      };
    },
  };

  return { client, simulateConflictOnNextSave: () => { conflictNext = true; } };
}
