import { useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Button, Checkbox, Empty, Input, Modal, Pagination, Radio, Spin, Table, Tag, type TableColumnsType } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Filter, Mic, MicOff } from "lucide-react";
import { useAiTranslation } from "../common/assistant-name";
import type { AgGoProjectSort } from "../../api/ag-go-client";
import { StudioHttpError } from "../../api/http";
import {
  FOOTAGE_ORIENTATIONS, FOOTAGE_RESOLUTIONS, FOOTAGE_SORTS, FOOTAGE_TIMES_OF_DAY, useWorkspaceClient, type FacetValue, type FootageFilters,
  type FootageItem, type FootageSort, type FootageUsability, type SourceItem,
} from "../../api/workspace-client";
import { stickyIn } from "../../helpers/sticky-table-header";
import { clock } from "../workspace/time";
import { CheckList, FilterPanel, SortControl, useDebounced, useViewMode, ViewModeToggle, type FilterSection, type Option } from "./picker/PickerParts";

const errorText = (e: unknown, fallback: string) => (e instanceof StudioHttpError ? e.message : fallback);
const FOOTAGE_PAGE = 40;
/** A modal as wide as ag-go's own pages allow on this screen. */
const WIDE = "min(1200px, 96vw)";

function useSortLabels() {
  const { t } = useAiTranslation();
  return {
    updatedAt: t("ws.inputs.picker.sort.updatedAt"), createdAt: t("ws.inputs.picker.sort.createdAt"), name: t("ws.inputs.picker.sort.name"),
    folder: t("ws.inputs.picker.sort.folder"), relevance: t("ws.inputs.picker.sort.relevance"), analyzedAt: t("ws.inputs.picker.sort.analyzedAt"),
    quality: t("ws.inputs.picker.sort.quality"), duration: t("ws.inputs.picker.sort.duration"), resolution: t("ws.inputs.picker.sort.resolution"),
    project: t("ws.inputs.picker.sort.project"),
  } as Record<AgGoProjectSort | FootageSort, string>;
}

function FilterToggle({ open, onToggle, active }: { open: boolean; onToggle: () => void; active: number }) {
  const { t } = useAiTranslation();
  return (
    <Button icon={<Filter size={14} />} type={open ? "default" : active ? "primary" : "default"} aria-pressed={open} onClick={onToggle}>
      {t("ws.inputs.picker.filters")}{active ? ` (${active})` : ""}
    </Button>
  );
}

// ---------------------------------------------------------------- footage

const NO_FOOTAGE_FILTERS: FootageFilters = { usability: "usable" };
const DURATIONS = {
  any: {}, under10: { maxDurationMs: 10_000 }, s10to30: { minDurationMs: 10_000, maxDurationMs: 30_000 },
  s30to60: { minDurationMs: 30_000, maxDurationMs: 60_000 }, m1to3: { minDurationMs: 60_000, maxDurationMs: 180_000 }, over3: { minDurationMs: 180_000 },
} as const;
type DurationKey = keyof typeof DURATIONS;
const durationOf = (f: FootageFilters): DurationKey =>
  (Object.keys(DURATIONS) as DurationKey[]).find((k) => {
    const d = DURATIONS[k] as { minDurationMs?: number; maxDurationMs?: number };
    return d.minDurationMs === f.minDurationMs && d.maxDurationMs === f.maxDurationMs;
  }) ?? "any";
const RESOLUTION_LABEL: Record<string, string> = { "4k": "4K", "2k": "2K", "1080p": "1080p", "720p": "720p", sd: "SD" };

/** Options of a facet: ag-go's values with their counts (`labels` names fixed vocabularies, in their order). */
function facetOptions(values: FacetValue[] | undefined, labels?: Record<string, string>): Option[] {
  const count = new Map((values ?? []).map((v) => [v.value, v.count]));
  if (labels) return Object.entries(labels).map(([value, label]) => ({ value, label, count: count.get(value) ?? 0 }));
  return (values ?? []).map((v) => ({ value: v.value, label: v.label ?? v.value, count: v.count }));
}

function PreparedTag({ item }: { item: FootageItem }) {
  const { t } = useAiTranslation();
  const s = item.prepared.state;
  return s === "ready" ? <Tag color="green">{t("ws.inputs.state.ready")}</Tag>
    : s === "queued" || s === "preparing" ? <Tag color="blue">{t("ws.inputs.state.preparing")}</Tag> : null;
}

function Speech({ item }: { item: FootageItem }) {
  const { t } = useAiTranslation();
  return item.hasSpeech === true ? <Mic size={12} aria-label={t("ws.inputs.hasSpeech")} />
    : item.hasSpeech === false ? <MicOff size={12} aria-label={t("ws.inputs.noSpeech")} /> : null;
}

