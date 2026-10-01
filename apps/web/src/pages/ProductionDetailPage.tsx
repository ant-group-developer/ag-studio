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
import { useStudioClient, StudioHttpError, type RunView } from "../api/studio-client";
import { EnumText, PRODUCTION_STATUS_COLORS } from "../helpers/enum-label";
import { ResearchView } from "../modules/production/ResearchView";
import { PlanEditor } from "../modules/production/PlanEditor";
import { EpisodesPanel } from "../modules/production/EpisodesPanel";
import { LlmLogPanel } from "../modules/production/LlmLogPanel";
import {
  ProductionForm,
} from "../modules/production/ProductionForm";
import type { ProductionFormValues } from "../modules/production/ProductionForm";

const { Title } = Typography;

/**
 * 0-based step of the plan run (`ag-studio-series-plan`): 0 no run yet, 1 intake → research → catalog → trend-report,
 * 2 plan-episodes, 3 waiting at approve-plan, 4 plan approved (spawn-episodes and the episode runs).
 */
export function runToStepIndex(run: RunView | null | undefined): number {
  if (!run) return 0;
  const state = (key: string) => run.stages.find((s) => s.key === key)?.state ?? "PENDING";
  if (state("approve-plan") === "SUCCEEDED") return 4;
  if (run.waiting_gate === "approve-plan") return 3;
  if (state("plan-episodes") !== "PENDING") return 2;
  return 1;
}

/** Card each step scrolls to (Duyệt and Kế hoạch tập share the plan editor). */
const STEP_SECTIONS = ["step-info", "step-research", "step-plan", "step-plan", "step-episodes"];

function scrollToStep(i: number) {
  document.getElementById(STEP_SECTIONS[i]!)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    queryKey: ["run", productionId, production?.runId],
    queryFn: () => client.getRun(productionId!),
    enabled: !!production?.runId,
    // Follow the plan run while it works; a run waiting at the gate or finished does not change by itself.
    refetchInterval: (q) => (q.state.data?.state === "RUNNING" || q.state.data?.state === "CANCEL_REQUESTED" ? 5_000 : false),
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
        targetSeconds: production.episodeTargetSeconds ?? undefined,
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
      episodeTargetSeconds: values.targetSeconds,
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

  const stepIndex = runToStepIndex(run);
  const stepStatus =
    run?.state === "FAILED" || production.status === "failed"
      ? "error"
      : production.status === "done"
        ? "finish"
        : "process";

  const canEdit = !!(access?.hasAccess);
  const planReadOnly = production.status !== "waiting_approval";
  const runIsActive =
    run?.state === "RUNNING" ||
    run?.state === "WAITING" ||
    run?.state === "CANCEL_REQUESTED";

  // Titles only: five descriptions do not fit side by side and were cut off; each lives in the step's tooltip.
  const stepItems = [
    { title: "Thông tin", description: "Cài đặt production" },
    { title: "Nghiên cứu", description: "Nghiên cứu thị trường: phân tích YouTube & xu hướng" },
    { title: "Kế hoạch tập", description: "Danh sách và thứ tự tập" },
    { title: "Duyệt", description: "Duyệt kế hoạch để tạo tập" },
    { title: "Sản xuất các tập", description: "Render, xuất bản, editor" },
  ].map((s, i) => ({
    title: <Tooltip title={s.description}>{s.title}</Tooltip>,
    // A step not reached yet has nothing to show.
    disabled: i > stepIndex,
    // Steps calls onChange only for a step other than the current one.
    ...(i === stepIndex ? { onClick: () => scrollToStep(i) } : {}),
  }));

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
          status={stepStatus}
          items={stepItems}
          size="small"
          style={{ marginBottom: 0 }}
          onChange={scrollToStep}
        />
      </Card>

      {/* Step 0: editable production info */}
      <Card
        id="step-info"
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
          id="step-research"
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
          id="step-plan"
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

      {/* Step 4: Episodes panel (no card title: the episodes table carries its own "Các tập" header) */}
      {stepIndex >= 4 && (
        <Card id="step-episodes" style={{ marginBottom: 16 }} size="small">
          <EpisodesPanel productionId={productionId} canEdit={canEdit} />
        </Card>
      )}

      {/* Call log: every Claude call and every human edit of a model answer (editors whose footage scope covers it) */}
      {canEdit && production.runId !== null && (
        <Card id="step-log" style={{ marginBottom: 16 }} title={t("llmLog.title")} size="small">
          <LlmLogPanel productionId={productionId} live={runIsActive || stepIndex >= 4} />
        </Card>
      )}
    </div>
  );
}
