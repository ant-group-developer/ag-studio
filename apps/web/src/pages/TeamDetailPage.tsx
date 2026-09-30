import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table,
  Button,
  Modal,
  Form,
  Select,
  Spin,
  Typography,
  Popconfirm,
  Tooltip,
  Input,
  Tag,
  Space,
} from "antd";
import { Plus, Trash2, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryState, parseAsString, parseAsInteger } from "nuqs";
import { useStudioClient } from "../api/studio-client";
import type { TeamMember } from "../api/studio-client";
import { UserCell } from "../modules/common/UserCell";
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
  { value: "role", label: "Vai trò" },
  { value: "joinedAt", label: "Ngày tham gia" },
] as const;

type MemberSortField = (typeof SORT_FIELDS)[number]["value"];

const ROLE_COLORS: Record<string, string> = {
  owner: "gold",
  producer: "blue",
  editor: "green",
  viewer: "default",
};

export function TeamDetailPage() {
  const { t } = useTranslation();
  const { teamId } = useParams<{ teamId: string }>();
  const client = useStudioClient();
  const queryClient = useQueryClient();

  // URL state
  const [page, setPage] = useQueryState("m_page", parseAsInteger.withDefault(1));
  const [sortBy, setSortBy] = useQueryState("m_sortBy", parseAsString.withDefault("name"));
  const [sortOrder, setSortOrder] = useQueryState(
    "m_sortOrder",
    parseAsString.withDefault("asc"),
  );
  const [q, setQ] = useQueryState("m_q", parseAsString.withDefault(""));

  const debouncedQ = useDebouncedValue(q, 300);

  // Add member modal
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ userId: string; role: string }>();
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");

  // Handle candidate search debounce via local state (separate from URL state)
  const handleKeywordChange = (val: string) => {
    setKeyword(val);
    const id = window.setTimeout(() => setDebounced(val.trim()), 300);
    return () => window.clearTimeout(id);
  };

  const ROLES = [
    { value: "owner", label: t("roles.owner") },
    { value: "producer", label: t("roles.producer") },
    { value: "editor", label: t("roles.editor") },
    { value: "viewer", label: t("roles.viewer") },
  ];

  const queryKey = ["members", teamId, { page, sortBy, sortOrder, q: debouncedQ }] as const;

  const { data: membersPage, isLoading, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () =>
      client.listMembers(teamId!, {
        page,
        pageSize: PAGE_SIZE,
        sortBy,
        sortOrder,
        q: debouncedQ || undefined,
      }),
    enabled: !!teamId,
  });

  const members = membersPage?.items ?? [];
  const total = membersPage?.total ?? 0;

  const { data: candidates = [], isFetching: searching } = useQuery({
    queryKey: ["member-candidates", teamId, debounced],
    queryFn: () => client.searchMemberCandidates(teamId!, debounced),
    enabled: !!teamId && open,
  });

  const addMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      client.addMember(teamId!, userId, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["members", teamId] });
      setOpen(false);
      form.resetFields();
      setKeyword("");
      setDebounced("");
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => client.removeMember(teamId!, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["members", teamId] });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      client.updateMemberRole(teamId!, userId, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["members", teamId] });
    },
  });

  const handleSortChange = (change: {
    sortBy?: MemberSortField;
    sortOrder?: SortDirection;
  }) => {
    if (change.sortBy !== undefined) void setSortBy(change.sortBy);
    if (change.sortOrder !== undefined) void setSortOrder(change.sortOrder);
    void setPage(1);
  };

  const columns: ColumnsType<TeamMember> = [
    {
      title: t("teams.columnUser"),
      key: "user",
      width: 200,
      render: (_: unknown, record: TeamMember) => <UserCell user={record} />,
    },
    {
      title: t("teams.columnRole"),
      dataIndex: "role",
      key: "role",
      width: 120,
      render: (role: string, record: TeamMember) => (
        <Select
          value={role}
          options={ROLES}
          size="small"
          onChange={(newRole) =>
            updateRoleMutation.mutate({ userId: record.userId, role: newRole })
          }
          dropdownStyle={{ minWidth: 140 }}
        >
          <Tag color={ROLE_COLORS[role] ?? "default"}>{t(`roles.${role}`)}</Tag>
        </Select>
      ),
    },
    {
      title: "Ngày tham gia",
      dataIndex: "joinedAt",
      key: "joinedAt",
      width: 120,
      ellipsis: { showTitle: false },
      render: (joinedAt: string) => (
        <Tooltip title={new Date(joinedAt).toLocaleString("vi")}>
          {new Date(joinedAt).toLocaleDateString("vi")}
        </Tooltip>
      ),
    },
    {
      title: t("teams.columnActions"),
      key: "actions",
      fixed: "right" as const,
      width: 120,
      render: (_: unknown, record: TeamMember) => (
        <Space size={4}>
          <Tooltip title={t("teams.remove")}>
            <Popconfirm
              title={t("teams.removeConfirm")}
              onConfirm={() => removeMutation.mutate(record.userId)}
              okButtonProps={{ danger: true }}
            >
              <Button
                size="small"
                danger
                icon={<Trash2 size={14} />}
                aria-label={t("teams.remove")}
              />
            </Popconfirm>
          </Tooltip>
        </Space>
      ),
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
          {t("teams.detailTitle")}
        </Title>
        <Tooltip title={t("teams.addMember")}>
          <Button
            type="primary"
            icon={<Plus size={16} />}
            onClick={() => setOpen(true)}
            aria-label={t("teams.addMember")}
          >
            {t("teams.addMember")}
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
          sortBy={sortBy as MemberSortField}
          sortOrder={sortOrder as SortDirection}
          onChange={handleSortChange}
        />
        <TableRefreshButton onRefresh={() => void refetch()} refreshing={isFetching} />
      </div>

      <Table
        columns={columns}
        dataSource={members}
        rowKey="userId"
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

      <Modal
        title={t("teams.addMemberTitle")}
        open={open}
        onOk={() => {
          form
            .validateFields()
            .then((values) => addMutation.mutate(values))
            .catch(() => undefined);
        }}
        onCancel={() => {
          setOpen(false);
          setKeyword("");
          setDebounced("");
        }}
        confirmLoading={addMutation.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="userId"
            label={t("teams.userLabel")}
            rules={[{ required: true, message: t("teams.userRequired") }]}
          >
            <Select
              showSearch
              filterOption={false}
              onSearch={handleKeywordChange}
              placeholder={t("teams.userSearchPlaceholder")}
              notFoundContent={
                searching ? <Spin size="small" /> : t("teams.userSearchEmpty")
              }
              optionLabelProp="label"
              options={candidates.map((u) => ({
                value: u.userId,
                label: u.name || u.email || u.userId,
                user: u,
              }))}
              optionRender={(option) => (
                <UserCell
                  user={(option.data as unknown as { user: TeamMember }).user}
                  size={28}
                />
              )}
            />
          </Form.Item>
          <Form.Item
            name="role"
            label={t("teams.roleLabel")}
            rules={[{ required: true, message: t("teams.roleRequired") }]}
          >
            <Select options={ROLES} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
