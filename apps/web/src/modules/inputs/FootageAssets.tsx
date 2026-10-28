import { useMemo, useState, type ReactNode } from "react";
import { Button, Input, Popconfirm, Select, Tag, Tooltip } from "antd";
import { ChevronRight, Film, FolderKanban, Image as ImageIcon, RotateCcw, Trash2 } from "lucide-react";
import { useAiTranslation } from "../common/assistant-name";
import { isFootage, type AssetState, type SourceItem, type Video } from "../../api/workspace-client";
import { withoutIds } from "../common/no-ids";
import { clock } from "../workspace/time";

/** Rows shown before "Show more" (videos of a list, groups, videos of a group). */
export const PAGE = 30;
/** ag-go projects shown before "See all"; past it, a search box too. */
export const PROJECTS_SHOWN = 5;

export type StateFilter = "all" | "not_prepared" | "preparing" | "failed" | "ready";
export const STATE_FILTERS: StateFilter[] = ["all", "not_prepared", "preparing", "failed", "ready"];

/** Where a video stands, as the filter groups it (queued and running are both "preparing"). */
export function stateKey(a: AssetState | null): Exclude<StateFilter, "all"> {
  if (!a) return "not_prepared";
  if (a.state === "ready") return "ready";
  if (a.state === "queued" || a.state === "preparing") return "preparing";
  if (a.state === "failed") return "failed";
  return "not_prepared";
}

export interface Counts { videos: number; ready: number; preparing: number; failed: number; notPrepared: number }

/** Distinct footage (ag-go videos, uploads) by where they stand (the API's `counts`, or the same from rows). */
export function countAssets(items: readonly SourceItem[]): Counts {
  const seen = new Map<string, AssetState | null>();
  for (const s of items) if (isFootage(s) && !seen.has(s.ref)) seen.set(s.ref, s.asset);
  const c: Counts = { videos: seen.size, ready: 0, preparing: 0, failed: 0, notPrepared: 0 };
  for (const a of seen.values()) {
    const k = stateKey(a);
    if (k === "ready") c.ready += 1; else if (k === "preparing") c.preparing += 1; else if (k === "failed") c.failed += 1; else c.notPrepared += 1;
  }
  return c;
}

/** "78 video · 70 ready · 5 preparing · 3 failed": each part filters the list to those videos. */
export function SummaryBar({ counts, onFilter }: { counts: Counts; onFilter: (f: StateFilter) => void }) {
  const { t } = useAiTranslation();
  const parts: { key: StateFilter; n: number; label: string; cls?: string }[] = [
    { key: "ready", n: counts.ready, label: t("ws.inputs.count.ready", { count: counts.ready }), cls: "ws-inputs__stat--ok" },
    { key: "preparing", n: counts.preparing, label: t("ws.inputs.count.preparing", { count: counts.preparing }), cls: "ws-inputs__stat--run" },
    { key: "failed", n: counts.failed, label: t("ws.inputs.count.failed", { count: counts.failed }), cls: "ws-inputs__stat--bad" },
    { key: "not_prepared", n: counts.notPrepared, label: t("ws.inputs.count.notPrepared", { count: counts.notPrepared }) },
  ];
  return (
    <p className="ws-inputs__summary" aria-label={t("ws.inputs.summaryLabel")}>
      <button type="button" className="ws-inputs__stat" onClick={() => onFilter("all")}><strong>{t("ws.inputs.count.videos", { count: counts.videos })}</strong></button>
      {parts.filter((p) => p.n > 0).map((p) => (
        <span key={p.key} className="ws-inputs__statwrap">
          <span aria-hidden> · </span>
          <button type="button" className={`ws-inputs__stat ${p.cls ?? ""}`} onClick={() => onFilter(p.key)}>{p.label}</button>
        </span>
      ))}
    </p>
  );
}

