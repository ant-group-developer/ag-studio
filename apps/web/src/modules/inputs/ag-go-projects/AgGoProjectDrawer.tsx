import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Alert, App as AntApp, Avatar, Button, Drawer, Empty, Flex, Image, Pagination, Radio, Space, Tag, Tooltip, Typography, theme } from "antd";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, CircleCheck, LayoutGrid, List, Plus } from "lucide-react";
import { useAgGoClient, type AgGoProject, type AgGoProjectQuery, type AgGoProjectSort } from "../../../api/ag-go-client";
import { StudioHttpError } from "../../../api/http";
import { useWorkspaceClient, type SourceItem } from "../../../api/workspace-client";
import { SortDropdown } from "../../../helpers/sort-dropdown";
import { stickyIn } from "../../../helpers/sticky-table-header";
import { useAiTranslation } from "../../common/assistant-name";
import { FilterSidebarLayout, FilterToggleButton, useFilterSidebar } from "./filter-sidebar";
import { countActiveFilters, ProjectFilterSidebar, type ProjectFilterValues } from "./ProjectFilterSidebar";
import { ProjectGridView, ProjectGridSkeleton, useThumbnailUrl } from "./ProjectGridView";
import { ProjectSearchBox, type ProjectSearchSuggestion } from "./ProjectSearchBox";
import { formatDate } from "./text-match";
import "./project-grid.css";

const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];
const DEFAULT_PAGE_SIZE = 24;
const SORT_FIELDS: AgGoProjectSort[] = ["name", "folder", "createdAt", "updatedAt"];
const VIEW_KEY = "studio.agp.viewMode";
/** The list scrolls inside the drawer's body: the header and the sideways scroll bar stick to it. */
const DRAWER_TABLE_STICKY = stickyIn(".agp-drawer .ant-drawer-body");
type ViewMode = "list" | "grid";

function readView(): ViewMode {
  try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; }
}

/** The table's thumbnail: a fixed box that long names cannot squeeze; it opens large on click. */
function ThumbnailCell({ assetId }: { assetId?: string | null | undefined }) {
  const url = useThumbnailUrl(assetId);
  if (!url) return <div className="agp-thumb" aria-hidden><Camera size={22} strokeWidth={1.4} /></div>;
  return <div className="agp-thumb"><Image src={url} width={96} height={72} alt="" style={{ borderRadius: 6, objectFit: "cover" }} /></div>;
}

const ownerCannot = (e: unknown) => e instanceof StudioHttpError && e.code === "owner_cannot_access";

/**
 * Picks the ag-go projects the agent searches for footage, in a full-screen drawer laid out exactly as ag-go's own
 * Projects page: the filter sidebar, the smart search, sort, list or grid, pages of 12–96. Several projects are
 * ticked (across pages and views) and added together; Studio checks for each that the project's owner sees videos
 * in it, and says which could not be added. Those the owner cannot use are unticked and marked until the drawer opens
 * again, with why said once (prod: the same projects were added again and again, 653 refusals in a week).
 */
