import { useMemo, useReducer } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { layoutTimeline } from "@studio/timeline";
import { editorReducer, initEditor } from "./state/editor-reducer";
import { sampleCutTimeline, sampleTimeline } from "./state/fixtures";
import { PX_PER_SECOND, TimelineView } from "./TimelineView";
import i18n from "../../i18n/config";
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

function Harness({ cut = false }: { cut?: boolean }) {
  const [state, dispatch] = useReducer(editorReducer, initEditor(cut ? sampleCutTimeline() : sampleTimeline(), 1));
  const layout = useMemo(() => layoutTimeline(state.timeline), [state.timeline]);
  return (
    <div>
      <TimelineView layout={layout} selection={state.selection} dispatch={dispatch} playhead={0} onSeek={() => {}}
        narration={{ L001: "Phố cổ buổi sáng, phở đã sôi." }} />
      <PropertiesPanel state={state} layout={layout} dispatch={dispatch} />
    </div>
  );
}

describe("TimelineView + PropertiesPanel (smoke)", () => {
  beforeAll(async () => { await i18n.changeLanguage("vi"); });
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

  it("a shot-cut clip is as wide as its trimmed piece; changing its out narrows it; the dissolve and the narration show", () => {
    render(<Harness cut />);
    expect(screen.getByTestId("clip-C001")).toHaveStyle({ width: `${4 * PX_PER_SECOND}px` });
    expect(screen.getByTestId("transition-C001")).toBeInTheDocument();
    expect(screen.getByTestId("line-L001")).toHaveTextContent("Phố cổ buổi sáng, phở đã sôi.");
    fireEvent.click(screen.getByTestId("clip-C001"));
    expect(screen.getByText("Lời dẫn L001 bắt đầu ở clip này (sửa lời ở bước Kế hoạch dựng)")).toBeInTheDocument();
    const out = screen.getByRole("spinbutton", { name: "Ra (s)" });
    fireEvent.change(out, { target: { value: "3" } });
    fireEvent.blur(out);
    expect(screen.getByTestId("clip-C001")).toHaveStyle({ width: `${2 * PX_PER_SECOND}px` });
  });

  it("a whole-video episode has no in/out, transition or captions fields", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("clip-C001"));
    expect(screen.queryByRole("spinbutton", { name: "Vào (s)" })).toBeNull();
    expect(screen.queryByLabelText("Chuyển sang clip sau")).toBeNull();
    expect(screen.queryByLabelText("Phụ đề")).toBeNull();
    expect(screen.queryByTestId("line-L001")).toBeNull();
  });
});
