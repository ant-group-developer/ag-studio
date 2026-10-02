/**
 * PlanRunStages — shown when a non-gate plan run stage is FAILED or WAITING_HUMAN.
 * Shows an Alert with stage label, error, failed check problems, and a retry button.
 * Producer-only (canEdit prop).
 */
import { Alert, Button, Space, Tooltip } from "antd";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import { useStudioClient } from "../../api/studio-client";
import type { StageView } from "../../api/studio-client";
import { gateProblems } from "./gate-problems";
import { EnumText } from "../../helpers/enum-label";

interface PlanRunStagesProps {
  productionId: string;
  stages: StageView[];
  canEdit: boolean;
}

export function PlanRunStages({ productionId, stages, canEdit }: PlanRunStagesProps) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = App.useApp();

  // Filter stages that are FAILED or WAITING_HUMAN and not a gate
  const failedStages = stages.filter(
    (s) => !s.is_gate && (s.state === "FAILED" || s.state === "WAITING_HUMAN"),
  );

  const retryMutation = useMutation({
    mutationFn: (stage: string) => client.retryStage(productionId, stage),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["run", productionId] });
    },
    onError: (err) => {
      void message.error(err instanceof Error ? err.message : "Retry thất bại");
    },
  });

  if (failedStages.length === 0) return null;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={8}>
      {failedStages.map((stage) => {
        const problems = gateProblems({ body: { failed: stage.failed_checks, message: stage.error } });
        const description = (
          <Space direction="vertical" size={4}>
            {stage.error && <div>{stage.error}</div>}
            {problems.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            )}
          </Space>
        );

        return (
          <Alert
            key={stage.key}
            type="error"
            message={
              <Space>
                <strong><EnumText group="stage" code={stage.key} /></strong>
                {canEdit && (
                  <Tooltip title={t("productions.planRunFailedRetry")}>
                    <Button
                      size="small"
                      icon={<RefreshCw size={12} />}
                      loading={retryMutation.isPending}
                      onClick={() => retryMutation.mutate(stage.key)}
                      aria-label={t("productions.planRunFailedRetry")}
                    />
                  </Tooltip>
                )}
              </Space>
            }
            description={description}
            showIcon
          />
        );
      })}
    </Space>
  );
}
