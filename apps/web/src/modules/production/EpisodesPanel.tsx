/**
 * Episodes panel: server-paged table with nuqs URL state, SortDropdown, polling
 * every 5s while any episode is "producing", row actions: open editor, re-render,
 * download, export dropdown. Opens EpisodeDrawer on row click.
 */
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dropdown,
  Progress,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { Edit3, RefreshCw, Package, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryState, parseAsInteger, parseAsString } from "nuqs";
import { useStudioClient } from "../../api/studio-client";
import type { EpisodeDetail, EpisodeSummary } from "../../api/studio-client";
import { SortDropdown, type SortState } from "../../helpers/sort-dropdown";
import { TableRefreshButton } from "../../helpers/table-refresh-button";
import { CONTAINER_TABLE_STICKY } from "../../helpers/sticky-table-header";
import { EpisodeDrawer } from "./EpisodeDrawer";
import { premiereMenuItems, useStartPremiereExport } from "./PremiereExports";
import type { ColumnsType } from "antd/es/table";

const SORT_FIELDS = [
  { value: "idx", label: "#" },
  { value: "title", label: "Tiêu đề" },
  { value: "status", label: "Trạng thái" },
  { value: "updatedAt", label: "Cập nhật" },
] as const;
type SF = (typeof SORT_FIELDS)[number]["value"];

const STATUS_COLORS: Record<string, string> = {
  planned: "default",
  producing: "processing",
  ready: "success",
  failed: "error",
  cancelled: "warning",
};

interface Props {
  productionId: string;
  canEdit: boolean;
}

export function EpisodesPanel({ productionId, canEdit }: Props) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [page, setPage] = useQueryState("ep_page", parseAsInteger.withDefault(1));
  const [sortByRaw, setSortByRaw] = useQueryState("ep_sortBy", parseAsString.withDefault("idx"));
  const sortBy = (sortByRaw as SF) || "idx";
  const setSortBy = (v: SF) => setSortByRaw(v);
  const [sortOrder, setSortOrder] = useQueryState("ep_sortOrder", parseAsString.withDefault("asc"));

  const [drawerEpisodeId, setDrawerEpisodeId] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["episodes", productionId, page, sortBy, sortOrder],
    queryFn: () => client.listEpisodes(productionId, { page, pageSize: 20, sortBy, sortOrder }),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      const hasProducing = items.some((e) => e.status === "producing");
      return hasProducing ? 5_000 : false;
    },
  });

  const episodes = data?.items ?? [];

  const { data: drawerData } = useQuery({
    queryKey: ["episode", productionId, drawerEpisodeId],
    queryFn: () => client.getEpisode(productionId, drawerEpisodeId!),
    enabled: !!drawerEpisodeId,
  });

  const premiere = useStartPremiereExport(productionId);

  const rerenderMutation = useMutation({
    mutationFn: (episodeId: string) => client.rerenderEpisode(productionId, episodeId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["episodes", productionId] }),
  });

  const handleSort = (change: Partial<SortState<SF>>) => {
    if (change.sortBy) void setSortBy(change.sortBy);
    if (change.sortOrder) void setSortOrder(change.sortOrder);
    void setPage(1);
  };

  const columns: ColumnsType<EpisodeSummary> = [
    {
      title: t("episodes.columnIdx"),
      dataIndex: "idx",
      key: "idx",
      width: 48,
      render: (v: number) => String(v),
    },
    {
      title: t("episodes.columnTitle"),
      dataIndex: "title",
      key: "title",
      render: (title: string, r: EpisodeSummary) => (
        <a onClick={() => setDrawerEpisodeId(r.id)}>{title}</a>
      ),
    },
    {
      title: t("episodes.columnStatus"),
      dataIndex: "status",
      key: "status",
      width: 130,
      render: (status: string) => (
        <Tag color={STATUS_COLORS[status] ?? "default"}>{t(`episodes.status.${status}`, { defaultValue: status })}</Tag>
      ),
    },
    {
      title: t("episodes.columnProgress"),
      key: "progress",
      width: 120,
      render: (_: unknown, r: EpisodeSummary) =>
        r.progress != null ? (
          <Progress percent={Math.round(r.progress)} size="small" />
        ) : null,
    },
    {
      title: t("episodes.columnDuration"),
      dataIndex: "durationSeconds",
      key: "durationSeconds",
      width: 100,
      render: (v: number | null) => (v != null ? `${Math.round(v)}s` : "—"),
    },
    {
      title: t("episodes.columnActions"),
      key: "actions",
      width: 140,
      fixed: "right",
      render: (_: unknown, r: EpisodeSummary) => (
        <Space size={4}>
          <Tooltip title={t("episodes.openEditor")}>
            <Button
              size="small"
              icon={<Edit3 size={12} />}
              onClick={() => navigate(`/productions/${productionId}/episodes/${r.id}/editor`)}
              aria-label={t("episodes.openEditor")}
              disabled={r.status === "planned"}
            />
          </Tooltip>
          {canEdit && (
            <Popconfirm title={t("episodes.rerenderConfirm")} onConfirm={() => void rerenderMutation.mutate(r.id)}>
              <Tooltip title={t("episodes.rerender")}>
                <Button size="small" icon={<RefreshCw size={12} />} aria-label={t("episodes.rerender")} />
              </Tooltip>
            </Popconfirm>
          )}
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "youtube-pack",
                  icon: <Package size={14} />,
                  label: t("episodes.youtubePack"),
                  disabled: r.status !== "ready",
                  onClick: () => setDrawerEpisodeId(r.id),
                },
                ...(canEdit ? premiereMenuItems(t, (media) => premiere.mutate({ episodeId: r.id, media })).map((i) => ({ ...i, disabled: r.status === "planned" })) : []),
              ],
            }}
          >
            <Tooltip title={t("episodes.export")}>
              <Button size="small" icon={<MoreHorizontal size={12} />} aria-label={t("episodes.export")} />
            </Tooltip>
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontWeight: 500 }}>{t("episodes.title")}</span>
        <Space>
          <SortDropdown
            fields={SORT_FIELDS}
            sortBy={(sortBy as SF) || "idx"}
            sortOrder={(sortOrder as "asc" | "desc") || "asc"}
            onChange={handleSort}
            size="small"
          />
          <TableRefreshButton onRefresh={() => void refetch()} refreshing={isFetching} size="small" />
        </Space>
      </div>
      <Table
        columns={columns}
        dataSource={episodes}
        rowKey="id"
        loading={isLoading}
        sticky={CONTAINER_TABLE_STICKY}
        scroll={{ x: 700 }}
        size="small"
        pagination={{
          total: data?.total,
          current: page,
          pageSize: 20,
          onChange: (p) => void setPage(p),
          showSizeChanger: false,
        }}
      />
      {drawerEpisodeId && drawerData && (
        <EpisodeDrawer
          productionId={productionId}
          episode={drawerData as EpisodeDetail}
          open={!!drawerEpisodeId}
          onClose={() => setDrawerEpisodeId(null)}
          canEdit={canEdit}
        />
      )}
    </>
  );
}
