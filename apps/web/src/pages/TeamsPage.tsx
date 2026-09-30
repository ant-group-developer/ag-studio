import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Table, Button, Modal, Form, Input, Space, Typography, Tooltip } from "antd";
import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../api/studio-client";
import type { Team } from "../api/studio-client";
import type { ColumnsType } from "antd/es/table";
import { PAGE_TABLE_STICKY } from "../helpers/sticky-table-header";

const { Title } = Typography;

export function TeamsPage() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ name: string }>();

  const { data: teamsPage, isLoading } = useQuery({
    queryKey: ["teams"],
    queryFn: () => client.listTeams(),
  });
  const teams = teamsPage?.items ?? [];

  const createMutation = useMutation({
    mutationFn: (name: string) => client.createTeam(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
      setOpen(false);
      form.resetFields();
    },
  });

  const columns: ColumnsType<Team> = [
    {
      title: t("teams.columnName"),
      dataIndex: "name",
      key: "name",
      render: (name: string, record: Team) => (
        <a onClick={() => navigate(`/teams/${record.id}`)}>{name}</a>
      ),
    },
    {
      title: t("teams.columnActions"),
      key: "actions",
      render: (_: unknown, record: Team) => (
        <Space>
          <Button size="small" type="primary" ghost onClick={() => navigate(`/teams/${record.id}/productions`)}>
            {t("teams.viewProductions")}
          </Button>
          <Button size="small" onClick={() => navigate(`/teams/${record.id}`)}>
            {t("teams.viewMembers")}
          </Button>
        </Space>
      ),
    },
  ];

  const handleOk = () => {
    form.validateFields().then((values) => {
      createMutation.mutate(values.name);
    });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Title level={3}>{t("teams.title")}</Title>
        <Tooltip title={t("teams.create")}>
          <Button
            type="primary"
            icon={<Plus size={16} />}
            onClick={() => setOpen(true)}
            aria-label={t("teams.create")}
          >
            {t("teams.create")}
          </Button>
        </Tooltip>
      </div>

      <Table
        columns={columns}
        dataSource={teams}
        rowKey="id"
        loading={isLoading}
        sticky={PAGE_TABLE_STICKY}
      />

      <Modal
        title={t("teams.createTitle")}
        open={open}
        onOk={handleOk}
        onCancel={() => setOpen(false)}
        confirmLoading={createMutation.isPending}
      >
        <Form form={form} layout="vertical">
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
