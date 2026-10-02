/**
 * Production detail page — GĐ3 v4.
 * 6 steps: Thông tin → Nghiên cứu thị trường → R&D → Branding → Kế hoạch tập → Sản xuất các tập
 */
import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Dropdown,
  Form,
  Popconfirm,
  Space,
  Spin,
  Steps,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ChevronLeft, List, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStudioClient, StudioHttpError, type RunView } from "../api/studio-client";
import { EnumText, PRODUCTION_STATUS_COLORS } from "../helpers/enum-label";
import { ResearchView } from "../modules/production/ResearchView";
import { PlanEditor } from "../modules/production/PlanEditor";
import { EpisodesPanel } from "../modules/production/EpisodesPanel";
import { LlmLogPanel } from "../modules/production/LlmLogPanel";
import { RndEditor, RndWritingSpinner } from "../modules/production/RndEditor";
import { BrandingEditor, BrandingWritingSpinner } from "../modules/production/BrandingEditor";
import { PlanRunStages } from "../modules/production/PlanRunStages";
import { gateProblems } from "../modules/production/gate-problems";
import {
  ProductionForm,
} from "../modules/production/ProductionForm";
import type { ProductionFormValues } from "../modules/production/ProductionForm";

const { Title } = Typography;

/**
 * 0-based step of the plan run:
 * 0 = no run, 1 = research, 2 = R&D, 3 = branding, 4 = plan, 5 = episodes
 * V1 runs (no rnd stage) only go 0/1/4/5.
 */