export function AssetLine({ s, canEdit, onOpenFile, onPrepare, onRemove }: {
  s: SourceItem; canEdit: boolean; onOpenFile: (path: string) => void; onPrepare: (assetId: string, again: boolean) => void; onRemove: (s: SourceItem) => void;
}) {
  const { t } = useAiTranslation();
  const a = s.asset;
  const name = withoutIds(s.label, t("ws.inputs.unnamedVideo"));
  const duration = typeof s.meta.durationMs === "number" ? clock((s.meta.durationMs as number) / 1000)
    : a?.state === "ready" && a.duration_s ? clock(a.duration_s) : null;
  const uploaded = s.kind === "upload_asset";
  const Icon = s.mediaType === "image" ? ImageIcon : Film;
  return (
    <li className="ws-inputs__row">
      <Icon size={14} aria-hidden />
      <div className="ws-inputs__text">
        <span className="ws-inputs__name" title={name}>{name}</span>
        <span className="ws-hint">
          {uploaded ? <>{s.mediaType === "image" ? t("ws.inputs.uploadedPhoto") : t("ws.inputs.uploadedVideo")}{duration || a?.state === "ready" ? " · " : ""}</> : null}
          {duration}
          {a?.state === "ready" ? <> · {t("ws.inputs.shots", { count: a.shots ?? 0 })}{a.transcript ? ` · ${t("ws.inputs.withTranscript")}` : ""}</> : null}
          {a?.state === "failed" ? <span className="ws-error"> · {a.error}</span> : null}
        </span>
      </div>
      {a?.state === "ready" ? (
        <button type="button" className="ws-link" onClick={() => onOpenFile(a.readme)}>{t("ws.inputs.open")}</button>
      ) : a?.state === "queued" || a?.state === "preparing" ? (
        <Tag color="blue">{a.state === "queued" ? t("ws.inputs.state.queued") : `${t("ws.inputs.state.preparing")}${a.progress !== null ? ` ${Math.round(a.progress * 100)}%` : ""}`}</Tag>
      ) : canEdit ? (
        <Button size="small" onClick={() => onPrepare(s.ref, false)}>{a?.state === "failed" ? t("ws.inputs.retry") : t("ws.inputs.prepare")}</Button>
      ) : <Tag>{t("ws.inputs.state.notPrepared")}</Tag>}
      {canEdit && a?.state === "ready" ? (
        <Tooltip title={t("ws.inputs.prepareAgain")}><button type="button" className="ws-icon-button" aria-label={t("ws.inputs.prepareAgain")} onClick={() => onPrepare(s.ref, true)}><RotateCcw size={13} /></button></Tooltip>
      ) : null}
      {canEdit ? (
        <Popconfirm title={t("ws.inputs.removeConfirm", { name })} onConfirm={() => onRemove(s)} okText={t("ws.inputs.remove")} cancelText={t("common.cancel")}>
          <button type="button" className="ws-icon-button" aria-label={t("ws.inputs.removeNamed", { name })}><Trash2 size={13} /></button>
        </Popconfirm>
      ) : null}
    </li>
  );
}

/** The ag-go projects the agent searches: compact rows; past five, a search box and "See all". */
export function AgGoProjectList({ projects, canEdit, onRemove }: { projects: SourceItem[]; canEdit: boolean; onRemove: (s: SourceItem) => void }) {
  const { t } = useAiTranslation();
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const needle = q.trim().toLowerCase();
  const matching = needle ? projects.filter((s) => s.label.toLowerCase().includes(needle)) : projects;
  const shown = all || needle ? matching : matching.slice(0, PROJECTS_SHOWN);
  return (
    <>
      {projects.length > PROJECTS_SHOWN ? (
        <Input.Search size="small" allowClear className="ws-inputs__search" placeholder={t("ws.inputs.searchProjects")} aria-label={t("ws.inputs.searchProjects")}
          value={q} onChange={(e) => setQ(e.target.value)} />
      ) : null}
      <ul className="ws-inputs__list ws-inputs__list--compact">
        {shown.map((s) => (
          <li key={s.id} className="ws-inputs__row ws-inputs__row--compact">
            <FolderKanban size={13} aria-hidden />
            <span className="ws-inputs__name" title={s.label}>{s.label}</span>
            {typeof s.meta.videos === "number" ? <span className="ws-hint ws-nowrap">{t("ws.inputs.videoCount", { count: s.meta.videos as number })}</span> : null}
            {canEdit ? (
              <Popconfirm title={t("ws.inputs.removeConfirm", { name: s.label })} onConfirm={() => onRemove(s)} okText={t("ws.inputs.remove")} cancelText={t("common.cancel")}>
                <button type="button" className="ws-icon-button" aria-label={t("ws.inputs.removeNamed", { name: s.label })}><Trash2 size={13} /></button>
              </Popconfirm>
            ) : null}
          </li>
        ))}
      </ul>
      {needle && !matching.length ? <p className="ws-hint">{t("ws.inputs.noProjectMatch")}</p> : null}
      {!needle && projects.length > PROJECTS_SHOWN ? (
        <button type="button" className="ws-link ws-inputs__more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t("ws.inputs.showFewer") : t("ws.inputs.seeAllProjects", { count: projects.length })}
        </button>
      ) : null}
    </>
  );
}

