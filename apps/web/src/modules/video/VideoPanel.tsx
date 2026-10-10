import { useState } from "react";
import { App as AntApp, Button, Empty, Popconfirm, Spin, Tag } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Download, Film, Hammer, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type JobView, type RenderKind, type RenderView, type TeamRoleName } from "../../api/workspace-client";
import { JobCard } from "../inputs/JobCard";
import { clock, fileSize, relativeTime } from "../workspace/time";
import "../inputs/inputs.css";
import "./video.css";

/**
 * A video's "Preview" tab (spec 2026-10-10 agent-workspace §P6): its timeline in short (revision, clips, length,
 * problems), building it again from the edit plan, renders (a preview; the final render and the Premiere export for
 * producers), the jobs running for them, and the finished renders to watch or download — a link only for people whose
 * own ag-go rights cover the footage.
 */
export function VideoPanel({ videoId, atLeast }: { videoId: string; atLeast: (role: TeamRoleName) => boolean }) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const [playing, setPlaying] = useState<string | null>(null);
  const timeline = useQuery({ queryKey: ["timeline", videoId], queryFn: () => client.getTimeline(videoId) });
  const renders = useQuery({
    queryKey: ["renders", videoId], queryFn: () => client.listRenders(videoId),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === "queued" || j.status === "running") ? 2000 : 30_000),
  });
  const refresh = () => {
    for (const k of [["renders", videoId], ["timeline", videoId], ["activity"], ["jobs"], ["playbook"]]) void qc.invalidateQueries({ queryKey: k });
  };
  const fail = (fallback: string) => (e: unknown) => void message.error(e instanceof StudioHttpError ? e.message : fallback);
  const start = useMutation({ mutationFn: (kind: RenderKind) => client.startRender(videoId, { kind }), onSuccess: refresh, onError: fail(t("ws.video.renderFailed")) });
  const fit = useMutation({ mutationFn: () => client.fitTimeline(videoId), onSuccess: refresh, onError: fail(t("ws.video.fitFailed")) });
  const stop = useMutation({ mutationFn: (j: JobView) => client.cancelJob(j.projectId, j.id), onSuccess: refresh });

  if (timeline.isLoading || renders.isLoading) return <div className="ws-center"><Spin /></div>;
  const latest = timeline.data?.latest ?? null;
  const list = renders.data?.renders ?? [];
  const jobs = (renders.data?.jobs ?? []).filter((j) => j.status === "queued" || j.status === "running" || j.status === "failed").slice(0, 4);
  const shown = list.find((r) => r.jobId === playing) ?? list.find((r) => r.kind !== "export_premiere" && r.url);
  const errors = latest?.issues.filter((i) => i.startsWith("[error]")) ?? [];

  return (
    <div className="ws-inputs ws-video">
      <section aria-label={t("ws.video.timeline")}>
        <div className="ws-inputs__head">
          <h4 className="ws-inputs__h">{t("ws.video.timeline")}</h4>
          {atLeast("editor") ? (
            <Button size="small" icon={<Hammer size={13} />} loading={fit.isPending} onClick={() => fit.mutate()}>{t("ws.video.fit")}</Button>
          ) : null}
        </div>
        {latest ? (
          <>
            <p className="ws-video__line">
              {t("ws.video.revision", { revision: latest.revision })}{latest.label ? ` · ${latest.label}` : ""} · {t("ws.video.clips", { count: latest.clips.length })} · ≈ {clock(latest.approx_seconds)}
              {latest.narration.lines.length ? ` · ${t("ws.video.lines", { count: latest.narration.lines.length })}` : ""}
            </p>
            {errors.length ? <ul className="ws-video__issues">{errors.map((i) => <li key={i} className="ws-error">{i.replace("[error] ", "")}</li>)}</ul> : null}
          </>
        ) : <p className="ws-hint">{t("ws.video.noTimeline")}</p>}
      </section>

      <section aria-label={t("ws.video.renders")}>
        <div className="ws-inputs__head">
          <h4 className="ws-inputs__h">{t("ws.video.renders")}</h4>
        </div>
        <div className="ws-video__buttons">
          {atLeast("editor") ? (
            <Button size="small" icon={<Play size={13} />} disabled={!latest || errors.length > 0} loading={start.isPending && start.variables === "render_preview"}
              onClick={() => start.mutate("render_preview")}>{t("ws.video.renderPreview")}</Button>
          ) : null}
          {atLeast("producer") ? (
            <>
              <Popconfirm title={t("ws.video.finalConfirm", { revision: latest?.revision ?? "?" })} onConfirm={() => start.mutate("render_final")} okText={t("ws.video.renderFinal")} cancelText={t("common.cancel")}>
                <Button size="small" icon={<Clapperboard size={13} />} disabled={!latest || errors.length > 0} loading={start.isPending && start.variables === "render_final"}>{t("ws.video.renderFinal")}</Button>
              </Popconfirm>
              <Button size="small" icon={<Film size={13} />} disabled={!latest || errors.length > 0} loading={start.isPending && start.variables === "export_premiere"}
                onClick={() => start.mutate("export_premiere")}>{t("ws.video.exportPremiere")}</Button>
            </>
          ) : null}
        </div>
        {jobs.length ? (
          <div className="ws-inputs__jobs">
            {jobs.map((j) => <JobCard key={j.id} job={j} onStop={atLeast("editor") ? (x) => stop.mutate(x) : undefined} stopping={stop.isPending && stop.variables?.id === j.id} />)}
          </div>
        ) : null}
        {shown?.url ? (
          <video key={shown.jobId} className="ws-video__player" src={shown.url} controls preload="metadata" aria-label={t("ws.video.player")} />
        ) : null}
        {list.length ? (
          <ul className="ws-inputs__list">
            {list.map((r) => <RenderRow key={r.jobId} r={r} lang={i18n.language} current={shown?.jobId === r.jobId} onPlay={() => setPlaying(r.jobId)} />)}
          </ul>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("ws.video.noRenders")} />}
      </section>
    </div>
  );
}

function RenderRow({ r, lang, current, onPlay }: { r: RenderView; lang: string; current: boolean; onPlay: () => void }) {
  const { t } = useTranslation();
  return (
    <li className={`ws-inputs__row${current ? " ws-video__row--current" : ""}`}>
      <Tag color={r.kind === "render_final" ? "green" : r.kind === "export_premiere" ? "purple" : "blue"}>{t(`ws.video.kind.${r.kind}`)}</Tag>
      <div className="ws-inputs__text">
        <span className="ws-inputs__name">
          {t("ws.video.revision", { revision: r.revision })}{r.durationS !== null ? ` · ${clock(r.durationS)}` : ""}{r.sizeBytes ? ` · ${fileSize(r.sizeBytes)}` : ""}
          {r.watermarked ? ` · ${t("ws.video.watermarked")}` : ""}
        </span>
        <span className="ws-hint">{r.finishedAt ? relativeTime(r.finishedAt, lang) : ""}{r.urlHidden ? ` · ${t("ws.video.hidden")}` : ""}{r.note ? ` · ${r.note}` : ""}</span>
      </div>
      {r.url && r.kind !== "export_premiere" ? <button type="button" className="ws-link" onClick={onPlay}>{t("ws.video.watch")}</button> : null}
      {r.url ? <a className="ws-icon-button" href={r.url} target="_blank" rel="noreferrer" aria-label={t("ws.video.download")} title={t("ws.video.download")}><Download size={13} /></a> : null}
    </li>
  );
}
