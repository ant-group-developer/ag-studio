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
  Typography,
  Tag,
  Empty,
  Space,
  Tooltip,
} from "antd";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../api/studio-client";
import type { Production, ProductionInput } from "../api/studio-client";
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
  description: string;
  goal: string;
  audience: string;
  episodeTargetSeconds: number;
  maxEpisodes: number;
  aspect: "16:9" | "9:16";
  language: string;
  keywordsRaw: string;
}

export function ProductionsPage() {
  const { t } = useTranslation();
  const { teamId: routeTeamId } = useParams<{ teamId: string }>();
  const client = useStudioClient();
  // From the sider (/productions) the team is picked here; from a team (/teams/:id/productions) it is fixed.
  const [pickedTeamId, setPickedTeamId] = useState<string | null>(rememberedTeam());
  const { data: teamsPage, isLoading: loadingTeams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => client.listTeams(),
    enabled: !routeTeamId,
  });
  const teams = teamsPage?.items ?? [];
  const teamId = routeTeamId ?? (teams.some((t) => t.id === pickedTeamId) ? pickedTeamId! : teams[0]?.id);
  useEffect(() => {
    if (teamId) rememberTeam(teamId);
  }, [teamId]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<CreateProductionForm>();

  const { data: productionsPage, isLoading } = useQuery({
    queryKey: ["productions", teamId],
    queryFn: () => client.listTeamProductions(teamId!),
    enabled: !!teamId,
  });
  const productions = productionsPage?.items ?? [];

  const createMutation = useMutation({
    mutationFn: async (values: CreateProductionForm) => {
      const data: ProductionInput = {
        title: values.title,
        description: values.description || undefined,
        goal: values.goal || undefined,
        audience: values.audience || undefined,
        episodeTargetSeconds: values.episodeTargetSeconds,
        maxEpisodes: values.maxEpisodes,
        aspect: values.aspect,
        language: values.language,
        keywords: values.keywordsRaw
          ? values.keywordsRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        sources: [],
      };
      return client.createProduction(teamId!, data);
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
      title: t("productions.columnEpisodes"),
      key: "episodeCounts",
      render: (_: unknown, record: Production) =>
        `${record.episodeCounts.ready}/${record.episodeCounts.total}`,
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
              options={teams.map((team) => ({ value: team.id, label: team.name }))}
              style={{ minWidth: 220 }}
            />
          )}
        </Space>
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
          initialValues={{ aspect: "16:9", language: "vi", episodeTargetSeconds: 300, maxEpisodes: 12 }}
        >
          <Form.Item
            name="title"
            label={t("productions.fieldTitle")}
            rules={[{ required: true, message: t("productions.fieldTitleRequired") }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t("productions.fieldBrief")}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="goal" label={t("productions.fieldGoal")}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="audience" label={t("productions.fieldAudience")}>
            <Input />
          </Form.Item>
          <Form.Item
            name="episodeTargetSeconds"
            label={t("productions.fieldTargetSeconds")}
            rules={[{ required: true, message: t("productions.fieldTargetSecondsRequired") }]}
          >
            <InputNumber min={30} max={3600} style={{ width: "100%" }} addonAfter="s" />
          </Form.Item>
          <Form.Item
            name="maxEpisodes"
            label={t("productions.fieldMaxEpisodes")}
          >
            <InputNumber min={1} max={100} style={{ width: "100%" }} />
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
          <Form.Item name="keywordsRaw" label={t("productions.fieldKeywords")}>
            <Input placeholder={t("productions.keywordsPlaceholder")} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
