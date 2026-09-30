/**
 * Timeline tracks (GĐ3, v3): clips row (width ∝ duration) + sections row + texts row.
 * Reordering via @dnd-kit/sortable; remove/select via dispatch.
 */
import type { Dispatch } from "react";
import type { TimelineLayout } from "@studio/timeline";
import type { EditorAction, Selection } from "./state/editor-reducer";
import { Tooltip } from "antd";
import { GripVertical, X } from "lucide-react";
import {
  DndContext, closestCenter, type DragEndEvent, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  SortableContext, horizontalListSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export const PX_PER_SECOND = 30;

function isSelected(selection: Selection, kind: "clip" | "text", id: string): boolean {
  return !!selection && selection.kind === kind && selection.id === id;
}

interface SortableClipProps {
  id: string;
  label: string;
  duration: number;
  hasSection: boolean;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function SortableClip({ id, label, duration, hasSection, selected, onSelect, onRemove }: SortableClipProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    width: Math.max(40, duration * PX_PER_SECOND),
    flexShrink: 0,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`clip-${id}`}
      onClick={onSelect}
      title={label}
      className={`timeline-clip${selected ? " selected" : ""}${hasSection ? " has-section" : ""}`}
    >
      <span {...listeners} {...attributes} style={{ cursor: "grab", display: "flex", alignItems: "center", color: "#fff", opacity: 0.7 }}>
        <GripVertical size={12} />
      </span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "#fff" }}>
        {label}
      </span>
      <Tooltip title="Xóa clip">
        <button
          type="button"
          aria-label="Xóa clip"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "rgba(255,255,255,0.8)", display: "flex", alignItems: "center" }}
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = layout.clips.findIndex((c) => c.clip_id === active.id);
    const to = layout.clips.findIndex((c) => c.clip_id === over.id);
    if (from >= 0 && to >= 0) dispatch({ type: "moveClip", from, to });
  }

  const sectionByClipId = new Map(layout.sections.map((s) => [s.clip_id, s.title]));

  return (
    <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 4, marginTop: 12 }}>
      <div style={{ width, position: "relative" }}>
        {/* Ruler + playhead */}
        <div
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onSeek(Math.min(Math.max(0, (e.clientX - rect.left) / PX_PER_SECOND), layout.duration));
          }}
          style={{ height: 20, background: "#fafafa", cursor: "pointer", position: "relative" }}
        >
          <div
            style={{
              position: "absolute", top: 0, bottom: 0, left: playhead * PX_PER_SECOND, width: 2,
              background: "#f5222d", zIndex: 5,
            }}
          />
        </div>

        {/* Clips row */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={layout.clips.map((c) => c.clip_id)} strategy={horizontalListSortingStrategy}>
            <div style={{ display: "flex", height: 48, borderTop: "1px solid #eee" }}>
              {layout.clips.map((c) => (
                <SortableClip
                  key={c.clip_id}
                  id={c.clip_id}
                  label={c.clip_id}
                  duration={c.duration}
                  hasSection={!!sectionByClipId.get(c.clip_id)}
                  selected={isSelected(selection, "clip", c.clip_id)}
                  onSelect={() => dispatch({ type: "select", selection: { kind: "clip", id: c.clip_id } })}
                  onRemove={() => dispatch({ type: "removeClip", clipId: c.clip_id })}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {/* Texts row */}
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
                height: 20, top: 4,
                background: isSelected(selection, "text", x.text_id) ? "#ad6800" : "#ffe58f",
                borderRadius: 2, fontSize: 10, padding: "0 4px",
                overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", cursor: "pointer",
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
