/**
 * Web editor state (GĐ3): the Timeline v3 being edited, undo/redo, the selection and the server
 * revision the edit is based on. Every edit is one of the shared operations of `@studio/timeline`
 * (packages/core/src/studio/layout.ts) -- the same functions the API and the workflow use -- so the editor
 * cannot produce a timeline the render plan would lay out differently.
 */
import {
  addClip, addText, ensureAsset, moveClip, removeClip, removeText,
  replaceClipAsset, setSectionTitle, setMusic, setSourceMuted, updateText,
  TimelineOpError,
} from "@studio/timeline";
import type { EpisodeAsset, TimelineText, TimelineV3 } from "@harness/contracts";

export const HISTORY_LIMIT = 100;

export type Selection = { kind: "clip" | "text"; id: string } | null;

export interface EditorState {
  timeline: TimelineV3;
  /** Server revision `timeline` was loaded from or last saved as; the next save is based on it. */
  revision: number;
  /** The snapshot the server holds for `revision` (reference-compared to know whether there is anything to save). */
  saved: TimelineV3;
  past: TimelineV3[];
  future: TimelineV3[];
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
  | { type: "setMusic"; music: TimelineV3["music"] }
  | { type: "setSourceMuted"; muted: boolean };

export type EditorAction =
  | EditAction
  | { type: "load"; timeline: TimelineV3; revision: number }
  | { type: "saved"; revision: number; timeline: TimelineV3 }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; selection: Selection }
  | { type: "clearError" };

export function initEditor(timeline: TimelineV3, revision: number): EditorState {
  return { timeline, revision, saved: timeline, past: [], future: [], coalesceKey: null, selection: null, error: null };
}

export const isDirty = (s: EditorState) => s.timeline !== s.saved;

function apply(t: TimelineV3, a: EditAction): TimelineV3 {
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
  }
}

function coalesceKeyOf(a: EditAction): string | null {
  if (a.type === "updateText") return `text:${a.textId}`;
  if (a.type === "setMusic") return "music";
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
      let next: TimelineV3;
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
