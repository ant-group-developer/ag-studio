import { useEffect, useRef, useState } from "react";

export interface DayValue { day: string; value: number }

const HEIGHT = 180;
const PAD = { top: 12, right: 8, bottom: 22, left: 52 };
const MAX_BAR = 24;
const GAP = 2;

/** A round step at or above `max` for the axis (1, 2, 5 × 10ⁿ). */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].find((m) => m * p >= max)!;
  return step * p;
}

/** A column with a 4px rounded top, square at the baseline. */
function column(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * One measure by day as columns (one series, so no legend: the title names it): hairline grid, the axis in muted
 * ink, a tooltip on hover or focus with the day and the value. Every day of the period has a slot, zero or not.
 */
export function DailyBars({ data, format, label, dayLabel }: {
  data: DayValue[]; format: (v: number) => string; label: string; dayLabel: (day: string) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { if (e) setWidth(Math.max(280, Math.round(e.contentRect.width))); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const top = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const slot = data.length ? plotW / data.length : plotW;
  const barW = Math.max(2, Math.min(MAX_BAR, slot - GAP));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const xLabels = data.length ? [...new Set([0, Math.floor((data.length - 1) / 2), data.length - 1])] : [];
  const h = hover !== null ? data[hover] : undefined;

  return (
    <div className="ws-bars" ref={box}>
      <svg width={width} height={HEIGHT} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="ws-bars__grid" />
            <text x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="ws-bars__axis">{format(v)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const bh = Math.max(0, PAD.top + plotH - y(d.value));
          return (
            <g key={d.day}>
              {bh > 0 ? <path d={column(x, y(d.value), barW, bh)} className={`ws-bars__bar${hover === i ? " ws-bars__bar--on" : ""}`} /> : null}
              {/* the hit target is the whole slot, taller and wider than the mark */}
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent" tabIndex={0}
                aria-label={`${dayLabel(d.day)}: ${format(d.value)}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
            </g>
          );
        })}
        {xLabels.map((i) => (
          <text key={i} x={PAD.left + i * slot + slot / 2} y={HEIGHT - 6} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"} className="ws-bars__axis">
            {dayLabel(data[i]!.day)}
          </text>
        ))}
      </svg>
      {h && hover !== null ? (
        <div className="ws-bars__tip" role="status" style={{ left: Math.min(width - 140, Math.max(0, PAD.left + hover * slot + slot / 2 - 60)), top: Math.max(0, y(h.value) - 44) }}>
          <span>{dayLabel(h.day)}</span>
          <strong>{format(h.value)}</strong>
        </div>
      ) : null}
    </div>
  );
}
