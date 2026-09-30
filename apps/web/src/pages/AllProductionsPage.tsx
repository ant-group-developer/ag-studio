/**
 * Admin-only: lists ALL productions across every team.
 * Uses the admin-scoped GET /api/productions endpoint.
 */
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Table, Button, Tag, Space, Typography, Tooltip } from "antd";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../api/studio-client";
import type { Production } from "../api/studio-client";
import { EnumText, PRODUCTION_STATUS_COLORS } from "../helpers/enum-label";
import { SortDropdown, type SortState } from "../helpers/sort-dropdown";
import { TableRefreshButton } from "../helpers/table-refresh-button";
import { useDebouncedValue } from "../helpers/use-debounced-value";
import { PAGE_TABLE_STICKY } from "../helpers/sticky-table-header";
import type { ColumnsType } from "antd/es/table";
import { useQueryState, parseAsString, parseAsInteger } from "nuqs";

const { Title } = Typography;

const SORT_FIELDS = [
  { value: "title", label: "Tiêu đề" },
  { value: "status", label: "Trạng thái" },
  { value: "createdAt", label: "Ngày tạo" },
] as const;
type SF = (typeof SORT_FIELDS)[number]["value"];

export function AllProductionsPage() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const navigate = useNavigate();

  const [q, setQ] = useQueryState("q", parseAsString.withDefault(""));
  const [sortByRaw, setSortByRaw] = useQueryState("sortBy", parseAsString.withDefault("createdAt"));
  const sortBy = (sortByRaw as SF) || "createdAt";
  const setSortBy = (v: SF) => setSortByRaw(v);
  const [sortOrder, setSortOrder] = useQueryState("sortOrder", parseAsString.withDefault("desc"));
  const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1));

  const dq = useDebouncedValue(q);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["all-productions", dq, sortBy, sortOrder, page],
    queryFn: () => client.listProductions({ q: dq || undefined, sortBy, sortOrder, page, pageSize: 20 }),
  });

  const productions = data?.items ?? [];

  const handleSort = (change: Partial<SortState<SF>>) => {
    if (change.sortBy) void setSortBy(change.sortBy);
    if (change.sortOrder) void setSortOrder(change.sortOrder);
    void setPage(1);
  };

  const columns: ColumnsType<Production> = [
    {
      title: t("productions.columnTitle"),
      dataIndex: "title",
      key: "title",
      width: 260,
      ellipsis: { showTitle: false },
      render: (title: string, r: Production) => (
        <Tooltip title={title}>
          <a onClick={() => navigate(`/productions/${r.id}`)}>{title}</a>
        </Tooltip>
      ),
    },
    {
      title: "Nhóm",
      dataIndex: "teamName",
      key: "teamName",
      width: 160,
      ellipsis: { showTitle: false },
      render: (v: string) => <Tooltip title={v}>{v}</Tooltip>,
    },
    {
      title: t("productions.columnStatus"),
      dataIndex: "status",
      key: "status",
      width: 160,
      render: (status: string) => (
        <Tag color={PRODUCTION_STATUS_COLORS[status]}>
          <EnumText group="productionStatus" code={status} />
        </Tag>
      ),
    },
    {
      title: t("productions.columnEpisodes"),
      key: "episodes",
      width: 120,
      render: (_: unknown, r: Production) => `${r.episodeCounts.ready}/${r.episodeCounts.total}`,
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 80,
      fixed: "right",
      render: (_: unknown, r: Production) => (
        <Tooltip title={t("common.open")}>
          <Button size="small" icon={<ExternalLink size={14} />} onClick={() => navigate(`/productions/${r.id}`)} aria-label={t("common.open")} />
        </Tooltip>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, alignItems: "center" }}>
        <Title level={3} style={{ margin: 0 }}>{t("menu.allProductions")}</Title>
        <Space>
          <SortDropdown
            fields={SORT_FIELDS}
            sortBy={(sortBy as SF) || "createdAt"}
            sortOrder={(sortOrder as "asc" | "desc") || "desc"}
            onChange={handleSort}
            size="small"
          />
          <TableRefreshButton onRefresh={() => void refetch()} refreshing={isFetching} size="small" />
        </Space>
      </div>
      <Table
        columns={columns}
        dataSource={productions}
        rowKey="id"
        loading={isLoading}
        sticky={PAGE_TABLE_STICKY}
        scroll={{ x: 800 }}
        pagination={{
          total: data?.total,
          current: page,
          pageSize: 20,
          onChange: (p) => void setPage(p),
          showSizeChanger: false,
        }}
      />
    </div>
  );
}
