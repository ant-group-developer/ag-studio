/**
 * Web editor state (GĐ3; v4 in phase 5): the timeline being edited (v3, or v4 for a shot-cut episode), undo/redo, the selection and the server
 * revision the edit is based on. Every edit is one of the shared operations of `@studio/timeline`
 * (packages/core/src/studio/layout.ts) -- the same functions the API and the workflow use -- so the editor
 * cannot produce a timeline the render plan would lay out differently.
 */
import {
  addClip, addText, ensureAsset, moveClip, removeClip, removeText,
  replaceClipAsset, setCaptions, setSectionTitle, setMusic, setSourceMuted, setTransition, trimClip, updateText,
  TimelineOpError,
} from "@studio/timeline";
import type { CaptionMode, EpisodeAsset, StoredTimeline, TimelineText, TimelineTransitionKind, TimelineV4 } from "@harness/contracts";

export const HISTORY_LIMIT = 100;

export type Selection = { kind: "clip" | "text"; id: string } | null;

export interface EditorState {
  timeline: StoredTimeline;
  /** Server revision `timeline` was loaded from or last saved as; the next save is based on it. */
  revision: number;
  /** The snapshot the server holds for `revision` (reference-compared to know whether there is anything to save). */
  saved: StoredTimeline;
  past: StoredTimeline[];
  future: StoredTimeline[];
  /** Consecutive edits with the same key (e.g. text edits) collapse into one undo step. */
  coalesceKey: string | null;
  selection: Selection;
  error: string | null;
}

export type EditAction =
  | { type: "addClip"; assetId: string; index: number; asset?: EpisodeAsset }
  | { type: "removeClip"; clipId: string }
  | { type: "moveClip"; from: number; to: number }
  | { type: "swapClip"; clipId: string; newAssetId: string; asset?: EpisodeAsset }
  | { type: "setSectionTitle"; clipId: string; title: string | null }
  | { type: "addText"; text: Omit<TimelineText, "text_id"> }
  | { type: "updateText"; textId: string; patch: Partial<Omit<TimelineText, "text_id">> }
  | { type: "removeText"; textId: string }
  | { type: "setMusic"; music: StoredTimeline["music"] }
  | { type: "setSourceMuted"; muted: boolean }
  // timeline v4 (shot-cut episodes); on a v3 timeline they are refused like any invalid edit
  | { type: "trimClip"; clipId: string; in: number; out: number | null }
  | { type: "setTransition"; clipId: string; kind: TimelineTransitionKind; seconds: number }
  | { type: "setCaptions"; mode: CaptionMode };

export type EditorAction =
  | EditAction
  | { type: "load"; timeline: StoredTimeline; revision: number }
  | { type: "saved"; revision: number; timeline: StoredTimeline }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; selection: Selection }
  | { type: "clearError" };

export function initEditor(timeline: StoredTimeline, revision: number): EditorState {
  return { timeline, revision, saved: timeline, past: [], future: [], coalesceKey: null, selection: null, error: null };
}

export const isDirty = (s: EditorState) => s.timeline !== s.saved;

function apply(t: StoredTimeline, a: EditAction): StoredTimeline {
  switch (a.type) {
    case "addClip": {
      const withAsset = a.asset ? ensureAsset(t, a.assetId, a.asset) : t;
      return addClip(withAsset, a.assetId, a.index);
    }
    case "removeClip": return removeClip(t, a.clipId);
    case "moveClip": return moveClip(t, a.from, a.to);
    case "swapClip": {
      const withAsset = a.asset ? ensureAsset(t, a.newAssetId, a.asset) : t;
      return replaceClipAsset(withAsset, a.clipId, a.newAssetId);
    }
    case "setSectionTitle": return setSectionTitle(t, a.clipId, a.title);
    case "addText": return addText(t, a.text);
    case "updateText": return updateText(t, a.textId, a.patch);
    case "removeText": return removeText(t, a.textId);
    case "setMusic": return setMusic(t, a.music);
    case "setSourceMuted": return setSourceMuted(t, a.muted);
    // the shared ops check the version themselves (TimelineOpError "needs_v4")
    case "trimClip": return trimClip(t as TimelineV4, a.clipId, a.in, a.out);
    case "setTransition": return setTransition(t as TimelineV4, a.clipId, a.kind, a.seconds);
    case "setCaptions": return setCaptions(t as TimelineV4, a.mode);
  }
}

function coalesceKeyOf(a: EditAction): string | null {
  if (a.type === "updateText") return `text:${a.textId}`;
  if (a.type === "setMusic") return "music";
  // nudging a clip's in/out by 0.1 s steps is one undo step
  if (a.type === "trimClip") return `trim:${a.clipId}`;
  return null;
}

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case "load":
      return initEditor(a.timeline, a.revision);
    case "saved":
      // Only the snapshot that was sent is known to the server; edits made while saving stay dirty.
      return { ...s, revision: a.revision, saved: a.timeline };
    case "undo": {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      return { ...s, timeline: prev, past: s.past.slice(0, -1), future: [s.timeline, ...s.future], coalesceKey: null, error: null };
    }
    case "redo": {
      const next = s.future[0];
      if (!next) return s;
      return { ...s, timeline: next, past: [...s.past, s.timeline].slice(-HISTORY_LIMIT), future: s.future.slice(1), coalesceKey: null, error: null };
    }
    case "select":
      return { ...s, selection: a.selection };
    case "clearError":
      return { ...s, error: null };
    default: {
      let next: StoredTimeline;
      try {
        next = apply(s.timeline, a);
      } catch (e) {
        if (e instanceof TimelineOpError) return { ...s, error: e.message };
        throw e;
      }
      if (next === s.timeline) return s;
      const key = coalesceKeyOf(a);
      const past = key !== null && key === s.coalesceKey ? s.past : [...s.past, s.timeline].slice(-HISTORY_LIMIT);
      return { ...s, timeline: next, past, future: [], coalesceKey: key, error: null };
    }
  }
}