const frame = (it: FootageItem) => (it.width && it.height ? `${it.width}×${it.height}` : "");

/**
 * Picks ag-go videos for one video, from the project's ag-go projects (as the person sees them): ag-go's footage
 * filters with their counts, sort, pages, a table or a grid; tick, then "add and prepare" — each is added in the order
 * ticked (across pages and views) and prepared in the background.
 */
export function FootagePicker({ projectId, videoId, sources, open, onClose }: {
  projectId: string; videoId: string; sources: SourceItem[]; open: boolean; onClose: () => void;
}) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const sortLabels = useSortLabels();
  const [view, setView] = useViewMode("studio.picker.footage.viewMode");
  // the table scrolls inside the picker box: its header sticks to the box
  const box = useRef<HTMLDivElement>(null);
  const sticky = useMemo(() => stickyIn(box), []);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const projects = sources.filter((s) => s.kind === "ag_go_project");
  const pickedProjects = new Set(projects.map((p) => p.ref));
  const inVideo = new Set(sources.filter((s) => s.kind === "ag_go_asset" && s.videoId === videoId).map((s) => s.ref));
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const [filters, setFilters] = useState<FootageFilters>(NO_FOOTAGE_FILTERS);
  const [sort, setSort] = useState<{ by: FootageSort; order: "asc" | "desc" }>({ by: "relevance", order: "desc" });
  const [page, setPage] = useState(1);
  const [ticked, setTicked] = useState<FootageItem[]>([]);
  useEffect(() => { if (open) { setTicked([]); setText(""); setFilters(NO_FOOTAGE_FILTERS); setPage(1); } }, [open]);
  useEffect(() => setPage(1), [q, filters, sort]);

  const scoped: FootageFilters = { ...filters, ...(q ? { q } : {}) };
  const enabled = open && projects.length > 0;
  const facets = useQuery({
    queryKey: ["footageFacets", projectId, scoped], queryFn: () => client.getFootageFacets(projectId, scoped), enabled, retry: false, placeholderData: (prev) => prev,
  });
  const found = useQuery({
    queryKey: ["footage", projectId, scoped, sort, page],
    queryFn: () => client.searchFootage(projectId, { ...scoped, sortBy: sort.by, sortOrder: sort.order, page, limit: FOOTAGE_PAGE }),
    enabled, placeholderData: (prev) => prev,
  });
  const items = useMemo(() => found.data?.items ?? [], [found.data]);
  const isTicked = (it: FootageItem) => ticked.some((x) => x.assetId === it.assetId);
  const toggle = (it: FootageItem) => setTicked((xs) => (xs.some((x) => x.assetId === it.assetId) ? xs.filter((x) => x.assetId !== it.assetId) : [...xs, it]));
  const add = useMutation({
    mutationFn: async () => {
      const failed: string[] = [];
      for (const it of ticked) {
        const from = it.projectIds?.find((p) => pickedProjects.has(p));
        try {
          await client.addSource(projectId, {
            kind: "ag_go_asset", ref: it.assetId, label: it.name, videoId, prepare: true,
            meta: { durationMs: it.durationMs, ...(from ? { agGoProjectId: from } : {}), ...(it.thumbnailUrl ? { thumbnailUrl: it.thumbnailUrl } : {}) },
          });
        } catch (e) {
          failed.push(e instanceof StudioHttpError && e.code === "not_in_added_project" ? t("ws.inputs.notInAddedProject", { name: it.name }) : `${it.name}: ${errorText(e, t("ws.inputs.addFailed"))}`);
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      void qc.invalidateQueries({ queryKey: ["sources", projectId] });
      void qc.invalidateQueries({ queryKey: ["jobs", projectId] });
      void qc.invalidateQueries({ queryKey: ["activity", projectId] });
      void qc.invalidateQueries({ queryKey: ["playbook", projectId] });
      if (failed.length) void message.warning(failed.join("\n"));
      else void message.success(t("ws.inputs.videosAdded", { count: ticked.length }));
      onClose();
    },
  });

  const set = (patch: Partial<FootageFilters>) => setFilters((f) => {
    const next: FootageFilters = { ...f, ...patch };
    for (const k of Object.keys(next) as (keyof FootageFilters)[]) if (next[k] === undefined) delete next[k];
    return next;
  });
  const list = (key: "agGoProjectIds" | "categoryIds" | "provinceIds" | "ownerUserIds" | "resolutions" | "orientations" | "timesOfDay" | "genres" | "tags") => ({
    value: filters[key] ?? [],
    onChange: (v: string[]) => set({ [key]: v.length ? v : undefined }),
    active: filters[key]?.length ?? 0,
  });
  const f = facets.data;
  const projectOptions: Option[] = f?.projects.length
    ? f.projects.map((p) => ({ value: p.value, label: p.label ?? p.value, count: p.count }))
    : projects.map((p) => ({ value: p.ref, label: p.label }));
  const section = (key: string, title: string, l: ReturnType<typeof list>, options: Option[]): FilterSection =>
    ({ key, title, active: l.active, body: <CheckList label={title} options={options} value={l.value} onChange={l.onChange} /> });
  const duration = durationOf(filters);
  const usability = filters.usability ?? "usable";
  const sections: FilterSection[] = [
    section("project", t("ws.inputs.picker.section.project"), list("agGoProjectIds"), projectOptions),
    { key: "usability", title: t("ws.inputs.picker.section.usability"), active: usability === "usable" ? 0 : 1, body: (
      <Radio.Group className="ws-filter__list" value={usability} onChange={(e) => set({ usability: e.target.value as FootageUsability })} aria-label={t("ws.inputs.picker.section.usability")}
        options={[
          { value: "usable", label: t("ws.inputs.picker.usability.usable") },
          { value: "all", label: t("ws.inputs.picker.usability.all") },
          { value: "unusable", label: t("ws.inputs.picker.usability.unusable") },
        ]} />
    ) },
    { key: "duration", title: t("ws.inputs.picker.section.duration"), active: duration === "any" ? 0 : 1, body: (
      <Radio.Group className="ws-filter__list" value={duration} aria-label={t("ws.inputs.picker.section.duration")}
        onChange={(e) => set({ minDurationMs: undefined, maxDurationMs: undefined, ...DURATIONS[e.target.value as DurationKey] })}
        options={[
          { value: "any", label: t("ws.inputs.picker.duration.any") }, { value: "under10", label: t("ws.inputs.picker.duration.under10") },
          { value: "s10to30", label: t("ws.inputs.picker.duration.s10to30") }, { value: "s30to60", label: t("ws.inputs.picker.duration.s30to60") },
          { value: "m1to3", label: t("ws.inputs.picker.duration.m1to3") }, { value: "over3", label: t("ws.inputs.picker.duration.over3") },
        ]} />
    ) },
    section("category", t("ws.inputs.picker.section.category"), list("categoryIds"), facetOptions(f?.categories)),
    section("province", t("ws.inputs.picker.section.province"), list("provinceIds"), facetOptions(f?.provinces)),
    section("author", t("ws.inputs.picker.section.author"), list("ownerUserIds"), facetOptions(f?.authors)),
    section("resolution", t("ws.inputs.picker.section.resolution"), list("resolutions"),
      facetOptions(f?.resolutions, Object.fromEntries(FOOTAGE_RESOLUTIONS.map((r) => [r, RESOLUTION_LABEL[r]!])))),
    section("orientation", t("ws.inputs.picker.section.orientation"), list("orientations"), facetOptions(f?.orientations, {
      landscape: t("ws.inputs.picker.orientation.landscape"), portrait: t("ws.inputs.picker.orientation.portrait"), square: t("ws.inputs.picker.orientation.square"),
    } satisfies Record<(typeof FOOTAGE_ORIENTATIONS)[number], string>)),
    section("timeOfDay", t("ws.inputs.picker.section.timeOfDay"), list("timesOfDay"), facetOptions(f?.timesOfDay, {
      day: t("ws.inputs.picker.timeOfDay.day"), night: t("ws.inputs.picker.timeOfDay.night"), golden_hour: t("ws.inputs.picker.timeOfDay.golden_hour"),
      indoor: t("ws.inputs.picker.timeOfDay.indoor"), mixed: t("ws.inputs.picker.timeOfDay.mixed"), unknown: t("ws.inputs.picker.timeOfDay.unknown"),
    } satisfies Record<(typeof FOOTAGE_TIMES_OF_DAY)[number], string>)),
    section("genre", t("ws.inputs.picker.section.genre"), list("genres"), facetOptions(f?.genres)),
    section("tags", t("ws.inputs.picker.section.tags"), list("tags"), facetOptions(f?.tags)),
  ];
  const activeFilters = sections.filter((s) => s.active).length;

  const check = (it: FootageItem) => (
    <Checkbox checked={inVideo.has(it.assetId) || isTicked(it)} disabled={inVideo.has(it.assetId)} onChange={() => toggle(it)} aria-label={it.name} />
  );
  const columns: TableColumnsType<FootageItem> = [
    { key: "check", width: 36, render: (_, it) => check(it) },
    { key: "name", title: t("ws.inputs.picker.column.name"), render: (_, it) => (
      <div className="ws-picker__row ws-picker__row--cell">
        {it.thumbnailUrl ? <img className="ws-picker__thumb" src={it.thumbnailUrl} alt="" loading="lazy" /> : <span className="ws-picker__thumb" aria-hidden />}
        <div className="ws-picker__text">
          <strong>{it.name} <Speech item={it} /></strong>
          {it.summaryVi ? <span className="ws-picker__summary">{it.summaryVi}</span> : null}
        </div>
      </div>
    ) },
    { key: "duration", title: t("ws.inputs.picker.column.duration"), width: 90, render: (_, it) => clock(it.durationMs / 1000) },
    { key: "frame", title: t("ws.inputs.picker.column.frame"), width: 110, render: (_, it) => frame(it) || "—" },
    { key: "projects", title: t("ws.inputs.picker.column.projects"), width: 160, render: (_, it) => <span className="ws-hint">{(it.projectNames ?? []).join(", ")}</span> },
    { key: "state", title: t("ws.inputs.picker.column.state"), width: 120, render: (_, it) => <PreparedTag item={it} /> },
  ];

  return (
    <Modal open={open} title={t("ws.inputs.pickVideosTitle")} onCancel={onClose} destroyOnHidden width={WIDE}
      okText={t("ws.inputs.addAndPrepare", { count: ticked.length })} okButtonProps={{ disabled: !ticked.length }} confirmLoading={add.isPending}
      onOk={() => add.mutate()} cancelText={t("common.cancel")}>
      {projects.length === 0 ? <p className="ws-hint">{t("ws.inputs.noAgGoProject")}</p> : (
        <div className={`ws-picker2${filtersOpen ? "" : " ws-picker2--nofilters"}`}>
          {filtersOpen ? <FilterPanel sections={sections} onClear={() => setFilters(NO_FOOTAGE_FILTERS)} /> : null}
          <section className="ws-picker2__main">
            <div className="ws-picker__bar">
              <Input.Search allowClear value={text} onChange={(e) => setText(e.target.value)} placeholder={t("ws.inputs.searchVideos")} aria-label={t("ws.inputs.searchVideos")} />
              <SortControl options={FOOTAGE_SORTS.map((s) => ({ value: s, label: sortLabels[s] }))} value={sort.by} order={sort.order}
                onChange={(by, order) => setSort({ by, order })} />
              <FilterToggle open={filtersOpen} active={activeFilters} onToggle={() => setFiltersOpen((o) => !o)} />
              <ViewModeToggle value={view} onChange={setView} />
            </div>
            <div className="ws-picker" aria-busy={found.isFetching} ref={box}>
              {found.isLoading ? <div className="ws-center"><Spin /></div> : found.error ? <p className="ws-error">{errorText(found.error, t("ws.inputs.agGoUnavailable"))}</p>
                : !items.length ? <Empty description={t("ws.inputs.noVideos")} />
                : view === "table" ? <Table<FootageItem> rowKey="assetId" size="small" columns={columns} dataSource={items} pagination={false} scroll={{ x: 800 }} sticky={sticky} />
                : (
                  <ul className="ws-picker__grid">
                    {items.map((it) => (
                      <li key={it.assetId} className={`ws-picker__card${isTicked(it) ? " ws-picker__card--on" : ""}`}>
                        <span className="ws-picker__check">{check(it)}</span>
                        {it.thumbnailUrl ? <img className="ws-picker__cover" src={it.thumbnailUrl} alt="" loading="lazy" />
                          : <span className="ws-picker__cover" aria-hidden><Film size={28} /></span>}
                        <strong className="ws-picker__cardtitle">{it.name}</strong>
                        <span className="ws-hint">{[clock(it.durationMs / 1000), frame(it)].filter(Boolean).join(" · ")} <Speech item={it} /></span>
                        <span className="ws-picker__cardaction"><PreparedTag item={it} /></span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
            {found.data && found.data.total > FOOTAGE_PAGE ? (
              <Pagination className="ws-picker__pages" size="small" current={page} pageSize={FOOTAGE_PAGE} total={found.data.total} showSizeChanger={false}
                showTotal={(n) => t("ws.inputs.picker.total", { count: n })} onChange={setPage} />
            ) : null}
            {ticked.length ? <p className="ws-hint">{t("ws.inputs.tickedOrder", { names: ticked.map((x) => x.name).join(", ") })}</p> : null}
          </section>
        </div>
      )}
    </Modal>
  );
}
