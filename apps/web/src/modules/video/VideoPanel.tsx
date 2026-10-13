import { useEffect, useRef, useState } from "react";
import { App as AntApp, Button, Empty, Popconfirm, Spin, Tag } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Download, Film, Hammer, Play } from "lucide-react";
import { useAiTranslation } from "../common/assistant-name";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type JobView, type RenderKind, type RenderLink, type RenderView, type TeamRoleName, type WorkspaceClient } from "../../api/workspace-client";
import { JobCard } from "../inputs/JobCard";
import { clock, fileSize, relativeTime } from "../workspace/time";
import "../inputs/inputs.css";
import "./video.css";

/**
 * A video's "Preview" tab (spec 2026-10-10 agent-workspace §P6): its timeline in short (revision, clips, length,
 * problems), building it again from the edit plan, renders (a preview; the final render and the Premiere export for
 * producers), the jobs running for them, and the finished renders to watch or download — a link only for people whose
 * own ag-go rights cover the footage. The timeline and the list show as soon as each arrives (the database alone); a
 * render's link is asked for apart (ag-go is asked about its footage), for the one in the player or on a click.
 */
export function VideoPanel({ projectId, videoId, atLeast, onOpenFile }: {
  projectId: string; videoId: string; atLeast: (role: TeamRoleName) => boolean; onOpenFile?: (path: string) => void;
}) {
  const { t, i18n } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const [playing, setPlaying] = useState<string | null>(null);
  // a link asked again (it went stale) is a new signature: the player keeps the link it has (they live an hour) or it reloads
  const playerUrls = useRef(new Map<string, { url: string; at: number }>());
  const timeline = useQuery({ queryKey: ["timeline", videoId], queryFn: () => client.getTimeline(videoId) });
  const renders = useQuery({
    queryKey: ["renders", videoId], queryFn: () => client.listRenders(videoId),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === "queued" || j.status === "running") ? 2000 : 30_000),
  });
  const list = renders.data?.renders ?? [];
  const shown = list.find((r) => r.jobId === playing) ?? list.find((r) => r.kind !== "export_premiere");
  const link = useQuery({
    ...linkQuery(client, videoId, shown?.jobId ?? ""), enabled: !!shown,
    // ag-go not answering is asked again in a while, so the player comes back by itself
    refetchInterval: (q) => (q.state.data?.urlHidden === "footage_check_failed" ? 30_000 : false),
  });
  const refresh = () => {
    for (const k of [["renders", videoId], ["timeline", videoId], ["activity"], ["jobs"], ["playbook"]]) void qc.invalidateQueries({ queryKey: k });
  };
  const fail = (fallback: string) => (e: unknown) => void message.error(e instanceof StudioHttpError ? e.message : fallback);
  const start = useMutation({
    mutationFn: (kind: RenderKind) => client.startRender(videoId, { kind }),
    onSuccess: (job, kind) => { if (kind === "export_premiere") savingExports.add(job.id); refresh(); },
    onError: fail(t("ws.video.renderFailed")),
  });
  const fit = useMutation({ mutationFn: () => client.fitTimeline(videoId), onSuccess: refresh, onError: fail(t("ws.video.fitFailed")) });
  const stop = useMutation({ mutationFn: (j: JobView) => client.cancelJob(j.projectId, j.id), onSuccess: refresh });
  // a Premiere export started from this tab is saved as soon as it is done (its link names the .zip to save)
  useEffect(() => {
    const data = renders.data;
    if (!data) return;
    for (const id of [...savingExports]) {
      const done = data.renders.find((x) => x.jobId === id);
      const job = data.jobs.find((x) => x.id === id);
      if (done) {
        savingExports.delete(id);
        void qc.fetchQuery(linkQuery(client, videoId, id)).then((l) => {
          if (l.url) { saveFile(l.url); void message.success(t("ws.video.exportSaving")); } else void message.warning(t(hiddenKey(l)));
        }, () => void message.error(t("ws.video.linkFailed")));
      } else if (job && (job.status === "failed" || job.status === "cancelled")) savingExports.delete(id);
    }
  }, [renders.data, message, t, qc, client, videoId]);

  /** A render opens in a new tab (opened within the click so the browser allows it, then pointed at the link); a Premiere .zip is saved. */
  const download = (r: RenderView) => {
    const tab = r.kind === "export_premiere" ? null : window.open("", "_blank");
    if (tab) tab.opener = null;
    void qc.fetchQuery(linkQuery(client, videoId, r.jobId)).then((l) => {
      if (!l.url) { tab?.close(); void message.warning(t(hiddenKey(l))); return; }
      if (r.kind === "export_premiere") saveFile(l.url);
      else if (tab) tab.location.href = l.url;
      else window.open(l.url, "_blank", "noreferrer");
    }, () => { tab?.close(); void message.error(t("ws.video.linkFailed")); });
  };

  const latest = timeline.data?.latest ?? null;
  const jobs = jobsToShow(renders.data?.jobs ?? [], list);
  const playerUrl = shown && link.data?.jobId === shown.jobId && link.data.url ? keptUrl(playerUrls.current, shown.jobId, link.data.url) : null;
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
        {timeline.isLoading ? <Spin size="small" /> : latest ? (
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
        {shown ? (
          playerUrl ? (
            <video key={shown.jobId} className="ws-video__player" src={playerUrl} controls preload="metadata" aria-label={t("ws.video.player")} />
          ) : (
            <div className="ws-video__player ws-video__player--wait" role="status" aria-label={t("ws.video.player")}>
              {link.isError ? t("ws.video.linkFailed") : link.data?.urlHidden ? t(hiddenKey(link.data)) : <><Spin size="small" /> {t("ws.video.linkLoading")}</>}
            </div>
          )
        ) : null}
        {renders.isLoading ? <Spin size="small" /> : list.length ? (
          <ul className="ws-inputs__list">
            {list.map((r) => (
              <RenderRow key={r.jobId} r={r} videoId={videoId} lang={i18n.language} current={shown?.jobId === r.jobId} onPlay={() => setPlaying(r.jobId)} onDownload={() => download(r)} />
            ))}
          </ul>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("ws.video.noRenders")} />}
      </section>

      {renders.data?.thumbnails.length ? (
        <section aria-label={t("ws.video.thumbnails")}>
          <h4 className="ws-inputs__h">{t("ws.video.thumbnails")}</h4>
          <div className="ws-video__thumbs">
            {renders.data.thumbnails.map((p) => <Thumb key={p} projectId={projectId} path={p} onOpen={onOpenFile} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** One thumbnail of the video, read as a workspace file. */
function Thumb({ projectId, path, onOpen }: { projectId: string; path: string; onOpen?: ((path: string) => void) | undefined }) {
  const client = useWorkspaceClient();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    void client.fileBlob(projectId, path).then((b) => { if (alive) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => undefined);
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [client, projectId, path]);
  const name = path.split("/").pop()!;
  return (
    <button type="button" className="ws-video__thumb" onClick={() => onOpen?.(path)} aria-label={name} title={name}>
      {url ? <img src={url} alt={name} /> : <span className="ws-hint">{name}</span>}
    </button>
  );
}

function RenderRow({ r, videoId, lang, current, onPlay, onDownload }: {
  r: RenderView; videoId: string; lang: string; current: boolean; onPlay: () => void; onDownload: () => void;
}) {
  const { t } = useAiTranslation();
  const client = useWorkspaceClient();
  // what is known of its link (asked for by the player or a click), never asked from here
  const link = useQuery({ ...linkQuery(client, videoId, r.jobId), enabled: false });
  const hidden = link.data?.urlHidden;
  return (
    <li className={`ws-inputs__row${current ? " ws-video__row--current" : ""}`}>
      <Tag color={r.kind === "render_final" ? "green" : r.kind === "export_premiere" ? "purple" : "blue"}>{t(`ws.video.kind.${r.kind}`)}</Tag>
      <div className="ws-inputs__text">
        <span className="ws-inputs__name">
          {t("ws.video.revision", { revision: r.revision })}{r.durationS !== null ? ` · ${clock(r.durationS)}` : ""}{r.sizeBytes ? ` · ${fileSize(r.sizeBytes)}` : ""}
          {r.watermarked ? ` · ${t("ws.video.watermarked")}` : ""}
        </span>
        <span className="ws-hint">{r.finishedAt ? relativeTime(r.finishedAt, lang) : ""}{hidden ? ` · ${t(hiddenKey(link.data!))}` : ""}{r.note ? ` · ${r.note}` : ""}</span>
      </div>
      {!hidden && r.kind !== "export_premiere" ? <button type="button" className="ws-link" onClick={onPlay}>{t("ws.video.watch")}</button> : null}
      {!hidden ? (
        <button type="button" className="ws-icon-button" onClick={onDownload} aria-label={t("ws.video.download")} title={t("ws.video.download")}><Download size={13} /></button>
      ) : null}
    </li>
  );
}

/**
 * The jobs over the player, at most 4: those queued or running, and a failure only while nothing of its kind came
 * after it (a newer try, or a render of that kind finished later). `jobs` come newest first.
 */
export function jobsToShow(jobs: JobView[], renders: RenderView[]): JobView[] {
  return jobs.filter((j, i) => {
    if (j.status === "queued" || j.status === "running") return true;
    if (j.status !== "failed") return false;
    const at = j.finishedAt ?? j.createdAt;
    return !jobs.slice(0, i).some((x) => x.kind === j.kind)
      && !renders.some((r) => r.kind === j.kind && r.finishedAt !== null && r.finishedAt > at);
  }).slice(0, 4);
}

/** A link is kept 25 minutes (it lives an hour); ag-go not answering only 30 s, so a click asks again. */
function linkQuery(client: WorkspaceClient, videoId: string, jobId: string) {
  return {
    queryKey: ["renderLink", videoId, jobId] as const,
    queryFn: () => client.renderLink(videoId, jobId),
    staleTime: (q: { state: { data?: RenderLink } }) => (q.state.data?.urlHidden === "footage_check_failed" ? 30_000 : 25 * 60_000),
    gcTime: 30 * 60_000,
  };
}

const hiddenKey = (l: RenderLink) => (l.urlHidden === "footage_check_failed" ? "ws.video.checkFailed" : "ws.video.hidden");

/** Premiere exports started from this tab and not saved yet; kept while the panel is closed so a later visit saves them. */
const savingExports = new Set<string>();

/** Has the browser save a file from a link that answers with `Content-Disposition: attachment`; the page stays. */
function saveFile(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The link a render was first played with, while it is younger than half an hour; then the newer one. */
function keptUrl(kept: Map<string, { url: string; at: number }>, jobId: string, url: string): string {
  const k = kept.get(jobId);
  if (k && Date.now() - k.at < 30 * 60_000) return k.url;
  kept.set(jobId, { url, at: Date.now() });
  return url;
}
