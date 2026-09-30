/**
 * Editor state wiring (GĐ3): loads the latest timeline v3 revision, drives `editorReducer`, and keeps
 * one `Autosaver` running while the timeline is dirty. `EditorView` is pure UI on top of this.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { TimelineV3 } from "@harness/contracts";
import { editorReducer, initEditor, isDirty, type EditorAction, type EditorState } from "./state/editor-reducer";
import { Autosaver, type AutosaveStatus, type SaveResult } from "./state/autosave";
import { StudioHttpError } from "../../api/studio-client";
import type { EditorClient } from "./types";

function wrapReducer(s: EditorState | null, a: EditorAction): EditorState | null {
  if (a.type === "load") return initEditor(a.timeline, a.revision);
  if (s === null) return s;
  return editorReducer(s, a);
}

export interface ConflictInfo {
  currentRevision: number;
}

export interface UseEditorResult {
  state: EditorState | null;
  loading: boolean;
  loadError: string | null;
  dispatch: React.Dispatch<EditorAction>;
  autosaveStatus: AutosaveStatus;
  saveError: string | null;
  conflict: ConflictInfo | null;
  /** Save now (before "Render preview"); resolves once the latest edit is saved or refused. */
  flush: () => Promise<void>;
  /** Conflict resolution: discard local edits and load the revision someone else just saved. */
  loadLatest: () => Promise<void>;
  /** Conflict resolution: keep the local timeline and save it on top of the revision that beat it. */
  keepMine: () => Promise<void>;
}

export function useEditor(productionId: string, episodeId: string, client: EditorClient): UseEditorResult {
  const [state, dispatch] = useReducer(wrapReducer, null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);

  const save = useCallback(
    async (base: number, timeline: TimelineV3): Promise<SaveResult> => {
      try {
        const r = await client.saveRevision(productionId, episodeId, base, timeline);
        return { ok: true, revision: r.revision };
      } catch (e) {
        if (e instanceof StudioHttpError && e.status === 409) {
          const current = e.body && typeof e.body.currentRevision === "number" ? (e.body.currentRevision as number) : base;
          return { ok: false, conflict: true, currentRevision: current };
        }
        return { ok: false, conflict: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [client, productionId, episodeId]
  );

  const saverRef = useRef<Autosaver | null>(null);
  if (!saverRef.current) {
    saverRef.current = new Autosaver({
      save,
      onSaved: (revision, timeline) => {
        dispatch({ type: "saved", revision, timeline });
        setSaveError(null);
        setAutosaveStatus(saverRef.current!.status);
      },
      onConflict: (currentRevision) => {
        setConflict({ currentRevision });
        setAutosaveStatus(saverRef.current!.status);
      },
      onError: (message) => {
        setSaveError(message);
        setAutosaveStatus(saverRef.current!.status);
      },
      onStatus: (status) => setAutosaveStatus(status),
    });
  }

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await client.getTimeline(productionId, episodeId);
      dispatch({ type: "load", timeline: r.data, revision: r.revision });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, productionId, episodeId]);

  useEffect(() => {
    void reload();
    // Only on mount / when the production or episode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productionId, episodeId]);

  useEffect(() => {
    if (!state) return;
    if (isDirty(state)) {
      saverRef.current!.schedule(state.revision, state.timeline);
      setAutosaveStatus(saverRef.current!.status);
    }
  }, [state]);

  useEffect(() => () => saverRef.current?.dispose(), []);

  const flush = useCallback(async () => {
    await saverRef.current!.flush();
    setAutosaveStatus(saverRef.current!.status);
  }, []);

  const loadLatest = useCallback(async () => {
    await reload();
    saverRef.current!.resolveConflict();
    setConflict(null);
    setSaveError(null);
    setAutosaveStatus(saverRef.current!.status);
  }, [reload]);

  const keepMine = useCallback(async () => {
    if (!state || !conflict) return;
    saverRef.current!.resolveConflict();
    try {
      const r = await client.saveRevision(productionId, episodeId, conflict.currentRevision, state.timeline);
      dispatch({ type: "saved", revision: r.revision, timeline: state.timeline });
      setConflict(null);
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
    setAutosaveStatus(saverRef.current!.status);
  }, [state, conflict, client, productionId, episodeId]);

  return { state, loading, loadError, dispatch, autosaveStatus, saveError, conflict, flush, loadLatest, keepMine };
}
