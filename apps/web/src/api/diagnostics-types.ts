/** The admin's diagnostics of a period (`/api/studio/diagnostics/*`, plan 2026-11-07), as the API answers them. */

export interface DiagnosticsQuery { from: string; to: string; tz?: number }
interface Period { from: string; to: string; tzOffsetMinutes?: number }

export interface JobCount { kind: string; status: string; n: number }
export interface StuckJob {
  id: string; kind: string; status: string; title: string; projectId: string; projectName: string | null; videoId: string | null;
  createdAt: string; startedAt: string | null; nodeId: string | null; minutes: number;
}
export interface TurnSummary { byStatus: Record<string, number>; byTrigger: Record<string, number>; costUsd: number }
export interface DiagnosticsOverview extends Period {
  jobs: JobCount[];
  previousJobs: JobCount[];
  turns: TurnSummary;
  previousTurns: TurnSummary;
  stuck: StuckJob[];
  daily: { day: string; jobs: number; jobsFailed: number; turns: number; turnsFailed: number }[];
  accounts: { id: string; label: string; lastError: string; lastErrorAt: string; rateLimitedUntil: string | null }[];
}

export interface ErrorOccurrence {
  source: string; kind: string; message: string; at: string; projectId: string | null; projectName: string | null; videoId: string | null; ref: string | null; repeats?: number;
}
export interface ErrorGroup {
  key: string; source: string; signature: string; kinds: string[]; count: number; projects: number; firstAt: string; lastAt: string;
  previousCount: number; trend: "new" | "same"; examples: ErrorOccurrence[];
}
export interface DiagnosticsErrors extends Period {
  groups: ErrorGroup[];
  gone: { key: string; source: string; signature: string; previousCount: number }[];
  total: number;
  truncated: boolean;
}

export interface RenderKindStats {
  kind: string; total: number; done: number; failed: number; cancelled: number; wallP50: number | null; wallP90: number | null;
  waitP50: number | null; speedP50: number | null; retried: number; byHeight: Record<string, number>;
}
export interface RenderNodeStats { nodeId: string; name: string | null; jobs: number; done: number; failed: number; speedP50: number | null; finals: number; finalWallP50: number | null }
export interface SlowRender {
  id: string; kind: string; projectId: string; projectName: string | null; videoId: string | null; videoTitle: string | null; nodeId: string | null;
  wallSeconds: number; videoSeconds: number | null; height: number | null; finishedAt: string;
}
export interface FarmErrorGroup { type: string; code: string; signature: string; count: number; lastAt: string; example: string; nodes: string[] }
export interface DiagnosticsRenders extends Period {
  kinds: RenderKindStats[];
  previousKinds: RenderKindStats[];
  nodes: RenderNodeStats[];
  slowest: SlowRender[];
  farm: { byType: { type: string; status: string; n: number }[]; retried: Record<string, number>; errors: FarmErrorGroup[]; truncated: boolean } | null;
  farmError: string | null;
}

export type VideoFlagSeverity = "error" | "warning" | "info";
export interface VideoFlag { code: string; severity: VideoFlagSeverity; detail: string }
export interface VideoQualityRow {
  videoId: string; videoTitle: string; projectId: string; projectName: string; teamId: string;
  jobId: string; kind: "render_final" | "render_preview"; revision: number; finishedAt: string;
  width: number | null; height: number | null; durationSeconds: number | null;
  editStyle: string | null; voice: string | null; captions: string | null; music: boolean; look: string | null;
  shots: number; shotMean: number | null; shotMedian: number | null; longShare: number | null; shortShare: number | null; longestShot: number | null;
  assetVariety: number | null; lines: number; linesWithoutAudio: number; maxVoiceGap: number | null; voiceCoverage: number | null;
  timelineIssues: Record<string, number>;
  inspect: { issues: Record<string, number>; loudnessMedianLufs: number | null; freezes: number; blacks: number; silences: number } | null;
  renders: number; asksAfterFirstRender: number; agentEditsAfterFirstRender: number;
  flags: VideoFlag[];
}
export interface DiagnosticsVideos extends Period {
  rows: VideoQualityRow[];
  summary: {
    videos: number; flags: { code: string; videos: number; severity: VideoFlagSeverity }[];
    shotMedian: number | null; longShare: number | null; rendersMedian: number | null; asksMedian: number | null; byHeight: Record<string, number>;
  };
  truncated: boolean;
}
