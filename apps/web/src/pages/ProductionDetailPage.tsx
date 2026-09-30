/**
 * Production detail page — GĐ3 v3.
 * 5 steps driven by RunView stage keys: Thông tin → Nghiên cứu → Kế hoạch tập → Duyệt → Sản xuất các tập
 */
import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Popconfirm,
  Space,
  Spin,
  Steps,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ChevronLeft, List } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStudioClient, StudioHttpError } from "../api/studio-client";
import { EnumText, PRODUCTION_STATUS_COLORS } from "../helpers/enum-label";
import { ResearchView } from "../modules/production/ResearchView";
import { PlanEditor } from "../modules/production/PlanEditor";
import { EpisodesPanel } from "../modules/production/EpisodesPanel";
import {
  ProductionForm,
  mmssToSeconds,
  secondsToMmss,
} from "../modules/production/ProductionForm";
import type { ProductionFormValues } from "../modules/production/ProductionForm";

const { Title } = Typography;

/** Map a RunView's waiting_gate / latest finished stage to the 0-based step index */
function runToStepIndex(
  runState: string | null,
  waitingGate: string | null,
  stageKeys: string[],
): number {
  if (!runState || runState === "DRAFT") return 0;
  if (waitingGate === "approve-plan") return 2;
  if (waitingGate === "approve-treatment") return 3;
  const lastSucceeded = [...stageKeys]
    .reverse()
    .find(
      (k) => k === "plan-episodes" || k === "research" || k === "trend-report",
    );
  if (lastSucceeded?.includes("plan")) return 3;
  if (lastSucceeded?.includes("research") || lastSucceeded?.includes("trend"))
    return 1;
  return 0;
}

/** Extract music input from form values (null when musicTrack is absent). */
function buildMusicInput(values: ProductionFormValues) {
  return values.musicTrack
    ? {
        track: values.musicTrack,
        gainDb: values.musicGainDb ?? 0,
        ducking: values.musicDucking ?? false,
      }
    : null;
}

