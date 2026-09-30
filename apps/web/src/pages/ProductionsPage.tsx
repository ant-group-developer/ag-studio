import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Empty,
  Form,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Input,
} from "antd";
import { ExternalLink, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryState, parseAsString, parseAsInteger } from "nuqs";
import { useStudioClient } from "../api/studio-client";
import type { Production } from "../api/studio-client";
import { EnumText, PRODUCTION_STATUS_COLORS } from "../helpers/enum-label";
import { PAGE_TABLE_STICKY } from "../helpers/sticky-table-header";
import type { ColumnsType } from "antd/es/table";
import { SortDropdown } from "../helpers/sort-dropdown";
import { TableRefreshButton } from "../helpers/table-refresh-button";
import { useDebouncedValue } from "../helpers/use-debounced-value";
import {
  ProductionForm,
  mmssToSeconds,
} from "../modules/production/ProductionForm";
import type { ProductionFormValues } from "../modules/production/ProductionForm";

const { Title } = Typography;

const PAGE_SIZE = 20;
const LAST_TEAM_KEY = "ag-studio:last-team";

function rememberedTeam(): string | null {
  try {
    return localStorage.getItem(LAST_TEAM_KEY);
  } catch {
    return null;
  }
}

function rememberTeam(teamId: string): void {
  try {
    localStorage.setItem(LAST_TEAM_KEY, teamId);
  } catch {
    // private mode
  }
}

const SORT_FIELDS = [
  { value: "title", label: "Tiêu đề" },
  { value: "status", label: "Trạng thái" },
  { value: "createdAt", label: "Ngày tạo" },
] as const;

type ProductionSortField = (typeof SORT_FIELDS)[number]["value"];