function ShowMore({ total, shown, onMore }: { total: number; shown: number; onMore: () => void }) {
  const { t } = useAiTranslation();
  if (shown >= total) return null;
  return <button type="button" className="ws-link ws-inputs__more" onClick={onMore}>{t("ws.inputs.showMore", { count: total - shown })}</button>;
}

/** One Studio video's ag-go videos on the project page: count, how they stand together, folding. */
function AssetGroup({ title, rows, open, onToggle, line }: {
  title: string; rows: SourceItem[]; open: boolean; onToggle: () => void; line: (s: SourceItem) => ReactNode;
}) {
  const { t } = useAiTranslation();
  const [limit, setLimit] = useState(PAGE);
  const c = countAssets(rows);
  const overall: Exclude<StateFilter, "all"> = c.failed ? "failed" : c.preparing ? "preparing" : c.notPrepared ? "not_prepared" : "ready";
  const color = { failed: "red", preparing: "blue", not_prepared: "default", ready: "green" }[overall];
  return (
    <li className="ws-inputs__group">
      <button type="button" className="ws-inputs__grouphead" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={13} className="ws-inputs__chevron" aria-hidden />
        <span className="ws-inputs__name" title={title}>{title}</span>
        <span className="ws-hint ws-nowrap">{t("ws.inputs.count.videos", { count: rows.length })}</span>
        <Tag color={color} className="ws-inputs__grouptag">{t(`ws.inputs.filter.${overall}`)}</Tag>
      </button>
      {open ? (
        <>
          <ul className="ws-inputs__list ws-inputs__grouplist">{rows.slice(0, limit).map(line)}</ul>
          <ShowMore total={rows.length} shown={Math.min(limit, rows.length)} onMore={() => setLimit(limit + PAGE)} />
        </>
      ) : null}
    </li>
  );
}

/**
 * The ag-go videos of a video (or, on the project page, of every video, grouped by Studio video): a search box, a filter
 * by where they stand, 30 at a time, and in bulk "prepare those not prepared" and "retry those that failed".
 */
