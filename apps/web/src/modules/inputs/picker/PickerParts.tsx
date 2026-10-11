/**
 * Pieces both pickers of the Inputs tab share, after ag-go's own Projects and Footage pages: a table/grid switch
 * remembered per picker, a column of filter sections (checkbox lists with a search box, counts from ag-go), and the
 * sort control.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Checkbox, Collapse, Input, Segmented, Select } from "antd";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, LayoutGrid, List } from "lucide-react";
import { useAiTranslation } from "../../common/assistant-name";

export type ViewMode = "table" | "grid";

function readView(key: string, fallback: ViewMode): ViewMode {
  try {
    const v = localStorage.getItem(key);
    return v === "table" || v === "grid" ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Table or grid, kept in this browser per picker (`studio.picker.<name>.viewMode`). */
export function useViewMode(key: string, fallback: ViewMode = "table"): [ViewMode, (v: ViewMode) => void] {
  const [view, setView] = useState<ViewMode>(() => readView(key, fallback));
  const set = (v: ViewMode) => {
    setView(v);
    try { localStorage.setItem(key, v); } catch { /* private window: this visit only */ }
  };
  return [view, set];
}

export function ViewModeToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const { t } = useAiTranslation();
  return (
    <Segmented<ViewMode>
      aria-label={t("ws.inputs.picker.viewLabel")}
      value={value}
      onChange={onChange}
      options={[
        { value: "table", icon: <List size={14} />, title: t("ws.inputs.picker.table"), label: <span className="ws-sr">{t("ws.inputs.picker.table")}</span> },
        { value: "grid", icon: <LayoutGrid size={14} />, title: t("ws.inputs.picker.grid"), label: <span className="ws-sr">{t("ws.inputs.picker.grid")}</span> },
      ]}
    />
  );
}

export interface Option { value: string; label: string; count?: number | null }

/** Ticks among options; a search box when there are many. Picked values ag-go no longer counts stay listed. */
export function CheckList({ options, value, onChange, label }: { options: Option[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  const { t } = useAiTranslation();
  const [find, setFind] = useState("");
  const all = useMemo((): Option[] => {
    const known = new Set(options.map((o) => o.value));
    return [...options, ...value.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }))];
  }, [options, value]);
  const shown = find.trim() ? all.filter((o) => o.label.toLowerCase().includes(find.trim().toLowerCase())) : all;
  if (!all.length) return <p className="ws-hint">{t("ws.inputs.picker.noOptions")}</p>;
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="ws-filter__list" role="group" aria-label={label}>
      {all.length > 8 ? (
        <Input size="small" allowClear placeholder={t("ws.inputs.picker.findOption")} value={find} onChange={(e) => setFind(e.target.value)}
          aria-label={`${label}: ${t("ws.inputs.picker.findOption")}`} />
      ) : null}
      {shown.map((o) => (
        <Checkbox key={o.value} checked={value.includes(o.value)} onChange={() => toggle(o.value)} className="ws-filter__option">
          <span className="ws-filter__label">{o.label}</span>
          {o.count != null ? <span className="ws-filter__count">{o.count}</span> : null}
        </Checkbox>
      ))}
    </div>
  );
}

export interface FilterSection { key: string; title: string; active: number; body: ReactNode }

/** The filter column: one collapsible section per filter, how many are on, and "clear". */
export function FilterPanel({ sections, onClear }: { sections: FilterSection[]; onClear: () => void }) {
  const { t } = useAiTranslation();
  const on = sections.reduce((n, s) => n + (s.active ? 1 : 0), 0);
  return (
    <aside className="ws-filter" aria-label={t("ws.inputs.picker.filters")}>
      <div className="ws-filter__head">
        <strong>{t("ws.inputs.picker.filters")}</strong>
        {on ? <Badge count={on} size="small" /> : null}
        <Button size="small" type="link" disabled={!on} onClick={onClear}>{t("ws.inputs.picker.clearFilters")}</Button>
      </div>
      <Collapse
        size="small"
        ghost
        defaultActiveKey={sections.slice(0, 3).map((s) => s.key)}
        items={sections.map((s) => ({
          key: s.key,
          label: <span>{s.title}{s.active ? <Badge count={s.active} size="small" style={{ marginLeft: 6 }} /> : null}</span>,
          children: s.body,
        }))}
      />
    </aside>
  );
}

/** A sort field among `options` and its direction. */
export function SortControl<T extends string>({ options, value, order, onChange }: {
  options: { value: T; label: string }[]; value: T; order: "asc" | "desc"; onChange: (v: T, order: "asc" | "desc") => void;
}) {
  const { t } = useAiTranslation();
  return (
    <span className="ws-picker__sort">
      <Select<T> size="middle" value={value} onChange={(v) => onChange(v, order)} options={options} aria-label={t("ws.inputs.picker.sortLabel")} style={{ minWidth: 150 }} />
      <Button
        icon={order === "asc" ? <ArrowUpNarrowWide size={14} /> : <ArrowDownWideNarrow size={14} />}
        aria-label={order === "asc" ? t("ws.inputs.picker.asc") : t("ws.inputs.picker.desc")}
        title={order === "asc" ? t("ws.inputs.picker.asc") : t("ws.inputs.picker.desc")}
        onClick={() => onChange(value, order === "asc" ? "desc" : "asc")}
      />
    </span>
  );
}

/** `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