export function runToStepIndex(run: RunView | null | undefined): number {
  if (!run) return 0;
  const state = (key: string) => run.stages.find((s) => s.key === key)?.state ?? "PENDING";
  const isV1 = !run.stages.find((s) => s.key === "rnd");

  if (state("approve-plan") === "SUCCEEDED") return 5;
  if (run.waiting_gate === "approve-plan" || state("plan-episodes") !== "PENDING") return 4;
  if (isV1) return 1;
  if (run.waiting_gate === "approve-branding" || state("branding") !== "PENDING") return 3;
  if (run.waiting_gate === "approve-rnd" || state("rnd") !== "PENDING") return 2;
  return 1;
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

  const {
    data: access,
    isError: accessFailed,
    refetch: refetchAccess,
    isFetching: accessFetching,
  } = useQuery({
    queryKey: ["production-access", productionId],
    queryFn: () => client.checkProductionAccess(productionId!),
    enabled: !!productionId,
  });

  const runId = production?.runId;

  const { data: run } = useQuery({
    queryKey: ["run", productionId, runId],
    queryFn: () => client.getRun(productionId!),
    enabled: !!runId,
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

  // A stage's document exists once the stage succeeded: keyed by its state so it is read when it lands
  const stageState = (key: string) => run?.stages.find((s) => s.key === key)?.state ?? null;
  const rndState = stageState("rnd");
  const brandingState = stageState("branding");
  const briefState = stageState("brief");
  const planState = stageState("plan-episodes");

  // RND draft (Claude's output at rnd stage)
  const { data: rndDraft } = useQuery({
    queryKey: ["doc", productionId, runId, "rnd", "rnd.json", rndState],
    queryFn: () => client.getRndDraft(productionId!),
    enabled: !!runId && rndState === "SUCCEEDED",
  });

  // Production's saved R&D (after approval)
  const { data: productionRndData } = useQuery({
    queryKey: ["production-rnd", productionId],
    queryFn: () => client.getProductionRnd(productionId!),
    enabled: !!(production?.hasRnd),
  });

  // Branding draft
  const { data: brandingDraft } = useQuery({
    queryKey: ["doc", productionId, runId, "branding", "branding.json", brandingState],
    queryFn: () => client.getBrandingDraft(productionId!),
    enabled: !!runId && brandingState === "SUCCEEDED",
  });

  // Production's saved branding (after approval)
  const { data: productionBrandingData } = useQuery({
    queryKey: ["production-branding", productionId],
    queryFn: () => client.getProductionBranding(productionId!),
    enabled: !!(production?.hasBranding),
  });

  // Brief doc (for targetSeconds)
  const { data: briefDoc } = useQuery({
    queryKey: ["doc", productionId, runId, "brief", "brief.json", briefState],
    queryFn: () => client.getBriefDoc(productionId!),
    enabled: !!runId && briefState === "SUCCEEDED",
  });

  const { data: plan } = useQuery({
    queryKey: ["doc", productionId, runId, "plan-episodes", "series-plan.json", planState],
    queryFn: () => client.getSeriesPlan(productionId!),
    enabled: !!runId && planState === "SUCCEEDED",
  });

  // Approved plan (after approve-plan SUCCEEDED)
  const stepIdx = runToStepIndex(run);
  const { data: approvedPlan } = useQuery({
    queryKey: ["doc", productionId, runId, "approve-plan", "series-plan.json"],
    queryFn: () => client.getSeriesPlan(productionId!, "approve-plan"),
    enabled: !!runId && stepIdx >= 5,
  });

  // Step shown on the page: the run's own step, unless an earlier one was picked on the bar.
  // The run moving on brings the page back to where it is.
  const [pickedStep, setPickedStep] = useState<number | null>(null);
  useEffect(() => setPickedStep(null), [stepIdx]);

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
        maxEpisodes: production.maxEpisodes ?? undefined,
        aspect: production.aspect,
        language: production.language,
        sources: production.sources,
        ownChannels: production.ownChannels ?? [],
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
      ownChannels: values.ownChannels ?? [],
      youtubeChannels: values.youtubeChannels ?? [],
      keywords: values.keywords ?? [],
      episodeTargetSeconds: values.targetSeconds ?? null,
      maxEpisodes: values.maxEpisodes ?? null,
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

  // ---- Start run (save first then POST /run) ----
  const startRunMutation = useMutation({
    mutationFn: async () => {
      const input = await collectInput();
      await client.updateProduction(productionId!, input);
      return client.startRun(productionId!);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production", productionId] });
      void queryClient.invalidateQueries({ queryKey: ["run", productionId] });
    },
    onError: (err) => {
      if (err instanceof StudioHttpError && err.body?.code === "episode_producing") {
        void message.error(t("productions.episodeProducing"));
      } else if (err instanceof StudioHttpError && err.body?.code === "nothing_to_research") {
        void message.error(t("productions.atLeastOneResearchSource"));
      } else {
        void message.error(err instanceof Error ? err.message : "Thất bại");
      }
    },
  });

  // ---- Resume / re-run mutations ----
  const resumeMutation = useMutation({
    mutationFn: async (stage: string) => {
      return client.resumeStage(productionId!, stage);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["production", productionId] });
      void queryClient.invalidateQueries({ queryKey: ["run", productionId] });
    },
    onError: (err) => {
      if (err instanceof StudioHttpError && err.body?.code === "episode_producing") {
        void message.error(t("productions.episodeProducing"));
      } else {
        void message.error(err instanceof Error ? err.message : "Thất bại");
      }
    },
  });

  const cancelRunMutation = useMutation({
    mutationFn: () => client.cancelRun(productionId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["run", productionId] });
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "Thất bại");
    },
  });

  // ---- R&D approve mutation ----
  const [rndProblems, setRndProblems] = useState<string[]>([]);
  const approveRndMutation = useMutation({
    mutationFn: (doc: import("@harness/contracts").StudioRnd) => client.submitApproveRnd(productionId!, doc),
    onSuccess: () => {
      setRndProblems([]);
      void queryClient.invalidateQueries({ queryKey: ["production", productionId] });
      void queryClient.invalidateQueries({ queryKey: ["run", productionId] });
      void queryClient.invalidateQueries({ queryKey: ["doc", productionId] });
      void queryClient.invalidateQueries({ queryKey: ["production-rnd", productionId] });
      void message.success(t("rndEditor.approveSuccess"));
    },
    onError: (err: unknown) => {
      setRndProblems(gateProblems(err));
      void message.error(t("rndEditor.approveFailed"));
    },
  });

  // ---- R&D save mutation (PUT) ----
  const [rndWarnings, setRndWarnings] = useState<string[]>([]);
  const saveRndMutation = useMutation({
    mutationFn: (doc: import("@harness/contracts").StudioRnd) => client.putProductionRnd(productionId!, doc),
    onSuccess: (res) => {
      setRndProblems([]);
      setRndWarnings(res.warnings?.map((w) => w.message) ?? []);
      void queryClient.invalidateQueries({ queryKey: ["production-rnd", productionId] });
      void message.success(t("rndEditor.saveSuccess"));
    },
    onError: (err: unknown) => {
      setRndProblems(gateProblems(err));
      void message.error(t("rndEditor.saveFailed"));
    },
  });

  // ---- Branding approve mutation ----
  const [brandingProblems, setBrandingProblems] = useState<string[]>([]);
  const approveBrandingMutation = useMutation({
    mutationFn: (doc: import("@harness/contracts").StudioBranding) => client.submitApproveBranding(productionId!, doc),
    onSuccess: () => {
      setBrandingProblems([]);
      void queryClient.invalidateQueries({ queryKey: ["production", productionId] });
      void queryClient.invalidateQueries({ queryKey: ["run", productionId] });
      void queryClient.invalidateQueries({ queryKey: ["doc", productionId] });
      void queryClient.invalidateQueries({ queryKey: ["production-branding", productionId] });
      void message.success(t("brandingEditor.approveSuccess"));
    },
    onError: (err: unknown) => {
      setBrandingProblems(gateProblems(err));
      void message.error(t("brandingEditor.approveFailed"));
    },
  });

  // ---- Branding save mutation (PUT) ----
  const [brandingWarnings, setBrandingWarnings] = useState<string[]>([]);
  const saveBrandingMutation = useMutation({
    mutationFn: (doc: import("@harness/contracts").StudioBranding) => client.putProductionBranding(productionId!, doc),
    onSuccess: (res) => {
      setBrandingProblems([]);
      setBrandingWarnings(res.warnings?.map((w) => w.message) ?? []);
      void queryClient.invalidateQueries({ queryKey: ["production-branding", productionId] });
      void message.success(t("brandingEditor.saveSuccess"));
    },
    onError: (err: unknown) => {
      setBrandingProblems(gateProblems(err));
      void message.error(t("brandingEditor.saveFailed"));
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
  const stepStatus: "error" | "finish" | "process" =
    run?.state === "FAILED" || production.status === "failed"
      ? "error"
      : production.status === "done"
        ? "finish"
        : "process";

  const canEdit = !!(access?.hasAccess);
  const isV1Run = run ? !run.stages.find((s) => s.key === "rnd") : false;
  const runIsActive =
    run?.state === "RUNNING" ||
    run?.state === "WAITING" ||
    run?.state === "CANCEL_REQUESTED";

  // Determine which plan to show (approved if step >= 5, else draft)
  const planDoc = stepIndex >= 5 ? (approvedPlan ?? plan) : plan;
  const targetSeconds =
    briefDoc?.episode_target_seconds ??
    production.episodeTargetSeconds ??
    300;

  const hasEpisodes = production.episodeCounts.total > 0;

  // Steps items
  const stepDescriptions = [
    t("productions.stepInfoDesc"),
    t("productions.stepResearchDesc"),
    t("productions.stepRndDesc"),
    t("productions.stepBrandingDesc"),
    t("productions.stepPlanDesc"),
    t("productions.stepEpisodesDesc"),
  ];
  const stepTitles = [
    t("productions.stepInfo"),
    t("productions.stepResearch"),
    t("productions.stepRnd"),
    t("productions.stepBranding"),
    t("productions.stepPlan"),
    t("productions.stepEpisodes"),
  ];

  // V1 runs go straight from research to the plan: R&D and branding have nothing to show
  const skipped = (i: number) => isV1Run && (i === 2 || i === 3);
  const viewStep = pickedStep !== null && pickedStep <= stepIndex && !skipped(pickedStep) ? pickedStep : stepIndex;

  // `current` marks the step on view, so each step carries its own progress status
  const stepItems = stepTitles.map((title, i) => ({
    title: <Tooltip title={stepDescriptions[i]}>{title}</Tooltip>,
    disabled: i > stepIndex || skipped(i),
    status: i < stepIndex ? ("finish" as const) : i === stepIndex ? stepStatus : ("wait" as const),
  }));

  // Re-run dropdown items
  const rerunItems = runIsActive
    ? [{
        key: "cancel",
        label: (
          <Popconfirm title={t("productions.rerunConfirmTitle")} onConfirm={() => cancelRunMutation.mutate()}>
            <span>{t("productions.cancelRun")}</span>
          </Popconfirm>
        ),
      }]
    : [
        {
          key: "plan",
          label: (
            <Popconfirm
              title={t("productions.rerunConfirmTitle")}
              description={hasEpisodes ? t("productions.rerunConfirmBody") : undefined}
              onConfirm={() => {
                const resumeStage = isV1Run ? "plan-episodes" : "brief";
                resumeMutation.mutate(resumeStage);
              }}
            >
              <span>{t("productions.rerunPlanEpisodes")}</span>
            </Popconfirm>
          ),
        },
        ...(!isV1Run ? [
          {
            key: "branding",
            label: (
              <Popconfirm
                title={t("productions.rerunConfirmTitle")}
                description={hasEpisodes ? t("productions.rerunConfirmBody") : undefined}
                onConfirm={() => resumeMutation.mutate("approve-rnd")}
              >
                <span>{t("productions.rerunBranding")}</span>
              </Popconfirm>
            ),
          },
          {
            key: "rnd",
            label: (
              <Popconfirm
                title={t("productions.rerunConfirmTitle")}
                description={hasEpisodes ? t("productions.rerunConfirmBody") : undefined}
                onConfirm={() => resumeMutation.mutate("rnd")}
              >
                <span>{t("productions.rerunRnd")}</span>
              </Popconfirm>
            ),
          },
        ] : []),
        {
          key: "scratch",
          label: (
            <Popconfirm
              title={t("productions.rerunConfirmTitle")}
              description={hasEpisodes ? t("productions.rerunConfirmBody") : undefined}
              onConfirm={() => startRunMutation.mutate()}
            >
              <span>{t("productions.rerunFromScratch")}</span>
            </Popconfirm>
          ),
        },
      ];

  // R&D card logic
  const waitingApproveRnd = run?.waiting_gate === "approve-rnd";
  const rndStage = run?.stages.find((s) => s.key === "rnd");
  const rndStageRunning = rndStage?.state === "RUNNING" || rndStage?.state === "CLAIMED";
  // A run resumed from approve-rnd reuses Claude's R&D: the gate starts from the R&D in use (with any edit made
  // after the first approval), not from Claude's draft
  const rndDocForGate = rndStage?.reused ? (productionRndData?.document ?? rndDraft) : rndDraft;
  const rndDocForEdit = productionRndData?.document;

  // Branding card logic
  const waitingApproveBranding = run?.waiting_gate === "approve-branding";
  const brandingStage = run?.stages.find((s) => s.key === "branding");
  const brandingStageRunning = brandingStage?.state === "RUNNING" || brandingStage?.state === "CLAIMED";
  const brandingDocForGate = brandingStage?.reused ? (productionBrandingData?.document ?? brandingDraft) : brandingDraft;
  const brandingDocForEdit = productionBrandingData?.document;

  const showV2Rnd = !isV1Run && stepIndex >= 2;
  const showV2Branding = !isV1Run && stepIndex >= 3;

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

      {/* The access check failing hides saving and running: say so instead of leaving the page without buttons */}
      {!access && accessFailed && (
        <Alert
          type="error"
          message={t("productions.accessCheckFailedTitle")}
          description={t("productions.accessCheckFailedDescription")}
          showIcon
          action={
            <Button size="small" loading={accessFetching} onClick={() => refetchAccess()}>
              {t("productions.accessCheckRetry")}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {/* 6-step progress bar */}
      <Card style={{ marginBottom: 16 }} size="small">
        <Steps
          type="navigation"
          current={viewStep}
          items={stepItems}
          size="small"
          style={{ marginBottom: 0 }}
          onChange={setPickedStep}
        />
      </Card>

      {/* PlanRunStages — failed/waiting non-gate stages, whatever step is on view */}
      {run && (
        <PlanRunStages
          productionId={productionId}
          stages={run.stages}
          canEdit={canEdit}
        />
      )}

      {/* One step on view at a time. Steps reached stay mounted (hidden) so the form and unsaved edits keep */}
      {/* their state when another step is looked at */}

      {/* Step 0: editable production info */}
      <Card
        id="step-info"
        hidden={viewStep !== 0}
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
        <ProductionForm
          form={form}
          readOnly={!canEdit}
          directionApproved={production.hasRnd}
        />

        {canEdit && (
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <Tooltip title={t("productions.saveInfo")}>
              <Button
                onClick={() => saveMutation.mutate()}
                loading={saveMutation.isPending}
                aria-label={t("productions.saveInfo")}
              >
                {t("productions.saveInfo")}
              </Button>
            </Tooltip>

            {production.runId === null ? (
              <Button
                type="primary"
                loading={startRunMutation.isPending}
                disabled={runIsActive}
                onClick={() => startRunMutation.mutate()}
              >
                {t("productions.startResearch")}
              </Button>
            ) : (
              <Dropdown
                trigger={["click"]}
                menu={{ items: rerunItems }}
                disabled={startRunMutation.isPending || resumeMutation.isPending || cancelRunMutation.isPending}
              >
                <Tooltip title={t("productions.rerunMenu")}>
                  <Button
                    icon={<MoreHorizontal size={14} />}
                    aria-label={t("productions.rerunMenu")}
                  />
                </Tooltip>
              </Dropdown>
            )}
          </div>
        )}
      </Card>

      {/* Step 1: Research + Trend Report */}
      {stepIndex >= 1 && (
        <Card
          id="step-research"
          hidden={viewStep !== 1}
          style={{ marginBottom: 16 }}
          title={t("productions.stepResearch")}
          size="small"
        >
          <ResearchView
            productionId={productionId}
            research={research ?? null}
            trendReport={trendReport ?? null}
          />
        </Card>
      )}

      {/* Step 2: R&D (v2 runs only) */}
      {showV2Rnd && (
        <Card
          id="step-rnd"
          hidden={viewStep !== 2}
          style={{ marginBottom: 16 }}
          title={t("productions.stepRnd")}
          size="small"
        >
          {waitingApproveRnd && rndDocForGate ? (
            <RndEditor
              key={runId}
              value={rndDocForGate}
              readOnly={!canEdit}
              primaryLabel={t("rndEditor.approveButton")}
              onSubmit={(doc) => approveRndMutation.mutateAsync(doc)}
              submitting={approveRndMutation.isPending}
              problems={rndProblems}
            />
          ) : rndStageRunning ? (
            <RndWritingSpinner />
          ) : rndDocForEdit ? (
            <>
              {production.hasRnd && (
                <Alert
                  type="info"
                  message={t("rndEditor.editNote")}
                  showIcon
                  style={{ marginBottom: 12 }}
                />
              )}
              <RndEditor
                key={runId}
                value={rndDocForEdit}
                readOnly={!canEdit}
                primaryLabel={t("rndEditor.saveButton")}
                onSubmit={(doc) => saveRndMutation.mutateAsync(doc)}
                submitting={saveRndMutation.isPending}
                problems={rndProblems}
                warnings={rndWarnings}
              />
            </>
          ) : rndDraft ? (
            <RndEditor
              key={runId}
              value={rndDraft}
              readOnly={!canEdit}
              primaryLabel={t("rndEditor.saveButton")}
              onSubmit={(doc) => saveRndMutation.mutateAsync(doc)}
              submitting={saveRndMutation.isPending}
              problems={rndProblems}
              warnings={rndWarnings}
            />
          ) : null}
        </Card>
      )}

      {/* Step 3: Branding (v2 runs only) */}
      {showV2Branding && (
        <Card
          id="step-branding"
          hidden={viewStep !== 3}
          style={{ marginBottom: 16 }}
          title={t("productions.stepBranding")}
          size="small"
        >
          {waitingApproveBranding && brandingDocForGate ? (
            <BrandingEditor
              key={runId}
              value={brandingDocForGate}
              readOnly={!canEdit}
              primaryLabel={t("brandingEditor.approveButton")}
              onSubmit={(doc) => approveBrandingMutation.mutateAsync(doc)}
              submitting={approveBrandingMutation.isPending}
              problems={brandingProblems}
            />
          ) : brandingStageRunning ? (
            <BrandingWritingSpinner />
          ) : brandingDocForEdit ? (
            <>
              {production.hasBranding && (
                <Alert
                  type="info"
                  message={t("brandingEditor.editNote")}
                  showIcon
                  style={{ marginBottom: 12 }}
                />
              )}
              <BrandingEditor
                key={runId}
                value={brandingDocForEdit}
                readOnly={!canEdit}
                primaryLabel={t("brandingEditor.saveButton")}
                onSubmit={(doc) => saveBrandingMutation.mutateAsync(doc)}
                submitting={saveBrandingMutation.isPending}
                problems={brandingProblems}
                warnings={brandingWarnings}
              />
            </>
          ) : brandingDraft ? (
            <BrandingEditor
              key={runId}
              value={brandingDraft}
              readOnly={!canEdit}
              primaryLabel={t("brandingEditor.saveButton")}
              onSubmit={(doc) => saveBrandingMutation.mutateAsync(doc)}
              submitting={saveBrandingMutation.isPending}
              problems={brandingProblems}
              warnings={brandingWarnings}
            />
          ) : null}
        </Card>
      )}

      {/* Step 4: Plan editor */}
      {stepIndex >= 4 && planDoc && (
        <Card
          id="step-plan"
          hidden={viewStep !== 4}
          style={{ marginBottom: 16 }}
          title={t("productions.stepPlan")}
          size="small"
        >
          {stepIndex >= 5 && (
            <Alert
              type="info"
              message={t("planEditor.approvedPlanNote")}
              showIcon
              style={{ marginBottom: 12 }}
            />
          )}
          <PlanEditor
            key={runId}
            productionId={productionId}
            plan={planDoc}
            catalog={catalog ?? null}
            targetSeconds={targetSeconds}
            readOnly={stepIndex >= 5}
          />
        </Card>
      )}

      {/* Step 5: Episodes panel */}
      {stepIndex >= 5 && (
        <Card id="step-episodes" hidden={viewStep !== 5} style={{ marginBottom: 16 }} size="small">
          <EpisodesPanel productionId={productionId} canEdit={canEdit} />
        </Card>
      )}

      {/* Call log */}
      {canEdit && production.runId !== null && (
        <Card id="step-log" style={{ marginBottom: 16 }} title={t("llmLog.title")} size="small">
          <LlmLogPanel productionId={productionId} live={runIsActive || stepIndex >= 5} />
        </Card>
      )}
    </div>
  );
}
