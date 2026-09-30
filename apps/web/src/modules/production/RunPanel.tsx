/**
 * Shows the plan run stages and handles gates for the production (v3).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, List, Space, Spin, Tag, Typography, Tooltip } from "antd";
import { RefreshCw, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStudioClient, StudioHttpError } from "../../api/studio-client";
import type { StageView } from "../../api/studio-client";
import { EnumText } from "../../helpers/enum-label";

const { Text } = Typography;

const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

function stageTagColor(state: string): string {
  switch (state) {
    case "SUCCEEDED": return "green";
    case "FAILED": return "red";
    case "RUNNING": return "blue";
    case "WAITING_HUMAN":
    case "WAITING": return "gold";
    default: return "default";
  }
}

function StageRow({ stage, productionId, runEnded }: { stage: StageView; productionId: string; runEnded: boolean }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const queryClient = useQueryClient();

  const retryMutation = useMutation({
    mutationFn: () => client.retryStage(productionId, stage.key),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["run", productionId] }),
  });
  const resumeMutation = useMutation({
    mutationFn: () => client.resumeStage(productionId, stage.key),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["run", productionId] }),
  });

  const canRetry = !runEnded && !stage.is_gate && (stage.state === "FAILED" || stage.state === "WAITING_HUMAN");
  const canResume = runEnded && !stage.is_gate;

  return (
    <List.Item
      actions={
        canResume
          ? [<Tooltip key="resume" title={t("run.resumeFromHere")}><Button size="small" icon={<RefreshCw size={14} />} loading={resumeMutation.isPending} onClick={() => resumeMutation.mutate()} aria-label={t("run.resumeFromHere")} /></Tooltip>]
          : canRetry
          ? [<Tooltip key="retry" title={t("run.retry")}><Button size="small" icon={<RefreshCw size={14} />} loading={retryMutation.isPending} onClick={() => retryMutation.mutate()} aria-label={t("run.retry")} /></Tooltip>]
          : []
      }
    >
      <List.Item.Meta
        title={
          <Space>
            <Text strong><EnumText group="stage" code={stage.key} /></Text>
            <Tag color={stageTagColor(stage.state)}><EnumText group="stageState" code={stage.state} /></Tag>
            {stage.is_gate && <Tag>{t("run.gateTag")}</Tag>}
            {stage.attempts > 1 && <Text type="secondary">{t("run.attempt", { count: stage.attempts })}</Text>}
          </Space>
        }
        description={
          stage.error || stage.failed_checks.length ? (
            <div>
              {stage.error && <Text type="danger">{stage.error}</Text>}
              {stage.failed_checks.map((c) => (
                <div key={c.check_id}>
                  <Text type="danger">- <EnumText group="check" code={c.check_id} /></Text>
                  {Array.isArray((c.evidence as { problems?: unknown[] }).problems) &&
                    ((c.evidence as { problems: { code: string; message: string }[] }).problems).map((p, i) => (
                      <div key={i} style={{ paddingLeft: 12 }}>
                        <Text type="secondary">{p.code}: {p.message}</Text>
                      </div>
                    ))}
                </div>
              ))}
            </div>
          ) : undefined
        }
      />
    </List.Item>
  );
}

export function RunPanel({ productionId }: { productionId: string; targetSeconds?: number | null }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const queryClient = useQueryClient();

  const runQuery = useQuery({
    queryKey: ["run", productionId],
    queryFn: () => client.getRun(productionId),
    retry: false,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      if (!state || TERMINAL_STATES.has(state)) return false;
      return 3000;
    },
  });

  const startMutation = useMutation({
    mutationFn: () => client.startRun(productionId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["run", productionId] }),
  });

  const noRun = runQuery.isError && runQuery.error instanceof StudioHttpError && runQuery.error.status === 404;

  if (runQuery.isLoading) return <Card title={t("run.title")}><Spin /></Card>;

  if (noRun) {
    return (
      <Card title={t("run.title")}>
        <Button type="primary" icon={<Play size={16} />} loading={startMutation.isPending} onClick={() => startMutation.mutate()}>
          {t("run.start")}
        </Button>
        {startMutation.isError && (
          <Alert style={{ marginTop: 12 }} type="error" message={t("run.startFailed")}
            description={startMutation.error instanceof Error ? startMutation.error.message : String(startMutation.error)} />
        )}
      </Card>
    );
  }

  if (runQuery.isError || !runQuery.data) {
    return (
      <Card title={t("run.title")}>
        <Alert type="error" message={t("run.loadFailed")}
          description={runQuery.error instanceof Error ? runQuery.error.message : String(runQuery.error)} />
      </Card>
    );
  }

  const run = runQuery.data;
  return (
    <Card title={<Space>{t("run.title")}<Tag color={stageTagColor(run.state)}><EnumText group="runState" code={run.state} /></Tag></Space>}>
      <List
        dataSource={run.stages}
        rowKey="key"
        renderItem={(stage) => (
          <StageRow stage={stage} productionId={productionId} runEnded={run.state === "FAILED" || run.state === "CANCELLED"} />
        )}
      />
    </Card>
  );
}
