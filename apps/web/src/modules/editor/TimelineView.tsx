/**
 * Timeline tracks (plan 4.2, M1): V1 (clips, grouped by beat), A1 (narration lines) and T (texts), all laid
 * out in seconds by `layoutTimeline` and drawn here at `PX_PER_SECOND`. Reordering happens with ◀ ▶ buttons
 * (`moveBeat`/`moveClip`) rather than drag-and-drop, which is simpler to get right and to test.
 */
import type { Dispatch, MouseEvent } from "react";
import type { TimelineLayout } from "@studio/timeline";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import type { EditorAction, Selection } from "./state/editor-reducer";

export const PX_PER_SECOND = 30;

function isSelected(selection: Selection, kind: "beat" | "clip" | "line" | "text", id: string): boolean {
  return !!selection && selection.kind === kind && selection.id === id;
}

export interface TimelineViewProps {
  layout: TimelineLayout;
  selection: Selection;
  dispatch: Dispatch<EditorAction>;
  playhead: number;
  onSeek: (t: number) => void;
}

export function TimelineView({ layout, selection, dispatch, playhead, onSeek }: TimelineViewProps) {
  const width = Math.max(1, Math.round(layout.duration * PX_PER_SECOND)) + 40;

  const handleRulerClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, (e.clientX - rect.left) / PX_PER_SECOND);
    onSeek(Math.min(t, layout.duration));
  };

  return (
    <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 4, marginTop: 12 }}>
      <div style={{ width, position: "relative" }}>
        {/* Ruler + playhead */}
        <div
          onClick={handleRulerClick}
          style={{ height: 20, background: "#fafafa", cursor: "pointer", position: "relative" }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: playhead * PX_PER_SECOND,
              width: 2,
              background: "#f5222d",
              zIndex: 5,
            }}
          />
        </div>

        {/* Beat headers */}
        <div style={{ display: "flex", height: 28, borderTop: "1px solid #eee" }}>
          {layout.beats.map((b, i) => (
            <div
              key={b.beat_id}
              data-testid={`beat-${b.beat_id}`}
              onClick={() => dispatch({ type: "select", selection: { kind: "beat", id: b.beat_id } })}
              style={{
                width: b.duration * PX_PER_SECOND,
                minWidth: 40,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 4px",
                borderRight: "1px solid #eee",
                background: isSelected(selection, "beat", b.beat_id) ? "#e6f4ff" : undefined,
                fontSize: 12,
                cursor: "pointer",
              }}
              title={b.title}
            >
              <a
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "moveBeat", from: i, to: i - 1 });
                }}
              >
                <LeftOutlined />
              </a>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "center" }}>
                {b.title}
              </span>
              <a
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "moveBeat", from: i, to: i + 1 });
                }}
              >
                <RightOutlined />
              </a>
            </div>
          ))}
        </div>

        {/* V1: clips */}
        <div style={{ display: "flex", height: 48, borderTop: "1px solid #eee", position: "relative" }}>
          {layout.clips.map((c) => (
            <div
              key={c.clip_id}
              data-testid={`clip-${c.clip_id}`}
              onClick={() => dispatch({ type: "select", selection: { kind: "clip", id: c.clip_id } })}
              style={{
                width: c.duration * PX_PER_SECOND,
                minWidth: 20,
                borderRight: "2px solid #fff",
                background: isSelected(selection, "clip", c.clip_id) ? "#1677ff" : "#91caff",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 11,
                color: "#fff",
                cursor: "pointer",
                overflow: "hidden",
              }}
              title={`${c.clip_id} (${c.duration.toFixed(2)}s)`}
            >
              <a onClick={(e) => { e.stopPropagation(); dispatch({ type: "moveClip", clipId: c.clip_id, delta: -1 }); }}>
                <LeftOutlined />
              </a>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.clip_id}</span>
              <a onClick={(e) => { e.stopPropagation(); dispatch({ type: "moveClip", clipId: c.clip_id, delta: 1 }); }}>
                <RightOutlined />
              </a>
            </div>
          ))}
        </div>

        {/* A1: narration */}
        <div style={{ height: 32, borderTop: "1px solid #eee", position: "relative" }}>
          {layout.lines.map((l) => (
            <div
              key={l.line_id}
              data-testid={`line-${l.line_id}`}
              onClick={() => dispatch({ type: "select", selection: { kind: "line", id: l.line_id } })}
              style={{
                position: "absolute",
                left: l.start * PX_PER_SECOND,
                width: Math.max(4, l.duration * PX_PER_SECOND),
                height: 24,
                top: 4,
                background: isSelected(selection, "line", l.line_id) ? "#389e0d" : l.estimated ? "#ffd591" : "#b7eb8f",
                borderRadius: 2,
                fontSize: 10,
                padding: "0 4px",
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                cursor: "pointer",
              }}
              title={l.text}
            >
              {l.text}
            </div>
          ))}
        </div>

        {/* T: texts */}
        <div style={{ height: 28, borderTop: "1px solid #eee", position: "relative" }}>
          {layout.texts.map((x) => (
            <div
              key={x.text_id}
              data-testid={`text-${x.text_id}`}
              onClick={() => dispatch({ type: "select", selection: { kind: "text", id: x.text_id } })}
              style={{
                position: "absolute",
                left: x.start * PX_PER_SECOND,
                width: Math.max(4, (x.end - x.start) * PX_PER_SECOND),
                height: 20,
                top: 4,
                background: isSelected(selection, "text", x.text_id) ? "#ad6800" : "#ffe58f",
                borderRadius: 2,
                fontSize: 10,
                padding: "0 4px",
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                cursor: "pointer",
              }}
              title={x.text}
            >
              {x.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
