import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useEditor } from "./useEditor";
import { sampleTimeline } from "./state/fixtures";
import { StudioHttpError } from "../../api/studio-client";
import type { EditorClient } from "./types";

function makeClient(overrides: Partial<EditorClient> = {}): EditorClient {
  return {
    getTimeline: vi.fn().mockResolvedValue({
      revision: 1,
      data: sampleTimeline(),
      authorId: "u1",
      savedAt: "2024-01-01T00:00:00Z",
      issues: [],
    }),
    saveRevision: vi.fn().mockResolvedValue({ revision: 2, issues: [] }),
    renderPreview: vi.fn(),
    getEditorJob: vi.fn(),
    getAssetMedia: vi.fn(),
    getProductionCatalog: vi.fn(),
    ...overrides,
  };
}

describe("useEditor: save result mapping (v3)", () => {
  it("loads the latest timeline revision", async () => {
    const client = makeClient();
    const { result } = renderHook(() => useEditor("prod-1", "ep-1", client));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.state!.revision).toBe(1);
    expect(client.getTimeline).toHaveBeenCalledWith("prod-1", "ep-1");
  });

  it("maps a 409 (revision_conflict) to the conflict state, not a save error", async () => {
    const client = makeClient({
      saveRevision: vi.fn().mockRejectedValue(new StudioHttpError(409, { code: "revision_conflict", currentRevision: 7 })),
    });
    const { result } = renderHook(() => useEditor("prod-1", "ep-1", client));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    act(() => result.current.dispatch({ type: "setSourceMuted", muted: false }));
    await act(async () => {
      await result.current.flush();
    });

    expect(result.current.conflict).toEqual({ currentRevision: 7 });
    expect(result.current.saveError).toBeNull();
    expect(result.current.autosaveStatus).toBe("conflict");
  });

  it("maps a network/other error to a save error and keeps autosave retryable", async () => {
    const client = makeClient({ saveRevision: vi.fn().mockRejectedValue(new Error("network down")) });
    const { result } = renderHook(() => useEditor("prod-1", "ep-1", client));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    act(() => result.current.dispatch({ type: "setSourceMuted", muted: false }));
    await act(async () => {
      await result.current.flush();
    });

    expect(result.current.conflict).toBeNull();
    expect(result.current.saveError).toMatch(/network down/);
    expect(result.current.autosaveStatus).toBe("error");
  });

  it("a successful save advances the revision", async () => {
    const client = makeClient({ saveRevision: vi.fn().mockResolvedValue({ revision: 2, issues: [] }) });
    const { result } = renderHook(() => useEditor("prod-1", "ep-1", client));
    await waitFor(() => expect(result.current.state).not.toBeNull());

    act(() => result.current.dispatch({ type: "setSourceMuted", muted: false }));
    await act(async () => {
      await result.current.flush();
    });

    expect(result.current.state!.revision).toBe(2);
    expect(result.current.state!.timeline).toBe(result.current.state!.saved);
    expect(result.current.autosaveStatus).toBe("idle");
  });
});
