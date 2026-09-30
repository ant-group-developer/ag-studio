import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, List, Space, Spin, Tag, Typography } from "antd";
import { ReloadOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useStudioClient, StudioHttpError } from "../../api/studio-client";
import type { StageView } from "../../api/studio-client";
import { GateApproveTreatment } from "./GateApproveTreatment";
import { GateShotBoard } from "./GateShotBoard";
import { GateEdit } from "./GateEdit";
import { ExportsPanel } from "./ExportsPanel";

const { Text } = Typography;

const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

function stageTagColor(state: string): string {
  switch (state) {
    case "SUCCEEDED":
      return "green";
    case "FAILED":
      return "red";
    case "RUNNING":
      return "blue";
    case "WAITING_HUMAN":
      return "gold";
    default:
      return "default";
  }
}

function StageRow({
  stage,
  productionId,
  runEnded,
}: {
  stage: StageView;
  productionId: string;
  /** The run is FAILED or CANCELLED: a stage can only be picked up again in a new run. */
  runEnded: boolean;
}) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const retryMutation = useMutation({
    mutationFn: () => client.retryStage(productionId, stage.key),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["run", productionId] }),
  });

  const resumeMutation = useMutation({
    mutationFn: () => client.resumeRun(productionId, stage.key),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["run", productionId] }),
  });

  const canRetry = !runEnded && !stage.is_gate && (stage.state === "FAILED" || stage.state === "WAITING_HUMAN");
  // Stages before this one keep what the ended run accepted (Claude's documents, the gates people submitted).
  const canResume = runEnded && !stage.is_gate;

  return (
    <List.Item
      actions={
        canResume
          ? [
              <Button
                key="resume"
                size="small"
                icon={<ReloadOutlined />}
                loading={resumeMutation.isPending}
                onClick={() => resumeMutation.mutate()}
              >
                {t("run.resumeFromHere")}
              </Button>,
            ]
          : canRetry
          ? [
              <Button
                key="retry"
                size="small"
                icon={<ReloadOutlined />}
                loading={retryMutation.isPending}
                onClick={() => retryMutation.mutate()}
              >
                {t("run.retry")}
              </Button>,
            ]
          : []
      }
    >
      <List.Item.Meta
        title={
          <Space>
            <Text strong>{stage.key}</Text>
            <Tag color={stageTagColor(stage.state)}>{stage.state}</Tag>
            {stage.is_gate && <Tag>gate</Tag>}
            {stage.attempts > 1 && <Text type="secondary">{t("run.attempt", { count: stage.attempts })}</Text>}
          </Space>
        }
        description={
          stage.error || stage.failed_checks.length || resumeMutation.error ? (
            <div>
              {resumeMutation.error && <div><Text type="danger">{String((resumeMutation.error as Error).message)}</Text></div>}
              {stage.error && <Text type="danger">{stage.error}</Text>}
              {stage.failed_checks.map((c) => (
                <div key={c.check_id}>
                  <Text type="danger">- {c.check_id}</Text>
                  {Array.isArray((c.evidence as { problems?: unknown[] }).problems) &&
                    ((c.evidence as { problems: { code: string; message: string }[] }).problems).map((p, i) => (
                      <div key={i} style={{ paddingLeft: 12 }}>
                        <Text type="secondary">
                          {p.code}: {p.message}
                        </Text>
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

export function RunPanel({
  productionId,
  targetSeconds,
}: {
  productionId: string;
  targetSeconds: number | null;
}) {
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

  if (runQuery.isLoading) {
    return (
      <Card title={t("run.title")}>
        <Spin />
      </Card>
    );
  }

  if (noRun) {
    return (
      <Card title={t("run.title")}>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          loading={startMutation.isPending}
          onClick={() => startMutation.mutate()}
        >
          {t("run.start")}
        </Button>
        {startMutation.isError && (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            message={t("run.startFailed")}
            description={startMutation.error instanceof Error ? startMutation.error.message : String(startMutation.error)}
          />
        )}
      </Card>
    );
  }

  if (runQuery.isError || !runQuery.data) {
    return (
      <Card title={t("run.title")}>
        <Alert
          type="error"
          message={t("run.loadFailed")}
          description={runQuery.error instanceof Error ? runQuery.error.message : String(runQuery.error)}
        />
      </Card>
    );
  }

  const run = runQuery.data;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={16}>
      <Card title={t("run.titleWithState", { state: run.state })}>
        <List
          dataSource={run.stages}
          rowKey="key"
          renderItem={(stage) => (
            <StageRow stage={stage} productionId={productionId} runEnded={run.state === "FAILED" || run.state === "CANCELLED"} />
          )}
        />
      </Card>

      {run.waiting_gate === "approve-treatment" && (
        <GateApproveTreatment productionId={productionId} targetSeconds={targetSeconds} />
      )}
      {run.waiting_gate === "shot-board" && <GateShotBoard productionId={productionId} />}
      {run.waiting_gate === "edit" && <GateEdit productionId={productionId} />}

      {run.state === "SUCCEEDED" && <ExportsPanel productionId={productionId} />}
    </Space>
  );
}