export function FootageAssets({ assets, videos, grouped, filter, onFilter, canEdit, onOpenFile, onPrepare, onRemove, onBulk, bulkBusy }: {
  assets: SourceItem[];
  /** Studio videos (titles for the groups). */
  videos: Video[];
  grouped: boolean;
  filter: StateFilter;
  onFilter: (f: StateFilter) => void;
  canEdit: boolean;
  onOpenFile: (path: string) => void;
  onPrepare: (assetId: string, again: boolean) => void;
  onRemove: (s: SourceItem) => void;
  onBulk: (assetIds: string[]) => void;
  bulkBusy: boolean;
}) {
  const { t } = useAiTranslation();
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const needle = q.trim().toLowerCase();
  const matches = (s: SourceItem) => (filter === "all" || stateKey(s.asset) === filter)
    && (!needle || withoutIds(s.label, "").toLowerCase().includes(needle));
  const distinct = useMemo(() => {
    const m = new Map<string, SourceItem>();
    for (const s of assets) if (!m.has(s.ref)) m.set(s.ref, s);
    return [...m.values()];
  }, [assets]);
  const notPrepared = distinct.filter((s) => stateKey(s.asset) === "not_prepared").map((s) => s.ref);
  const failed = distinct.filter((s) => stateKey(s.asset) === "failed").map((s) => s.ref);
  const line = (s: SourceItem) => <AssetLine key={s.id} s={s} canEdit={canEdit} onOpenFile={onOpenFile} onPrepare={onPrepare} onRemove={onRemove} />;

  const groups = useMemo(() => {
    if (!grouped) return [];
    const order = new Map(videos.map((v) => [v.id, v]));
    const by = new Map<string, SourceItem[]>();
    for (const s of assets) {
      const key = s.videoId ?? "";
      const rows = by.get(key) ?? [];
      if (!rows.some((r) => r.ref === s.ref)) rows.push(s);
      by.set(key, rows);
    }
    return [...by.entries()]
      .map(([key, rows]) => ({ key, rows, idx: key ? order.get(key)?.idx ?? Number.MAX_SAFE_INTEGER : -1, video: key ? order.get(key) : undefined }))
      .sort((a, b) => a.idx - b.idx);
  }, [assets, videos, grouped]);

  const filtering = filter !== "all" || !!needle;
  const toolbar = (
    <div className="ws-inputs__toolbar">
      <Input.Search size="small" allowClear className="ws-inputs__search" placeholder={t("ws.inputs.searchList")} aria-label={t("ws.inputs.searchList")}
        value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
      <Select size="small" value={filter} onChange={(v) => { onFilter(v); setLimit(PAGE); }} aria-label={t("ws.inputs.filterLabel")} className="ws-inputs__filter"
        popupMatchSelectWidth={false} options={STATE_FILTERS.map((f) => ({ value: f, label: t(`ws.inputs.filter.${f}`) }))} />
    </div>
  );
  const bulk = canEdit && (notPrepared.length || failed.length) ? (
    <div className="ws-inputs__bulk">
      {notPrepared.length ? (
        <Popconfirm title={t("ws.inputs.prepareAllConfirm", { count: notPrepared.length })} onConfirm={() => onBulk(notPrepared)} okText={t("ws.inputs.prepare")} cancelText={t("common.cancel")}>
          <Button size="small" loading={bulkBusy}>{t("ws.inputs.prepareAll", { count: notPrepared.length })}</Button>
        </Popconfirm>
      ) : null}
      {failed.length ? (
        <Popconfirm title={t("ws.inputs.retryAllConfirm", { count: failed.length })} onConfirm={() => onBulk(failed)} okText={t("ws.inputs.retry")} cancelText={t("common.cancel")}>
          <Button size="small" icon={<RotateCcw size={14} />} loading={bulkBusy}>{t("ws.inputs.retryAll", { count: failed.length })}</Button>
        </Popconfirm>
      ) : null}
    </div>
  ) : null;

  if (!grouped) {
    const rows = assets.filter(matches);
    return (
      <>
        {toolbar}
        {bulk}
        {rows.length ? <ol className="ws-inputs__list">{rows.slice(0, limit).map(line)}</ol> : <p className="ws-hint">{t("ws.inputs.noVideos")}</p>}
        <ShowMore total={rows.length} shown={Math.min(limit, rows.length)} onMore={() => setLimit(limit + PAGE)} />
      </>
    );
  }
  const visible = groups.map((g) => ({ ...g, rows: g.rows.filter(matches) })).filter((g) => g.rows.length);
  const titleOf = (g: (typeof visible)[number]) => !g.key ? t("ws.inputs.group.shared")
    : g.video ? `${g.video.idx}. ${withoutIds(g.video.title, t("ws.inputs.group.untitled"))}` : t("ws.inputs.group.gone");
  return (
    <>
      {toolbar}
      {bulk}
      {visible.length ? (
        <ul className="ws-inputs__list ws-inputs__groups">
          {visible.slice(0, limit).map((g) => (
            <AssetGroup key={g.key || "shared"} title={titleOf(g)} rows={g.rows} line={line}
              open={open[g.key] ?? (filtering || visible.length === 1)} onToggle={() => setOpen({ ...open, [g.key]: !(open[g.key] ?? (filtering || visible.length === 1)) })} />
          ))}
        </ul>
      ) : <p className="ws-hint">{t("ws.inputs.noVideos")}</p>}
      <ShowMore total={visible.length} shown={Math.min(limit, visible.length)} onMore={() => setLimit(limit + PAGE)} />
    </>
  );
}
