import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Space,
  Typography,
  Tooltip,
  Popconfirm,
} from "antd";
import { Plus, Users, Film, Pencil, Trash2, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryState, parseAsString, parseAsInteger } from "nuqs";
import { useStudioClient } from "../api/studio-client";
import type { Team } from "../api/studio-client";
import type { ColumnsType } from "antd/es/table";
import { PAGE_TABLE_STICKY } from "../helpers/sticky-table-header";
import { SortDropdown } from "../helpers/sort-dropdown";
import { TableRefreshButton } from "../helpers/table-refresh-button";
import { useDebouncedValue } from "../helpers/use-debounced-value";
import type { SortDirection } from "../helpers/compare-sort-values";

const { Title } = Typography;

const PAGE_SIZE = 20;

const SORT_FIELDS = [
  { value: "name", label: "Tên" },
  { value: "createdAt", label: "Ngày tạo" },
] as const;

type TeamSortField = (typeof SORT_FIELDS)[number]["value"];

export function TeamsPage() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // URL state
  const [page, setPage] = useQueryState("t_page", parseAsInteger.withDefault(1));
  const [sortBy, setSortBy] = useQueryState("t_sortBy", parseAsString.withDefault("name"));
  const [sortOrder, setSortOrder] = useQueryState(
    "t_sortOrder",
    parseAsString.withDefault("asc"),
  );
  const [q, setQ] = useQueryState("t_q", parseAsString.withDefault(""));

  const debouncedQ = useDebouncedValue(q, 300);

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<{ name: string }>();

  // Edit modal
  const [editTeam, setEditTeam] = useState<Team | null>(null);
  const [editForm] = Form.useForm<{ name: string }>();

  const queryKey = ["teams", { page, sortBy, sortOrder, q: debouncedQ }] as const;

  const { data: teamsPage, isLoading, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () =>
      client.listTeams({
        page,
        pageSize: PAGE_SIZE,
        sortBy,
        sortOrder,
        q: debouncedQ || undefined,
      }),
  });

  const teams = teamsPage?.items ?? [];
  const total = teamsPage?.total ?? 0;

  const createMutation = useMutation({
    mutationFn: (name: string) => client.createTeam(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
      setCreateOpen(false);
      createForm.resetFields();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      client.updateTeam(id, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
      setEditTeam(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (teamId: string) => client.deleteTeam(teamId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
  });

  const handleSortChange = (change: { sortBy?: TeamSortField; sortOrder?: SortDirection }) => {
    if (change.sortBy !== undefined) void setSortBy(change.sortBy);
    if (change.sortOrder !== undefined) void setSortOrder(change.sortOrder);
    void setPage(1);
  };

  const columns: ColumnsType<Team> = [
    {
      title: t("teams.columnName"),
      dataIndex: "name",
      key: "name",
      width: 260,
      ellipsis: { showTitle: false },
      render: (name: string, record: Team) => (
        <Tooltip title={name}>
          <a onClick={() => navigate(`/teams/${record.id}`)}>{name}</a>
        </Tooltip>
      ),
    },
    {
      title: t("teams.columnMembers"),
      dataIndex: "memberCount",
      key: "memberCount",
      width: 100,
    },
    {
      title: t("teams.columnProductions"),
      dataIndex: "productionCount",
      key: "productionCount",
      width: 100,
    },
    {
      title: t("teams.columnActions"),
      key: "actions",
      fixed: "right" as const,
      width: 160,
      render: (_: unknown, record: Team) => {
        const canEdit = record.role === "owner" || record.role === null;
        return (
          <Space size={4}>
            <Tooltip title={t("teams.viewMembers")}>
              <Button
                size="small"
                icon={<Users size={14} />}
                onClick={() => navigate(`/teams/${record.id}`)}
                aria-label={t("teams.viewMembers")}
              />
            </Tooltip>
            <Tooltip title={t("teams.viewProductions")}>
              <Button
                size="small"
                icon={<Film size={14} />}
                onClick={() => navigate(`/teams/${record.id}/productions`)}
                aria-label={t("teams.viewProductions")}
              />
            </Tooltip>
            {canEdit && (
              <>
                <Tooltip title={t("teams.editTeam")}>
                  <Button
                    size="small"
                    icon={<Pencil size={14} />}
                    onClick={() => {
                      setEditTeam(record);
                      editForm.setFieldsValue({ name: record.name });
                    }}
                    aria-label={t("teams.editTeam")}
                  />
                </Tooltip>
                <Tooltip title={t("teams.deleteTeam")}>
                  <Popconfirm
                    title={t("teams.deleteTeamConfirm")}
                    onConfirm={() => deleteMutation.mutate(record.id)}
                    okButtonProps={{ danger: true }}
                  >
                    <Button
                      size="small"
                      danger
                      icon={<Trash2 size={14} />}
                      aria-label={t("teams.deleteTeam")}
                    />
                  </Popconfirm>
                </Tooltip>
              </>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      {/* Header row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <Title level={3} style={{ margin: 0 }}>
          {t("teams.title")}
        </Title>
        <Tooltip title={t("teams.create")}>
          <Button
            type="primary"
            icon={<Plus size={16} />}
            onClick={() => setCreateOpen(true)}
            aria-label={t("teams.create")}
          >
            {t("teams.create")}
          </Button>
        </Tooltip>
      </div>

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Input
          placeholder={t("teams.searchPlaceholder")}
          allowClear
          value={q}
          onChange={(e) => {
            void setQ(e.target.value);
            void setPage(1);
          }}
          style={{ width: 220 }}
          prefix={<Search size={14} />}
          aria-label={t("common.search")}
        />
        <SortDropdown
          fields={SORT_FIELDS}
          sortBy={sortBy as TeamSortField}
          sortOrder={sortOrder as SortDirection}
          onChange={handleSortChange}
        />
        <TableRefreshButton onRefresh={() => void refetch()} refreshing={isFetching} />
      </div>

      <Table
        columns={columns}
        dataSource={teams}
        rowKey="id"
        loading={isLoading}
        sticky={PAGE_TABLE_STICKY}
        scroll={{ x: "max-content" }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: (p) => void setPage(p),
        }}
      />

      {/* Create Modal */}
      <Modal
        title={t("teams.createTitle")}
        open={createOpen}
        onOk={() => {
          createForm
            .validateFields()
            .then((values) => createMutation.mutate(values.name))
            .catch(() => undefined);
        }}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        confirmLoading={createMutation.isPending}
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="name"
            label={t("teams.nameLabel")}
            rules={[{ required: true, message: t("teams.nameRequired") }]}
          >
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        title={t("teams.editTeam")}
        open={!!editTeam}
        onOk={() => {
          editForm
            .validateFields()
            .then((values) => {
              if (editTeam) updateMutation.mutate({ id: editTeam.id, name: values.name });
            })
            .catch(() => undefined);
        }}
        onCancel={() => {
          setEditTeam(null);
          editForm.resetFields();
        }}
        confirmLoading={updateMutation.isPending}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="name"
            label={t("teams.nameLabel")}
            rules={[{ required: true, message: t("teams.nameRequired") }]}
          >
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
