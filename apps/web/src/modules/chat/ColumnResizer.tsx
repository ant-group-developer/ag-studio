import { useCallback, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

export type Column = "nav" | "aside";

/** How wide each column may get (px), and the room the chat in the middle always keeps. */
export const COLUMN_LIMITS: Record<Column, { min: number; max: number }> = { nav: { min: 220, max: 520 }, aside: { min: 300, max: 900 } };
const MAIN_MIN = 380;
const STEP = 16;
const STORE_KEY = "ag-studio.chat.columns";

type Widths = Partial<Record<Column, number>>;

function load(): Widths {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "{}") as Widths;
    const out: Widths = {};
    for (const c of ["nav", "aside"] as const) if (typeof raw[c] === "number") out[c] = raw[c];
    return out;
  } catch {
    return {};
  }
}

function save(w: Widths) {
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(w)); } catch { /* a private window: widths last for this visit */ }
}

/** A width the column may take now: its limits, and the chat in the middle keeps `MAIN_MIN`. */
export function clampWidth(column: Column, width: number, bodyWidth: number, other: number): number {
  const { min, max } = COLUMN_LIMITS[column];
  const room = bodyWidth > 0 ? bodyWidth - other - MAIN_MIN : max;
  return Math.round(Math.max(min, Math.min(max, room, width)));
}

/**
 * The widths the person dragged the side columns to, kept in this browser. Unset means the stylesheet's
 * default (it follows the screen width).
 */
export function useColumnWidths() {
  const [widths, setWidths] = useState<Widths>(load);
  const set = useCallback((column: Column, width: number | undefined, persist: boolean) => {
    setWidths((w) => {
      const next = { ...w };
      if (width === undefined) delete next[column];
      else next[column] = width;
      if (persist) save(next);
      return next;
    });
  }, []);
  return { widths, set };
}

interface Props {
  column: Column;
  /** The body the columns sit in (to measure the room left for the chat). */
  body: () => HTMLElement | null;
  onResize: (width: number | undefined, persist: boolean) => void;
}

function measure(body: HTMLElement | null, column: Column) {
  const el = body?.querySelector<HTMLElement>(column === "nav" ? ":scope > .chat-nav" : ":scope > .chat-aside");
  const other = body?.querySelector<HTMLElement>(column === "nav" ? ":scope > .chat-aside" : ":scope > .chat-nav");
  return { width: el?.getBoundingClientRect().width ?? 0, other: other?.getBoundingClientRect().width ?? 0, body: body?.getBoundingClientRect().width ?? 0 };
}

/** The handle on a side column's inner edge: drag, or ←/→ when focused; a double click goes back to the default width. */
export function ColumnResizer({ column, body, onResize }: Props) {
  const { t } = useTranslation();
  const [drag, setDrag] = useState<{ x: number; width: number; other: number; body: number; last: number } | null>(null);
  // the nav grows to the right, the result pane to the left
  const sign = column === "nav" ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const m = measure(body(), column);
    e.currentTarget.setPointerCapture(e.pointerId);
    window.getSelection()?.removeAllRanges();
    setDrag({ x: e.clientX, width: m.width, other: m.other, body: m.body, last: m.width });
    document.body.classList.add("chat-resizing");
  };
  const widthAt = (x: number) => (drag ? clampWidth(column, drag.width + sign * (x - drag.x), drag.body, drag.other) : 0);
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const next = widthAt(e.clientX);
    if (next === drag.last) return;
    setDrag({ ...drag, last: next });
    onResize(next, false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("chat-resizing");
    onResize(e.type === "pointercancel" ? drag.last : widthAt(e.clientX), true);
    setDrag(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const m = measure(body(), column);
    onResize(clampWidth(column, m.width + sign * dir * STEP, m.body, m.other), true);
  };

  return (
    <div
      role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={t(column === "nav" ? "chat.resize.nav" : "chat.resize.aside")} title={t("chat.resize.hint")}
      aria-valuemin={COLUMN_LIMITS[column].min} aria-valuemax={COLUMN_LIMITS[column].max}
      className={`chat-resizer chat-resizer--${column}${drag ? " chat-resizer--dragging" : ""}`}
      onMouseDown={(e) => e.preventDefault()} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end}
      onDoubleClick={() => onResize(undefined, true)} onKeyDown={onKeyDown}
    />
  );
}
