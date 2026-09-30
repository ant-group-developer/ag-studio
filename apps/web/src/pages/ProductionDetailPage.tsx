/**
 * Production detail page — GĐ3 v3.
 * 5 steps driven by RunView stage keys: Thông tin → Nghiên cứu → Kế hoạch tập → Duyệt → Sản xuất các tập
 */
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Card,
  Descriptions,
  Space,
  Spin,
  Steps,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ChevronLeft, List } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../api/studio-client";
import { EnumText, PRODUCTION_STATUS_COLORS } from "../helpers/enum-label";
import { ResearchView } from "../modules/production/ResearchView";
import { PlanEditor } from "../modules/production/PlanEditor";
import { EpisodesPanel } from "../modules/production/EpisodesPanel";

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
  const lastSucceeded = [...stageKeys].reverse().find((k) => k === "plan-episodes" || k === "research" || k === "trend-report");
  if (lastSucceeded?.includes("plan")) return 3;
  if (lastSucceeded?.includes("research") || lastSucceeded?.includes("trend")) return 1;
  return 0;
}

export function ProductionDetailPage() {
  const { t } = useTranslation();
  const { productionId } = useParams<{ productionId: string }>();
  const client = useStudioClient();

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

  if (isLoading) return <div style={{ padding: 48, textAlign: "center" }}><Spin /></div>;
  if (!production || !productionId) return <div>{t("productions.notFound")}</div>;

  const stageKeys = run?.stages.map((s) => s.key) ?? [];
  const stepIndex = runToStepIndex(run?.state ?? null, run?.waiting_gate ?? null, stageKeys);

  const canEdit = !!(access?.hasAccess);
  const planReadOnly = production.status !== "waiting_approval";

  const stepItems = [
    {
      title: "Thông tin",
      description: "Cài đặt production",
    },
    {
      title: "Nghiên cứu thị trường",
      description: "Phân tích YouTube & xu hướng",
    },
    {
      title: "Kế hoạch tập",
      description: "Danh sách và thứ tự tập",
    },
    {
      title: "Duyệt",
      description: "Duyệt kế hoạch để tạo tập",
    },
    {
      title: "Sản xuất các tập",
      description: "Render, xuất bản, editor",
    },
  ];

  return (
    <div>
      <Link to={`/teams/${production.teamId}/productions`}>
        <Tooltip title={t("productions.backToList")}>
          <ChevronLeft size={16} style={{ verticalAlign: "middle" }} />
        </Tooltip>
        {" "}{t("productions.backToList")}
      </Link>
      <Title level={3} style={{ marginTop: 8 }}>{production.title}</Title>

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

      {/* Step 0: production info */}
      <Card style={{ marginBottom: 16 }}>
        <Descriptions bordered column={2} size="small">
          <Descriptions.Item label={t("productions.detailFieldTitle")}>{production.title}</Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldStatus")}>
            <Tag color={PRODUCTION_STATUS_COLORS[production.status]}>
              <EnumText group="productionStatus" code={production.status} />
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldBrief")} span={2}>
            {production.description || t("productions.empty")}
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldGoal")} span={2}>
            {production.goal || t("productions.empty")}
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldAspect")}>
            <EnumText group="aspect" code={production.aspect} />
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldTargetSeconds")}>
            {production.episodeTargetSeconds ? `${production.episodeTargetSeconds}s` : t("productions.empty")}
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldLanguage")}>
            <EnumText group="language" code={production.language} />
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldEpisodes")}>
            <Space>
              <List size={14} />
              {production.episodeCounts.total}
              {production.episodeCounts.ready > 0 && (
                <Tag color="green">{t("productions.episodesReady", { count: production.episodeCounts.ready })}</Tag>
              )}
            </Space>
          </Descriptions.Item>
          {production.sources.length > 0 && (
            <Descriptions.Item label={t("productions.detailFieldSources")} span={2}>
              <Space size={[4, 4]} wrap>
                {production.sources.map((id) => <Tag key={id}>{id}</Tag>)}
              </Space>
            </Descriptions.Item>
          )}
          {production.keywords.length > 0 && (
            <Descriptions.Item label={t("productions.detailFieldKeywords")} span={2}>
              <Space size={[4, 4]} wrap>
                {production.keywords.map((kw) => <Tag key={kw}>{kw}</Tag>)}
              </Space>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      {/* Step 1+2: Research + Trend Report */}
      {stepIndex >= 1 && (
        <Card style={{ marginBottom: 16 }} title="Nghiên cứu thị trường" size="small">
          <ResearchView
            productionId={productionId}
            research={research ?? null}
            trendReport={trendReport ?? null}
          />
        </Card>
      )}

      {/* Step 2+3: Plan editor */}
      {stepIndex >= 2 && plan && (
        <Card style={{ marginBottom: 16 }} title="Kế hoạch tập" size="small">
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
