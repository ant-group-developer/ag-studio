/**
 * Adobe Premiere exports of one episode (GĐ6): start one (proxy 720p or originals) and follow the farm jobs.
 * The list polls only while a job is queued or running.
 */
import { App as AntApp, Button, Card, Dropdown, Empty, List, Progress, Space, Tag, Tooltip, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download, Film } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError, useStudioClient, type EditorJob, type PremiereMedia } from "../../api/studio-client";

const ACTIVE: EditorJob["status"][] = ["queued", "running"];
const STATUS_COLOR: Record<EditorJob["status"], string> = { queued: "default", running: "processing", completed: "success", failed: "error" };

export const premiereJobsKey = (productionId: string, episodeId: string) => ["premiere-jobs", productionId, episodeId] as const;

/** Starts a Premiere export; shared by the episodes table's "Xuất" menu and the drawer. */
export function useStartPremiereExport(productionId: string) {
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: ({ episodeId, media }: { episodeId: string; media: PremiereMedia }) => client.exportPremiere(productionId, episodeId, media),
    onSuccess: (_job, { episodeId }) => {
      void qc.invalidateQueries({ queryKey: premiereJobsKey(productionId, episodeId) });
      void message.success(t("episodes.premiereStarted"));
    },
    onError: (e) => {
      void message.error(e instanceof StudioHttpError && e.status === 403 ? t("episodes.premiereForbidden") : e instanceof Error ? e.message : String(e));
    },
  });
}

export function premiereMenuItems(t: (k: string) => string, start: (media: PremiereMedia) => void) {
  return [
    { key: "premiere-proxy", icon: <Film size={14} />, label: t("episodes.premiereProxy"), onClick: () => start("proxy") },
    { key: "premiere-original", icon: <Film size={14} />, label: t("episodes.premiereOriginal"), onClick: () => start("original") },
  ];
}

export function PremiereExports({ productionId, episodeId, canEdit }: { productionId: string; episodeId: string; canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useStudioClient();
  const start = useStartPremiereExport(productionId);
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: premiereJobsKey(productionId, episodeId),
    queryFn: () => client.listEditorJobs(productionId, episodeId, "export_premiere"),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => ACTIVE.includes(j.status)) ? 3_000 : false),
  });

  return (
    <Card
      size="small"
      title={t("episodes.premiereTitle")}
      extra={canEdit ? (
        <Dropdown trigger={["click"]} menu={{ items: premiereMenuItems(t, (media) => start.mutate({ episodeId, media })) }}>
          <Button size="small" icon={<ChevronDown size={14} />} loading={start.isPending}>{t("episodes.export")}</Button>
        </Dropdown>
      ) : null}
    >
      {jobs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isLoading ? t("common.loading") : t("episodes.premiereNone")} />
      ) : (
        <List
          size="small"
          dataSource={jobs}
          renderItem={(job) => {
            const media = job.request.media === "original" ? t("episodes.premiereMediaOriginal") : t("episodes.premiereMediaProxy");
            return (
              <List.Item
                actions={job.status === "completed" && job.url ? [
                  <Tooltip key="dl" title={t("episodes.download")}>
                    <Button size="small" type="text" icon={<Download size={14} />} href={job.url} aria-label={t("episodes.download")} />
                  </Tooltip>,
                ] : []}
              >
                <Space direction="vertical" size={2} style={{ width: "100%" }}>
                  <Space size={8}>
                    <Tag color={STATUS_COLOR[job.status]}>{t(`episodes.jobStatus.${job.status}`)}</Tag>
                    <Typography.Text>{media}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {new Date(job.createdAt).toLocaleString(i18n.language)}
                    </Typography.Text>
                  </Space>
                  {ACTIVE.includes(job.status) && <Progress percent={Math.round(job.progress ?? 0)} size="small" />}
                  {job.status === "failed" && job.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{job.error}</Typography.Text>}
                </Space>
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );
}
