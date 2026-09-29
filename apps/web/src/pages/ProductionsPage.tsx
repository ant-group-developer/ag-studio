import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  TreeSelect,
  Typography,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useAuth0 } from "@auth0/auth0-react";
import { useStudioClient } from "../api/studio-client";
import type { Production, CreateProductionData } from "../api/studio-client";
import { getFolders } from "../api/ag-go-client";
import { buildFolderTree } from "../helpers/folder-tree";
import type { ColumnsType } from "antd/es/table";

const { Title } = Typography;

const ASPECT_RATIOS = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
];

export function ProductionsPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { getAccessTokenSilently } = useAuth0();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{
    title: string;
    brief: string;
    aspectRatio: string;
    folderIds: string[];
  }>();

  const { data: productions = [], isLoading } = useQuery({
    queryKey: ["productions", teamId],
    queryFn: () => client.listProductions(teamId!),
    enabled: !!teamId,
  });

  const { data: folderData } = useQuery({
    queryKey: ["folders"],
    queryFn: async () => {
      const token = await getAccessTokenSilently();
      if (!token) throw new Error("No token");
      return getFolders(token);
    },
    enabled: open,
  });

  const folderTree = folderData ? buildFolderTree(folderData.folders) : [];

  const treeData = folderTree.map(function mapNode(node): object {
    return {
      value: node.key,
      title: `${node.title} (${node.usableSegments})`,
      children: node.children.map(mapNode),
    };
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateProductionData) =>
      client.createProduction(teamId!, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["productions", teamId] });
      setOpen(false);
      form.resetFields();
    },
  });

  const columns: ColumnsType<Production> = [
    {
      title: "Production",
      dataIndex: "title",
      key: "title",
      render: (title: string, record: Production) => (
        <a onClick={() => navigate(`/productions/${record.id}`)}>{title}</a>
      ),
    },
    {
      title: "Trạng thái",
      dataIndex: "status",
      key: "status",
    },
    {
      title: "Tỉ lệ khung hình",
      dataIndex: "aspectRatio",
      key: "aspectRatio",
    },
  ];

  const handleOk = () => {
    form.validateFields().then((values) => {
      createMutation.mutate({
        title: values.title,
        brief: values.brief,
        aspectRatio: values.aspectRatio,
        folderIds: values.folderIds ?? [],
      });
    });
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <Title level={3}>Production</Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setOpen(true)}
        >
          Tạo production mới
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={productions}
        rowKey="id"
        loading={isLoading}
      />

      <Modal
        title="Tạo production mới"
        open={open}
        onOk={handleOk}
        onCancel={() => setOpen(false)}
        confirmLoading={createMutation.isPending}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label="Tiêu đề"
            rules={[{ required: true, message: "Vui lòng nhập tiêu đề" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="brief" label="Tóm tắt">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="aspectRatio"
            label="Tỉ lệ khung hình"
            rules={[{ required: true, message: "Vui lòng chọn tỉ lệ khung hình" }]}
          >
            <Select options={ASPECT_RATIOS} />
          </Form.Item>
          <Form.Item name="folderIds" label="Chọn thư mục nguồn">
            <TreeSelect
              treeData={treeData}
              multiple
              treeCheckable
              showCheckedStrategy={TreeSelect.SHOW_PARENT}
              placeholder="Chọn thư mục nguồn"
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