export function ProductionsPage() {
  const { t } = useTranslation();
  const { teamId: routeTeamId } = useParams<{ teamId: string }>();
  const client = useStudioClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // URL state (nuqs)
  const [page, setPage] = useQueryState("p_page", parseAsInteger.withDefault(1));
  const [sortByRaw, setSortByRaw] = useQueryState("p_sortBy", parseAsString.withDefault("title"));
  const sortBy = (sortByRaw as ProductionSortField) || "title";
  const setSortBy = (v: ProductionSortField) => void setSortByRaw(v);
  const [sortOrder, setSortOrder] = useQueryState("p_sortOrder", parseAsString.withDefault("asc"));
  const [q, setQ] = useQueryState("p_q", parseAsString.withDefault(""));

  const debouncedQ = useDebouncedValue(q, 300);

  // Outer team picker
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(rememberedTeam());
  const { data: teamsPage, isLoading: loadingTeams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => client.listTeams(),
    enabled: !routeTeamId,
  });
  const teams = teamsPage?.items ?? [];
  const teamId =
    routeTeamId ??
    (teams.some((tm) => tm.id === pickedTeamId) ? pickedTeamId! : teams[0]?.id);

  useEffect(() => {
    if (teamId) rememberTeam(teamId);
  }, [teamId]);

  // Create modal
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<ProductionFormValues>();

  const queryKey = ["productions", teamId, { page, sortBy, sortOrder, q: debouncedQ }] as const;

  const { data: productionsPage, isLoading, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () =>
      client.listTeamProductions(teamId!, {
        page,
        pageSize: PAGE_SIZE,
        sortBy,
        sortOrder,
        q: debouncedQ || undefined,
      }),
    enabled: !!teamId,
  });
  const productions = productionsPage?.items ?? [];
  const total = productionsPage?.total ?? 0;

  // When the modal opens, seed teamId
  useEffect(() => {
    if (open && teamId) form.setFieldValue("teamId", teamId);
  }, [open, teamId, form]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const values = await form.validateFields();
      const createTeamId = values.teamId ?? teamId;
      if (!createTeamId) throw new Error("Chọn nhóm trước");
      const music = values.musicTrack
        ? { track: values.musicTrack, gainDb: values.musicGainDb ?? 0, ducking: values.musicDucking ?? false }
        : null;
      return client.createProduction(createTeamId, {
        title: values.title,
        description: values.description,
        goal: values.goal,
        audience: values.audience,
        tone: values.tone,
        notes: values.notes,
        sources: values.sources ?? [],
        youtubeChannels: values.youtubeChannels ?? [],
        keywords: values.keywords ?? [],
        episodeTargetSeconds: values.durationMmSs ? mmssToSeconds(values.durationMmSs) : undefined,
        maxEpisodes: values.maxEpisodes,
        aspect: values.aspect,
        language: values.language,
        music,
      });
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["productions", created.teamId] });
      setOpen(false);
      form.resetFields();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (productionId: string) => client.deleteProduction(productionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["productions", teamId] });
    },
  });

  const columns: ColumnsType<Production> = [
    {
      title: t("productions.columnTitle"),
      dataIndex: "title",
      key: "title",
      width: 240,
      ellipsis: { showTitle: false },
      render: (title: string, record: Production) => (
        <Tooltip title={title}>
          <a onClick={() => navigate(`/productions/${record.id}`)}>{title}</a>
        </Tooltip>
      ),
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
      title: t("productions.columnAspect"),
      dataIndex: "aspect",
      key: "aspect",
      width: 100,
      render: (aspect: string) => <EnumText group="aspect" code={aspect} />,
    },
    {
      title: t("productions.columnEpisodes"),
      key: "episodeCounts",
      width: 120,
      render: (_: unknown, record: Production) =>
        `${record.episodeCounts.ready}/${record.episodeCounts.total}`,
    },
    {
      key: "actions",
      fixed: "right" as const,
      width: 160,
      render: (_: unknown, record: Production) => (
        <Space size={4}>
          <Tooltip title={t("common.open")}>
            <Button
              size="small"
              type="text"
              icon={<ExternalLink size={14} />}
              onClick={() => navigate(`/productions/${record.id}`)}
            />
          </Tooltip>
          <Tooltip title={t("productions.editProduction")}>
            <Button
              size="small"
              type="text"
              icon={<Pencil size={14} />}
              onClick={() => navigate(`/productions/${record.id}`)}
            />
          </Tooltip>
          <Popconfirm
            title={t("productions.deleteProductionConfirm")}
            onConfirm={() => deleteMutation.mutate(record.id)}
          >
            <Tooltip title={t("productions.deleteProduction")}>
              <Button size="small" type="text" danger icon={<Trash2 size={14} />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (!routeTeamId && !loadingTeams && teams.length === 0) {
    return (
      <div>
        <Title level={3}>{t("productions.title")}</Title>
        <Empty description={t("productions.noTeams")}>
          <Button type="primary" onClick={() => navigate("/teams")}>
            {t("productions.goToTeams")}
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Space align="center" size={16}>
          <Title level={3} style={{ margin: 0 }}>
            {t("productions.title")}
          </Title>
          {!routeTeamId && (
            <Select
              aria-label={t("productions.teamLabel")}
              placeholder={t("productions.teamPlaceholder")}
              loading={loadingTeams}
              value={teamId}
              onChange={(id: string) => { setPickedTeamId(id); void setPage(1); }}
              options={teams.map((tm) => ({ value: tm.id, label: tm.name }))}
              style={{ minWidth: 220 }}
            />
          )}
        </Space>
        <Space>
          <Input
            placeholder={t("productions.searchPlaceholder")}
            prefix={<Search size={14} />}
            value={q}
            onChange={(e) => { void setQ(e.target.value); void setPage(1); }}
            allowClear
            style={{ width: 220 }}
          />
          <SortDropdown
            fields={[...SORT_FIELDS]}
            sortBy={sortBy}
            sortOrder={sortOrder as "asc" | "desc"}
            onChange={(change) => {
              if (change.sortBy !== undefined) setSortBy(change.sortBy as ProductionSortField);
              if (change.sortOrder !== undefined) void setSortOrder(change.sortOrder);
              void setPage(1);
            }}
          />
          <TableRefreshButton onRefresh={() => void refetch()} refreshing={isFetching} />
          <Tooltip title={t("productions.create")}>
            <Button
              type="primary"
              icon={<Plus size={16} />}
              disabled={!teamId}
              onClick={() => setOpen(true)}
              aria-label={t("productions.create")}
            >
              {t("productions.create")}
            </Button>
          </Tooltip>
        </Space>
      </div>

      <Table
        columns={columns}
        dataSource={productions}
        rowKey="id"
        loading={isLoading}
        sticky={PAGE_TABLE_STICKY}
        scroll={{ x: "max-content" }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          onChange: (p) => void setPage(p),
        }}
      />

      <Modal
        title={t("productions.createTitle")}
        open={open}
        onOk={() => createMutation.mutate()}
        onCancel={() => { setOpen(false); form.resetFields(); }}
        confirmLoading={createMutation.isPending}
        width={680}
        destroyOnClose
      >
        <ProductionForm
          form={form}
          showTeamSelect={!routeTeamId}
          teams={teams.map((tm) => ({ id: tm.id, name: tm.name }))}
          loadingTeams={loadingTeams}
          onTeamChange={(id) => setPickedTeamId(id)}
        />
      </Modal>
    </div>
  );
}
