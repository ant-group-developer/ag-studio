import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Table, Button, Modal, Form, Input, Select, Typography, Popconfirm } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useStudioClient } from "../api/studio-client";
import type { TeamMember } from "../api/studio-client";
import type { ColumnsType } from "antd/es/table";

const { Title } = Typography;

const ROLES = [
  { value: "owner", label: "Owner" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" },
];

export function TeamDetailPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ userId: string; role: string }>();

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
      title: "User ID",
      dataIndex: "userId",
      key: "userId",
    },
    {
      title: "Vai trò",
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
      title: "Hành động",
      key: "actions",
      render: (_: unknown, record: TeamMember) => (
        <Popconfirm
          title="Xóa thành viên này?"
          onConfirm={() => removeMutation.mutate(record.userId)}
        >
          <Button danger size="small">
            Xóa
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
        <Title level={3}>Thành viên nhóm</Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setOpen(true)}
        >
          Thêm thành viên
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={members}
        rowKey="userId"
        loading={isLoading}
      />

      <Modal
        title="Thêm thành viên"
        open={open}
        onOk={handleOk}
        onCancel={() => setOpen(false)}
        confirmLoading={addMutation.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="userId"
            label="User ID"
            rules={[{ required: true, message: "Vui lòng nhập User ID" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="role"
            label="Vai trò"
            rules={[{ required: true, message: "Vui lòng chọn vai trò" }]}
          >
            <Select options={ROLES} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
