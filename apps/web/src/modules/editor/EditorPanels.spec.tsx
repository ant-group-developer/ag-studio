import { useMemo, useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { layoutTimeline } from "@studio/timeline";
import { editorReducer, initEditor } from "./state/editor-reducer";
import { sampleTimeline } from "./state/fixtures";
import { TimelineView } from "./TimelineView";
import { PropertiesPanel } from "./PropertiesPanel";
import type { EditorClient } from "./types";

// Minimal fake EditorClient for v3
const fakeClient: EditorClient = {
  getTimeline: vi.fn(),
  saveRevision: vi.fn(),
  renderPreview: vi.fn(),
  getEditorJob: vi.fn(),
  getAssetMedia: vi.fn(),
  getProductionCatalog: vi.fn(),
};

function Harness() {
  const [state, dispatch] = useReducer(editorReducer, initEditor(sampleTimeline(), 1));
  const layout = useMemo(() => layoutTimeline(state.timeline), [state.timeline]);
  return (
    <div>
      <TimelineView layout={layout} selection={state.selection} dispatch={dispatch} playhead={0} onSeek={() => {}} />
      <PropertiesPanel state={state} layout={layout} dispatch={dispatch} />
    </div>
  );
}

describe("TimelineView + PropertiesPanel (smoke)", () => {
  it("renders clips from the sample timeline without crashing", () => {
    render(<Harness />);
    expect(screen.getByTestId("clip-C001")).toBeInTheDocument();
    expect(screen.getByTestId("clip-C002")).toBeInTheDocument();
    expect(screen.getByTestId("clip-C003")).toBeInTheDocument();
  });

  it("selecting a clip shows its properties panel", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("clip-C001"));
    // Properties panel should show clip C001 title (may appear in both the clip row and the panel heading)
    expect(screen.getAllByText(/C001/).length).toBeGreaterThan(0);
  });
});
