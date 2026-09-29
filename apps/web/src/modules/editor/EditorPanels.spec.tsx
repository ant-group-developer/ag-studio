import { useMemo, useReducer, type Dispatch } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { layoutTimeline } from "@studio/timeline";
import { editorReducer, initEditor, type EditorAction } from "./state/editor-reducer";
import { sampleTimeline } from "./state/fixtures";
import { TimelineView } from "./TimelineView";
import { PropertiesPanel } from "./PropertiesPanel";
import type { EditorClient } from "./types";

const fakeClient: EditorClient = {
  getTimeline: vi.fn(),
  saveRevision: vi.fn(),
  ttsLine: vi.fn(),
  renderPreview: vi.fn(),
  getEditorJob: vi.fn(),
  audioUrl: vi.fn(),
  submitGate: vi.fn(),
  getStageDocument: vi.fn(),
};

let lastDispatch: Dispatch<EditorAction> | null = null;

function Harness() {
  const [state, dispatch] = useReducer(editorReducer, initEditor(sampleTimeline(), 1));
  lastDispatch = dispatch;
  const layout = useMemo(() => layoutTimeline(state.timeline), [state.timeline]);
  return (
    <div>
      <TimelineView layout={layout} selection={state.selection} dispatch={dispatch} playhead={0} onSeek={() => {}} />
      <PropertiesPanel productionId="prod-1" client={fakeClient} state={state} layout={layout} dispatch={dispatch} />
    </div>
  );
}

describe("TimelineView + PropertiesPanel (smoke)", () => {
  it("selecting a clip on the timeline shows its properties, and a trim dispatch updates the shown duration", () => {
    render(<Harness />);

    // C001 starts as src_in=1, src_out=3 -> 2.00s (see fixtures.ts).
    fireEvent.click(screen.getByTestId("clip-C001"));
    expect(screen.getByText("Clip C001")).toBeInTheDocument();
    expect(screen.getByText("Độ dài: 2.00s")).toBeInTheDocument();

    // Bypass the slider UI and dispatch the trim directly, as the reducer would receive it from a drag.
    act(() => {
      lastDispatch!({ type: "trimClip", clipId: "C001", srcIn: 1, srcOut: 5 });
    });

    expect(screen.getByText("Độ dài: 4.00s")).toBeInTheDocument();
  });
});
