/**
 * Web editor state (plan 4.2, M1): the Timeline v2 being edited, undo/redo, the selection and the server
 * revision the edit is based on. Every edit is one of the shared operations of `@studio/timeline`
 * (packages/core/src/studio/layout.ts) -- the same functions the API and the workflow use -- so the editor
 * cannot produce a timeline the render plan would lay out differently.
 */
import {
  addClip, addText, ensureSegment, moveBeat, moveClip, removeClip, removeText, replaceClipSegment, setCaptions, setLineAudio,
  setLineText, setMusic, setSourceAudioMuted, trimClip, updateText, TimelineOpError, type SegmentInfo,
} from "@studio/timeline";
import type { TimelineText, TimelineV2 } from "@harness/contracts";

export const HISTORY_LIMIT = 100;

export type Selection = { kind: "beat" | "clip" | "line" | "text"; id: string } | null;

export interface EditorState {
  timeline: TimelineV2;
  /** Server revision `timeline` was loaded from or last saved as; the next save is based on it. */
  revision: number;
  /** The snapshot the server holds for `revision` (reference-compared to know whether there is anything to save). */
  saved: TimelineV2;
  past: TimelineV2[];
  future: TimelineV2[];
  /** Consecutive edits with the same key (a trim drag) collapse into one undo step. */
  coalesceKey: string | null;
  selection: Selection;
  error: string | null;
}

export type EditAction =
  | { type: "swapClip"; clipId: string; segmentId: string; segment?: SegmentInfo }
  | { type: "addClip"; beatId: string; segmentId: string; segment?: SegmentInfo }
  | { type: "removeClip"; clipId: string }
  | { type: "moveClip"; clipId: string; delta: -1 | 1 }
  | { type: "trimClip"; clipId: string; srcIn: number; srcOut: number }
  | { type: "moveBeat"; from: number; to: number }
  | { type: "setLineText"; lineId: string; text: string }
  | { type: "setLineAudio"; lineId: string; forText: string; audio: { key: string; duration: number } }
  | { type: "addText"; text: Omit<TimelineText, "text_id"> }
  | { type: "updateText"; textId: string; patch: Partial<Omit<TimelineText, "text_id">> }
  | { type: "removeText"; textId: string }
  | { type: "setMusic"; music: TimelineV2["music"] }
  | { type: "setSourceMuted"; muted: boolean }
  | { type: "setCaptions"; enabled: boolean };

export type EditorAction =
  | EditAction
  | { type: "load"; timeline: TimelineV2; revision: number }
  | { type: "saved"; revision: number; timeline: TimelineV2 }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; selection: Selection }
  | { type: "clearError" };

export function initEditor(timeline: TimelineV2, revision: number): EditorState {
  return { timeline, revision, saved: timeline, past: [], future: [], coalesceKey: null, selection: null, error: null };
}

export const isDirty = (s: EditorState) => s.timeline !== s.saved;

function apply(t: TimelineV2, a: EditAction): TimelineV2 {
  switch (a.type) {
    case "swapClip": return replaceClipSegment(a.segment ? ensureSegment(t, a.segmentId, a.segment) : t, a.clipId, a.segmentId);
    case "addClip": return addClip(a.segment ? ensureSegment(t, a.segmentId, a.segment) : t, a.beatId, a.segmentId);
    case "removeClip": return removeClip(t, a.clipId);
    case "moveClip": return moveClip(t, a.clipId, a.delta);
    case "trimClip": return trimClip(t, a.clipId, a.srcIn, a.srcOut);
    case "moveBeat": return moveBeat(t, a.from, a.to);
    case "setLineText": return setLineText(t, a.lineId, a.text);
    case "setLineAudio": return setLineAudio(t, a.lineId, a.forText, a.audio);
    case "addText": return addText(t, a.text);
    case "updateText": return updateText(t, a.textId, a.patch);
    case "removeText": return removeText(t, a.textId);
    case "setMusic": return setMusic(t, a.music);
    case "setSourceMuted": return setSourceAudioMuted(t, a.muted);
    case "setCaptions": return setCaptions(t, a.enabled);
  }
}

function coalesceKeyOf(a: EditAction): string | null {
  if (a.type === "trimClip") return `trim:${a.clipId}`;
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
      let next: TimelineV2;
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
