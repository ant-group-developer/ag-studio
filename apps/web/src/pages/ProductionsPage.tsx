import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  TreeSelect,
  Typography,
  Tag,
  Empty,
  Space,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useAuth0 } from "@auth0/auth0-react";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../api/studio-client";
import type { Production, CreateProductionData } from "../api/studio-client";
import { getFolders } from "../api/ag-go-client";
import { buildFolderTree } from "../helpers/folder-tree";
import { EnumText, PRODUCTION_STATUS_COLORS } from "../helpers/enum-label";
import { PAGE_TABLE_STICKY } from "../helpers/sticky-table-header";
import type { ColumnsType } from "antd/es/table";

const { Title } = Typography;

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
    // private mode: the choice just isn't remembered
  }
}

const ASPECT_RATIOS = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
];

interface CreateProductionForm {
  title: string;
  brief: string;
  targetSeconds: number;
  aspect: "16:9" | "9:16";
  language: string;
  folderIds: string[];
}

export function ProductionsPage() {
  const { t } = useTranslation();
  const { teamId: routeTeamId } = useParams<{ teamId: string }>();
  const client = useStudioClient();
  // From the sider (/productions) the team is picked here; from a team (/teams/:id/productions) it is fixed.
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(rememberedTeam());
  const { data: teams, isLoading: loadingTeams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => client.listTeams(),
    enabled: !routeTeamId,
  });
  const teamId = routeTeamId ?? (teams?.some((t) => t.id === pickedTeamId) ? pickedTeamId! : teams?.[0]?.id);
  useEffect(() => {
    if (teamId) rememberTeam(teamId);
  }, [teamId]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { getAccessTokenSilently } = useAuth0();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<CreateProductionForm>();

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
    mutationFn: async (values: CreateProductionForm) => {
      const data: CreateProductionData = {
        title: values.title,
        brief: values.brief,
        targetSeconds: values.targetSeconds,
        aspect: values.aspect,
        language: values.language,
      };
      const production = await client.createProduction(teamId!, data);
      if (values.folderIds?.length) {
        await client.setProductionSources(production.id, values.folderIds);
      }
      return production;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["productions", teamId] });
      setOpen(false);
      form.resetFields();
    },
  });

  const columns: ColumnsType<Production> = [
    {
      title: t("productions.columnTitle"),
      dataIndex: "title",
      key: "title",
      render: (title: string, record: Production) => (
        <a onClick={() => navigate(`/productions/${record.id}`)}>{title}</a>
      ),
    },
    {
      title: t("productions.columnStatus"),
      dataIndex: "status",
      key: "status",
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
      render: (aspect: string) => <EnumText group="aspect" code={aspect} />,
    },
    {
      title: t("productions.columnTargetSeconds"),
      dataIndex: "targetSeconds",
      key: "targetSeconds",
      render: (v: number | null) => (v ? `${v}s` : t("productions.empty")),
    },
  ];

  if (!routeTeamId && !loadingTeams && teams && teams.length === 0) {
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

  const handleOk = () => {
    form.validateFields().then((values) => {
      createMutation.mutate(values);
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
        <Space align="center" size={16}>
          <Title level={3} style={{ margin: 0 }}>{t("productions.title")}</Title>
          {!routeTeamId && (
            <Select
              aria-label={t("productions.teamLabel")}
              placeholder={t("productions.teamPlaceholder")}
              loading={loadingTeams}
              value={teamId}
              onChange={(id: string) => setPickedTeamId(id)}
              options={(teams ?? []).map((team) => ({ value: team.id, label: team.name }))}
              style={{ minWidth: 220 }}
            />
          )}
        </Space>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={!teamId}
          onClick={() => setOpen(true)}
        >
          {t("productions.create")}
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={productions}
        rowKey="id"
        loading={isLoading}
        sticky={PAGE_TABLE_STICKY}
      />

      <Modal
        title={t("productions.createTitle")}
        open={open}
        onOk={handleOk}
        onCancel={() => setOpen(false)}
        confirmLoading={createMutation.isPending}
        width={600}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ aspect: "16:9", language: "vi", targetSeconds: 60 }}
        >
          <Form.Item
            name="title"
            label={t("productions.fieldTitle")}
            rules={[{ required: true, message: t("productions.fieldTitleRequired") }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="brief" label={t("productions.fieldBrief")}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="targetSeconds"
            label={t("productions.fieldTargetSeconds")}
            rules={[{ required: true, message: t("productions.fieldTargetSecondsRequired") }]}
          >
            <InputNumber min={10} max={1800} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="aspect"
            label={t("productions.fieldAspect")}
            rules={[{ required: true, message: t("productions.fieldAspectRequired") }]}
          >
            <Select options={ASPECT_RATIOS} />
          </Form.Item>
          <Form.Item name="language" label={t("productions.fieldLanguage")}>
            <Input />
          </Form.Item>
          <Form.Item name="folderIds" label={t("productions.fieldSourceFolders")}>
            <TreeSelect
              treeData={treeData}
              multiple
              treeCheckable
              showCheckedStrategy={TreeSelect.SHOW_PARENT}
              placeholder={t("productions.sourceFoldersPlaceholder")}
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