export function ProductionDetailPage() {
  const { t } = useTranslation();
  const { productionId } = useParams<{ productionId: string }>();
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const [form] = Form.useForm<ProductionFormValues>();

  const { data: production, isLoading } = useQuery({
    queryKey: ["production", productionId],
    queryFn: () => client.getProduction(productionId!),
    enabled: !!productionId,
  });

  const { data: access } = useQuery({
    queryKey: ["production-access", productionId],
    queryFn: () => client.checkProductionAccess(productionId!),
    enabled: !!productionId,
  });

  const { data: run } = useQuery({
    queryKey: ["run", production?.runId],
    queryFn: () => client.getRun(production!.runId!),
    enabled: !!production?.runId,
  });

  const { data: research } = useQuery({
    queryKey: ["research", productionId],
    queryFn: () => client.getResearch(productionId!),
    enabled: !!productionId,
  });

  const { data: trendReport } = useQuery({
    queryKey: ["trend-report", productionId],
    queryFn: () => client.getTrendReport(productionId!),
    enabled: !!productionId,
  });

  const { data: plan } = useQuery({
    queryKey: ["series-plan", productionId],
    queryFn: () => client.getSeriesPlan(productionId!),
    enabled: !!productionId,
  });

  const { data: catalog } = useQuery({
    queryKey: ["catalog", productionId],
    queryFn: () => client.getProductionCatalog(productionId!),
    enabled: !!productionId,
  });

  // ---- Initialise form when production loads ----
  useEffect(() => {
    if (production) {
      form.setFieldsValue({
        title: production.title,
        description: production.description || undefined,
        goal: production.goal || undefined,
        audience: production.audience || undefined,
        tone: production.tone || undefined,
        notes: production.notes || undefined,
        durationMmSs: production.episodeTargetSeconds
          ? secondsToMmss(production.episodeTargetSeconds)
          : undefined,
        maxEpisodes: production.maxEpisodes,
        aspect: production.aspect,
        language: production.language,
        sources: production.sources,
        youtubeChannels: production.youtubeChannels,
        keywords: production.keywords,
        musicTrack: production.music?.track,
        musicGainDb: production.music?.gainDb,
        musicDucking: production.music?.ducking,
      });
    }
  }, [production, form]);

  // ---- Shared helper: extract ProductionInput from current form ----
  async function collectInput() {
    const values = await form.validateFields();
    return {
      title: values.title,
      description: values.description,
      goal: values.goal,
      audience: values.audience,
      tone: values.tone,
      notes: values.notes,
      sources: values.sources ?? [],
      youtubeChannels: values.youtubeChannels ?? [],
      keywords: values.keywords ?? [],
      episodeTargetSeconds: values.durationMmSs
        ? mmssToSeconds(values.durationMmSs)
        : undefined,
      maxEpisodes: values.maxEpisodes,
      aspect: values.aspect,
      language: values.language,
      music: buildMusicInput(values),
    };
  }

  // ---- Save mutation ----
  const saveMutation = useMutation({
    mutationFn: async () => {
      const input = await collectInput();
      return client.updateProduction(productionId!, input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production", productionId] });
      void message.success(t("productions.saveInfo"));
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "Lưu thất bại");
    },
  });

  // ---- Run (plan / replan) mutation ----
  const runMutation = useMutation({
    mutationFn: async (saveFirst: boolean) => {
      if (saveFirst) {
        const input = await collectInput();
        await client.updateProduction(productionId!, input);
      }
      return client.startRun(productionId!);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production", productionId] });
    },
    onError: (err) => {
      if (
        err instanceof StudioHttpError &&
        err.body?.code === "episode_producing"
      ) {
        void message.error(t("productions.episodeProducing"));
      } else {
        void message.error(err instanceof Error ? err.message : "Thất bại");
      }
    },
  });

  if (isLoading)
    return (
      <div style={{ padding: 48, textAlign: "center" }}>
        <Spin />
      </div>
    );
  if (!production || !productionId)
    return <div>{t("productions.notFound")}</div>;

  const stageKeys = run?.stages.map((s) => s.key) ?? [];
  const stepIndex = runToStepIndex(
    run?.state ?? null,
    run?.waiting_gate ?? null,
    stageKeys,
  );

  const canEdit = !!(access?.hasAccess);
  const planReadOnly = production.status !== "waiting_approval";
  const runIsActive =
    run?.state === "RUNNING" ||
    run?.state === "WAITING" ||
    run?.state === "CANCEL_REQUESTED";

  const stepItems = [
    { title: "Thông tin", description: "Cài đặt production" },
    { title: "Nghiên cứu thị trường", description: "Phân tích YouTube & xu hướng" },
    { title: "Kế hoạch tập", description: "Danh sách và thứ tự tập" },
    { title: "Duyệt", description: "Duyệt kế hoạch để tạo tập" },
    { title: "Sản xuất các tập", description: "Render, xuất bản, editor" },
  ];

  return (
    <div>
      <Link to={`/teams/${production.teamId}/productions`}>
        <Tooltip title={t("productions.backToList")}>
          <ChevronLeft size={16} style={{ verticalAlign: "middle" }} />
        </Tooltip>
        {" "}
        {t("productions.backToList")}
      </Link>
      <Title level={3} style={{ marginTop: 8 }}>
        {production.title}
      </Title>

      {access && !access.hasAccess && (
        <Alert
          type="warning"
          message={t("productions.viewOnlyTitle")}
          description={t("productions.viewOnlyDescription")}
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* 5-step progress bar */}
      <Card style={{ marginBottom: 16 }} size="small">
        <Steps
          current={stepIndex}
          items={stepItems}
          size="small"
          style={{ marginBottom: 0 }}
          onChange={() => {}}
        />
      </Card>

      {/* Step 0: editable production info */}
      <Card
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Tag color={PRODUCTION_STATUS_COLORS[production.status]}>
              <EnumText group="productionStatus" code={production.status} />
            </Tag>
            <Space size={4}>
              <List size={14} />
              {production.episodeCounts.total}
            </Space>
          </Space>
        }
      >
        <ProductionForm form={form} readOnly={!canEdit} />

        {canEdit && (
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <Button
              onClick={() => saveMutation.mutate()}
              loading={saveMutation.isPending}
            >
              {t("productions.saveInfo")}
            </Button>

            {production.runId === null ? (
              <Button
                type="primary"
                loading={runMutation.isPending}
                disabled={runIsActive}
                onClick={() => runMutation.mutate(false)}
              >
                {t("productions.startPlan")}
              </Button>
            ) : (
              <Popconfirm
                title={t("productions.replanConfirmTitle")}
                description={t("productions.replanConfirmBody")}
                onConfirm={() => runMutation.mutate(true)}
                disabled={runMutation.isPending || runIsActive}
              >
                <Button loading={runMutation.isPending} disabled={runIsActive}>
                  {runIsActive
                    ? t("productions.planRunning")
                    : t("productions.replanButton")}
                </Button>
              </Popconfirm>
            )}
          </div>
        )}
      </Card>

      {/* Step 1+2: Research + Trend Report */}
      {stepIndex >= 1 && (
        <Card
          style={{ marginBottom: 16 }}
          title="Nghiên cứu thị trường"
          size="small"
        >
          <ResearchView
            productionId={productionId}
            research={research ?? null}
            trendReport={trendReport ?? null}
          />
        </Card>
      )}

      {/* Step 2+3: Plan editor */}
      {stepIndex >= 2 && plan && (
        <Card
          style={{ marginBottom: 16 }}
          title="Kế hoạch tập"
          size="small"
        >
          <PlanEditor
            productionId={productionId}
            plan={plan}
            catalog={catalog ?? null}
            targetSeconds={production.episodeTargetSeconds ?? 300}
            readOnly={planReadOnly}
          />
        </Card>
      )}

      {/* Step 4: Episodes panel */}
      {stepIndex >= 4 && (
        <Card style={{ marginBottom: 16 }} title="Các tập" size="small">
          <EpisodesPanel productionId={productionId} canEdit={canEdit} />
        </Card>
      )}
    </div>
  );
}