export function AgGoProjectDrawer({ projectId, picked, open, onClose }: { projectId: string; picked: SourceItem[]; open: boolean; onClose: () => void }) {
  const { t } = useAiTranslation();
  const { token } = theme.useToken();
  const { message, modal } = AntApp.useApp();
  const agGo = useAgGoClient();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const sidebar = useFilterSidebar("studio.agp.filterSidebar");
  const [view, setViewState] = useState<ViewMode>(readView);
  const setView = (v: ViewMode) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* this visit only */ } };
  const [filters, setFilters] = useState<ProjectFilterValues>({});
  const [sort, setSort] = useState<{ sortBy: AgGoProjectSort; sortOrder: "asc" | "desc" }>({ sortBy: "updatedAt", sortOrder: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<Map<string, AgGoProject>>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** Projects Studio refused because the project's owner cannot use them, until the drawer opens again. */
  const [refusedIds, setRefusedIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { if (open) { setFilters({}); setPage(1); setSelected(new Map()); setProgress(null); setRefusedIds(new Set()); } }, [open]);

  const params: AgGoProjectQuery = {
    page, pageSize, sortBy: sort.sortBy, sortOrder: sort.sortOrder, ...(filters.keyword ? { keyword: filters.keyword } : {}),
    ...(filters.categoryIds?.length ? { categoryIds: filters.categoryIds } : {}), ...(filters.tagIds?.length ? { tagIds: filters.tagIds } : {}),
    ...(filters.folderIds?.length ? { folderIds: filters.folderIds } : {}), ...(filters.ownerUserIds?.length ? { ownerUserIds: filters.ownerUserIds } : {}),
    ...(filters.countryId ? { countryId: filters.countryId } : {}), ...(filters.provinceId ? { provinceId: filters.provinceId } : {}),
  };
  const list = useQuery({ queryKey: ["agGoProjects", params], queryFn: () => agGo.getProjects(params), enabled: open, placeholderData: (prev) => prev });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const addedIds = useMemo(() => new Set(picked.filter((s) => s.kind === "ag_go_project").map((s) => s.ref)), [picked]);
  const canSelect = (p: AgGoProject) => !addedIds.has(p.id) && !refusedIds.has(p.id) && p.videoCount > 0;
  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);
  const activeCount = countActiveFilters(filters);

  const changeFilters = (v: ProjectFilterValues) => { setFilters(v); setPage(1); };
  const applyQuickFilter = (patch: ProjectFilterValues) => changeFilters({ ...filters, ...patch });
  const pick = (s: ProjectSearchSuggestion) => {
    const add = (xs: string[] | undefined, id: string) => [...new Set([...(xs ?? []), id])];
    if (s.kind === "category") applyQuickFilter({ categoryIds: add(filters.categoryIds, s.id) });
    else if (s.kind === "tag") applyQuickFilter({ tagIds: add(filters.tagIds, s.id) });
    else if (s.kind === "folder") applyQuickFilter({ folderIds: add(filters.folderIds, s.id) });
    else if (s.kind === "country") applyQuickFilter({ countryId: s.id, provinceId: undefined });
    else if (s.kind === "province") applyQuickFilter({ countryId: s.countryId, provinceId: s.id });
  };
  const toggle = (p: AgGoProject, on: boolean) => setSelected((m) => {
    const next = new Map(m);
    if (on && canSelect(p)) next.set(p.id, p); else next.delete(p.id);
    return next;
  });

  /**
   * Adds the ticked projects one after the other. Those the owner cannot use are unticked, marked and listed under one
   * explanation; those that failed otherwise stay ticked, listed with their error, to try again.
   */
  const addSelected = async () => {
    const todo = [...selected.values()];
    const refused: AgGoProject[] = [];
    const failed: { project: AgGoProject; reason: string }[] = [];
    setProgress({ done: 0, total: todo.length });
    for (const [i, p] of todo.entries()) {
      try {
        await client.addSource(projectId, { kind: "ag_go_project", ref: p.id, label: p.name });
      } catch (e) {
        if (ownerCannot(e)) refused.push(p);
        else failed.push({ project: p, reason: e instanceof StudioHttpError ? e.message : t("ws.inputs.addFailed") });
      }
      setProgress({ done: i + 1, total: todo.length });
    }
    setProgress(null);
    void qc.invalidateQueries({ queryKey: ["sources", projectId] });
    const added = todo.length - refused.length - failed.length;
    if (added) void message.success(t("ws.agp.addedCount", { count: added }));
    if (refused.length) setRefusedIds((ids) => new Set([...ids, ...refused.map((p) => p.id)]));
    setSelected(new Map(failed.map((f) => [f.project.id, f.project])));
    if (refused.length || failed.length) {
      const list = (rows: { key: string; node: ReactNode }[]) => <ul style={{ paddingLeft: 18, margin: "4px 0 8px" }}>{rows.map((r) => <li key={r.key}>{r.node}</li>)}</ul>;
      modal.warning({
        title: t("ws.agp.someFailed", { count: refused.length + failed.length }),
        content: (
          <div>
            {refused.length ? <>
              <Typography.Paragraph style={{ marginBottom: 4 }}>{t("ws.agp.refusedHelp")}</Typography.Paragraph>
              {list(refused.map((p) => ({ key: p.id, node: <strong>{p.name}</strong> })))}
            </> : null}
            {failed.length ? list(failed.map((f) => ({ key: f.project.id, node: <><strong>{f.project.name}</strong>: {f.reason}</> }))) : null}
          </div>
        ),
      });
    } else {
      onClose();
    }
  };

  const filterLink = (label: string, onClick: () => void, style?: CSSProperties) => (
    <Tooltip title={t("ws.agp.clickToFilter")}><Typography.Link ellipsis className="agp-filter-link" style={style} onClick={onClick}>{label}</Typography.Link></Tooltip>
  );
  const columns: ProColumns<AgGoProject>[] = [
    {
      title: t("ws.agp.name"), dataIndex: "name", key: "name", width: 364, fixed: "left", ellipsis: true,
      render: (_, p) => (
        <Flex align="start" gap={8} style={{ minWidth: 0 }}>
          <ThumbnailCell assetId={p.thumbnailAssetId} />
          <Flex vertical gap={2} style={{ minWidth: 0 }}>
            <Typography.Text strong ellipsis title={p.name}>{p.name}</Typography.Text>
            <Flex align="center" gap={6} style={{ minWidth: 0 }}>
              <Avatar size={18} src={p.ownerUser?.avatar} style={{ flexShrink: 0 }}>{p.ownerUser?.name?.charAt(0)?.toUpperCase()}</Avatar>
              <Typography.Text type="secondary" ellipsis={{ tooltip: p.ownerUser?.name || p.ownerUser?.email }}>{p.ownerUser?.name || p.ownerUser?.email || t("ws.agp.unknown")}</Typography.Text>
            </Flex>
            {addedIds.has(p.id) ? <span><Tag color="success" icon={<CircleCheck size={12} style={{ marginRight: 4, verticalAlign: -2 }} />}>{t("ws.agp.added")}</Tag></span>
              : refusedIds.has(p.id) ? <span><Tag color="warning">{t("ws.agp.refused")}</Tag></span>
              : !p.videoCount ? <span><Tag>{t("ws.agp.noVideos")}</Tag></span> : null}
          </Flex>
        </Flex>
      ),
    },
    {
      title: t("ws.agp.location"), dataIndex: "countryName", key: "location", width: 200, ellipsis: true,
      render: (_, p) => (
        <Flex vertical style={{ minWidth: 0 }}>
          <Flex align="center" gap={6} style={{ minWidth: 0 }}>
            {p.countryFlagUrl ? <img src={p.countryFlagUrl} alt="" style={{ height: 14, borderRadius: 2 }} /> : null}
            {p.countryId && p.countryName ? filterLink(p.countryName, () => applyQuickFilter({ countryId: p.countryId!, provinceId: undefined })) : <Typography.Text type="secondary">-</Typography.Text>}
          </Flex>
          {p.countryId && p.provinceId && p.provinceName
            ? filterLink(p.provinceName, () => applyQuickFilter({ countryId: p.countryId!, provinceId: p.provinceId! }), { color: token.colorTextSecondary })
            : p.provinceName ? <Typography.Text type="secondary" ellipsis={{ tooltip: p.provinceName }}>{p.provinceName}</Typography.Text> : null}
        </Flex>
      ),
    },
    {
      title: t("ws.agp.folder"), dataIndex: "folderPath", key: "folderPath", width: 200, ellipsis: true,
      render: (_, p) => {
        const name = p.folderName || p.folderPath?.split(" / ").pop();
        if (!name) return <Typography.Text type="secondary">-</Typography.Text>;
        return (
          <Tooltip title={<><div>{p.folderPath || name}</div><div style={{ opacity: 0.7, fontSize: 12 }}>{t("ws.agp.clickToFilter")}</div></>}>
            <Typography.Link ellipsis className="agp-filter-link" onClick={() => p.folderId && applyQuickFilter({ folderIds: [p.folderId] })}>{name}</Typography.Link>
          </Tooltip>
        );
      },
    },
    {
      title: t("ws.agp.category"), dataIndex: "categoryName", key: "category", width: 160, ellipsis: true,
      render: (_, p) => (p.categoryId && p.categoryName ? filterLink(p.categoryName, () => applyQuickFilter({ categoryIds: [p.categoryId!] })) : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: t("ws.agp.fileCounts"), dataIndex: "mediaCount", key: "mediaCount", width: 180,
      render: (_, p) => <Space size={4} wrap><Tag color="blue">{p.imageCount} {t("ws.agp.image")}</Tag><Tag color="purple">{p.videoCount} {t("ws.agp.video")}</Tag></Space>,
    },
    { title: t("ws.agp.createdAt"), dataIndex: "createdAt", key: "createdAt", width: 170, render: (_, p) => formatDate(p.createdAt) },
    { title: t("ws.agp.updatedAt"), dataIndex: "updatedAt", key: "updatedAt", width: 170, render: (_, p) => formatDate(p.updatedAt) },
  ];

  const emptyText = filters.keyword || activeCount > 0 ? t("ws.agp.noMatch") : t("ws.agp.empty");
  const showTotal = (n: number, range: [number, number]) => t("ws.agp.paginationTotal", { start: range[0], end: range[1], total: n });
  const busy = progress !== null;
  const selectionAlert = selected.size > 0 ? (
    <Alert
      showIcon type="info" style={{ marginBottom: 16 }} message={t("ws.agp.selected", { count: selected.size })}
      action={
        <Space wrap>
          <Button size="small" type="link" disabled={busy} onClick={() => setSelected(new Map())}>{t("ws.agp.clearSelection")}</Button>
          <Button size="small" type="primary" icon={<Plus size={14} />} loading={busy} onClick={() => void addSelected()}>
            {busy ? t("ws.agp.adding", { done: progress.done, total: progress.total }) : t("ws.agp.addSelected", { count: selected.size })}
          </Button>
        </Space>
      }
    />
  ) : null;

  return (
    <Drawer
      open={open} onClose={onClose} width="100%" placement="right" destroyOnHidden rootClassName="agp-drawer"
      rootStyle={{ "--agp-drawer-head": "78px" } as CSSProperties}
      title={
        <div>
          <div style={{ fontSize: 20, fontWeight: 600, lineHeight: "28px" }}>{t("ws.agp.title")}</div>
          <div style={{ fontSize: 14, fontWeight: 400, color: token.colorTextSecondary }}>{t("ws.agp.lead")}</div>
        </div>
      }
      extra={selected.size > 0 ? (
        <Button type="primary" icon={<Plus size={16} />} loading={busy} onClick={() => void addSelected()}>{t("ws.agp.addSelected", { count: selected.size })}</Button>
      ) : null}
      styles={{ body: { background: token.colorBgLayout, padding: 16 } }}
    >
      {list.error ? <Alert closable showIcon type="error" style={{ marginBottom: 16 }} message={t("ws.inputs.agGoUnavailable")} /> : null}
      <FilterSidebarLayout state={sidebar} activeCount={activeCount} onClear={() => changeFilters({})}
        sidebar={<ProjectFilterSidebar value={filters} onChange={changeFilters} />} contentStyle={{ padding: "0 12px 12px" }}>
        <ProTable<AgGoProject>
          rowKey="id" columns={columns} dataSource={items} loading={view === "list" && list.isFetching} search={false}
          columnsState={{ persistenceKey: "studio.agp.columns", persistenceType: "localStorage", defaultValue: { createdAt: { show: false } } }}
          headerTitle={
            <Space size={12} wrap>
              <FilterToggleButton state={sidebar} activeCount={activeCount} />
              <ProjectSearchBox keyword={filters.keyword ?? ""} onSearch={(kw) => changeFilters({ ...filters, keyword: kw || undefined })} onPick={pick} />
            </Space>
          }
          options={{ reload: () => void list.refetch(), density: false, setting: true, fullScreen: false }}
          pagination={{
            current: page, pageSize, total, showSizeChanger: true, pageSizeOptions: PAGE_SIZE_OPTIONS, showTotal,
            onChange: (p, s) => { setPage(s !== pageSize ? 1 : p); setPageSize(s); },
          }}
          rowSelection={{
            selectedRowKeys: [...selectedIds], preserveSelectedRowKeys: true,
            getCheckboxProps: (p) => ({ disabled: !canSelect(p), "aria-label": p.name }),
            onChange: (keys, rows) => setSelected((m) => {
              const wanted = new Set(keys.map(String));
              const next = new Map([...m].filter(([id]) => wanted.has(id)));
              for (const r of rows) if (r && wanted.has(r.id)) next.set(r.id, r);
              return next;
            }),
          }}
          tableAlertRender={false}
          locale={{ emptyText: <Empty description={<Typography.Text type="secondary">{emptyText}</Typography.Text>} /> }}
          scroll={{ x: 1400 }} sticky={DRAWER_TABLE_STICKY}
          tableRender={(_props, _dom, domList) => (
            <>
              {domList.toolbar}
              {selectionAlert}
              {view === "grid" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {list.isLoading ? <ProjectGridSkeleton /> : (
                    <ProjectGridView
                      items={items} isLoading={false} emptyText={emptyText}
                      selectedIds={selectedIds} addedIds={addedIds} refusedIds={refusedIds} canSelect={canSelect} onToggle={toggle}
                      onFilterFolder={(folderId) => applyQuickFilter({ folderIds: [folderId] })}
                      onFilterLocation={({ countryId, provinceId }) => applyQuickFilter({ countryId, provinceId })}
                    />
                  )}
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12, paddingBottom: 16 }}>
                    <Pagination current={page} pageSize={pageSize} total={total} showSizeChanger pageSizeOptions={PAGE_SIZE_OPTIONS} showTotal={showTotal}
                      onChange={(p, s) => { setPage(s !== pageSize ? 1 : p); setPageSize(s); }} />
                  </div>
                </div>
              ) : domList.table}
            </>
          )}
          toolBarRender={() => [
            <SortDropdown<AgGoProjectSort>
              key="sort" fields={SORT_FIELDS.map((f) => ({ value: f, label: t(`ws.agp.sort.${f}`) }))} sortBy={sort.sortBy} sortOrder={sort.sortOrder}
              onChange={(c) => { setSort((s) => ({ ...s, ...c })); setPage(1); }}
            />,
            <Radio.Group key="view" value={view} onChange={(e) => setView(e.target.value as ViewMode)} buttonStyle="solid" aria-label={t("ws.agp.viewMode")}>
              <Radio.Button value="list" className="agp-icon-radio" aria-label={t("ws.agp.viewList")} title={t("ws.agp.viewList")}><List size={16} /></Radio.Button>
              <Radio.Button value="grid" className="agp-icon-radio" aria-label={t("ws.agp.viewGrid")} title={t("ws.agp.viewGrid")}><LayoutGrid size={16} /></Radio.Button>
            </Radio.Group>,
          ]}
        />
      </FilterSidebarLayout>
    </Drawer>
  );
}
