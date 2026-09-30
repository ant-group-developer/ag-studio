import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Table, Button, Modal, Form, Input, Select, Typography, Popconfirm } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../api/studio-client";
import type { TeamMember } from "../api/studio-client";
import type { ColumnsType } from "antd/es/table";

const { Title } = Typography;

export function TeamDetailPage() {
  const { t } = useTranslation();
  const { teamId } = useParams<{ teamId: string }>();
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ userId: string; role: string }>();

  const ROLES = [
    { value: "owner", label: t("roles.owner") },
    { value: "editor", label: t("roles.editor") },
    { value: "viewer", label: t("roles.viewer") },
  ];

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["members", teamId],
    queryFn: () => client.listMembers(teamId!),
    enabled: !!teamId,
  });

  const addMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      client.addMember(teamId!, userId, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["members", teamId] });
      setOpen(false);
      form.resetFields();
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

  const columns: ColumnsType<TeamMember> = [
    {
      title: t("teams.columnUserId"),
      dataIndex: "userId",
      key: "userId",
    },
    {
      title: t("teams.columnRole"),
      dataIndex: "role",
      key: "role",
      render: (role: string, record: TeamMember) => (
        <Select
          value={role}
          options={ROLES}
          size="small"
          onChange={(newRole) =>
            updateRoleMutation.mutate({ userId: record.userId, role: newRole })
          }
        />
      ),
    },
    {
      title: t("teams.columnActions"),
      key: "actions",
      render: (_: unknown, record: TeamMember) => (
        <Popconfirm
          title={t("teams.removeConfirm")}
          onConfirm={() => removeMutation.mutate(record.userId)}
        >
          <Button danger size="small">
            {t("teams.remove")}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const handleOk = () => {
    form.validateFields().then((values) => {
      addMutation.mutate(values);
    });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Title level={3}>{t("teams.detailTitle")}</Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setOpen(true)}
        >
          {t("teams.addMember")}
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={members}
        rowKey="userId"
        loading={isLoading}
      />

      <Modal
        title={t("teams.addMemberTitle")}
        open={open}
        onOk={handleOk}
        onCancel={() => setOpen(false)}
        confirmLoading={addMutation.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="userId"
            label={t("teams.userIdLabel")}
            rules={[{ required: true, message: t("teams.userIdRequired") }]}
          >
            <Input />
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
