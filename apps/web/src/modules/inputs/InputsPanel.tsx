import { useRef, useState } from "react";
import { App as AntApp, Button, Popconfirm, Spin, Tag, Tooltip } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Film, FolderKanban, Image as ImageIcon, Music, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { useAiTranslation } from "../common/assistant-name";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type JobView, type SourceItem } from "../../api/workspace-client";
import { clock } from "../workspace/time";
import { AgGoProjectPicker, FootagePicker } from "./AgGoPickers";
import { JobCard } from "./JobCard";
import { AudioSummary, UseAudioButtons } from "./AudioControls";
import "./inputs.css";

const UPLOAD_ACCEPT = ".md,.txt,.pdf,.csv,.json,.srt,.vtt,.jpg,.jpeg,.png,.webp,.gif,.mp3,.wav,.m4a,.aac,.ogg,.flac";
const KIND_ICON = { document: FileText, image: ImageIcon, audio: Music, video: Film, mixed: FolderKanban } as const;

function AssetLine({ s, canEdit, onOpenFile, onPrepare, onRemove }: {
  s: SourceItem; canEdit: boolean; onOpenFile: (path: string) => void; onPrepare: (assetId: string, again: boolean) => void; onRemove: (s: SourceItem) => void;
}) {
  const { t } = useAiTranslation();
  const a = s.asset;
  const duration = typeof s.meta.durationMs === "number" ? clock((s.meta.durationMs as number) / 1000) : null;
  return (
    <li className="ws-inputs__row">
      <Film size={14} aria-hidden />
      <div className="ws-inputs__text">
        <span className="ws-inputs__name">{s.label}</span>
        <span className="ws-hint">
          {duration}
          {a?.state === "ready" ? <> · {t("ws.inputs.shots", { count: a.shots ?? 0 })}{a.transcript ? ` · ${t("ws.inputs.withTranscript")}` : ""}</> : null}
          {a?.state === "failed" ? <span className="ws-error"> · {a.error}</span> : null}
        </span>
      </div>
      {a?.state === "ready" ? (
        <button type="button" className="ws-link" onClick={() => onOpenFile(a.readme)}>{t("ws.inputs.open")}</button>
      ) : a?.state === "queued" || a?.state === "preparing" ? (
        <Tag color="blue">{a.state === "queued" ? t("ws.inputs.state.queued") : `${t("ws.inputs.state.preparing")}${a.progress !== null ? ` ${Math.round(a.progress * 100)}%` : ""}`}</Tag>
      ) : canEdit ? (
        <Button size="small" onClick={() => onPrepare(s.ref, false)}>{a?.state === "failed" ? t("ws.inputs.retry") : t("ws.inputs.prepare")}</Button>
      ) : <Tag>{t("ws.inputs.state.notPrepared")}</Tag>}
      {canEdit && a?.state === "ready" ? (
        <Tooltip title={t("ws.inputs.prepareAgain")}><button type="button" className="ws-icon-button" aria-label={t("ws.inputs.prepareAgain")} onClick={() => onPrepare(s.ref, true)}><RotateCcw size={13} /></button></Tooltip>
      ) : null}
      {canEdit ? (
        <Popconfirm title={t("ws.inputs.removeConfirm", { name: s.label })} onConfirm={() => onRemove(s)} okText={t("ws.inputs.remove")} cancelText={t("common.cancel")}>
          <button type="button" className="ws-icon-button" aria-label={t("ws.inputs.removeNamed", { name: s.label })}><Trash2 size={13} /></button>
        </Popconfirm>
      ) : null}
    </li>
  );
}

/**
 * The Inputs tab (spec 2026-10-10 agent-workspace §4): the ag-go projects the agent searches, the ag-go videos of this
 * video (prepared once for the whole project), documents, images and audio uploaded into `context/`, and the jobs
 * running for them — who works on each, how far, time spent and left, Stop.
 */
export function InputsPanel({ projectId, videoId, canEdit, canProduce = false, onOpenFile }: {
  projectId: string; videoId?: string; canEdit: boolean; canProduce?: boolean; onOpenFile: (path: string) => void;
}) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [projectPicker, setProjectPicker] = useState(false);
  const [footagePicker, setFootagePicker] = useState(false);
  const sources = useQuery({
    queryKey: ["sources", projectId, videoId ?? null], queryFn: () => client.listSources(projectId, videoId),
    refetchInterval: (q) => (q.state.data?.sources.some((s) => s.asset?.state === "queued" || s.asset?.state === "preparing") ? 3000 : false),
  });
  const jobs = useQuery({
    queryKey: ["jobs", projectId, videoId ?? null], queryFn: () => client.listJobs(projectId, videoId ? { videoId } : {}),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === "queued" || j.status === "running") ? 2000 : false),
  });
  const refresh = () => {
    for (const k of ["sources", "jobs", "activity", "playbook"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
  };
  const fail = (fallback: string) => (e: unknown) => void message.error(e instanceof StudioHttpError ? e.message : fallback);
  const prepare = useMutation({ mutationFn: (p: { assetId: string; again: boolean }) => client.prepareInputs(projectId, [p.assetId], p.again), onSuccess: refresh, onError: fail(t("ws.inputs.prepareFailed")) });
  const remove = useMutation({ mutationFn: (s: SourceItem) => client.removeSource(projectId, s.id), onSuccess: refresh, onError: fail(t("ws.inputs.removeFailed")) });
  const stop = useMutation({ mutationFn: (j: JobView) => client.cancelJob(projectId, j.id), onSuccess: refresh, onError: fail(t("ws.jobs.stopFailed")) });
  const upload = useMutation({
    mutationFn: (files: File[]) => Promise.all(files.map((f) => client.uploadSource(projectId, f, videoId))),
    onSuccess: (r) => { refresh(); void qc.invalidateQueries({ queryKey: ["files", projectId] }); void message.success(t("ws.inputs.uploaded", { count: r.length })); },
    onError: fail(t("ws.inputs.uploadFailed")),
  });

  if (sources.isLoading) return <div className="ws-center"><Spin /></div>;
  const all = sources.data?.sources ?? [];
  const agGoProjects = all.filter((s) => s.kind === "ag_go_project");
  const videoAssets = all.filter((s) => s.kind === "ag_go_asset" && (videoId ? s.videoId === videoId : true));
  const uploads = all.filter((s) => s.kind === "upload");
  const jobList = jobs.data?.jobs ?? [];
  const active = jobList.filter((j) => j.status === "queued" || j.status === "running");
  const recent = jobList.filter((j) => j.status !== "queued" && j.status !== "running").slice(0, 3);

  return (
    <div className="ws-inputs">
      {active.length || recent.length ? (
        <section aria-label={t("ws.jobs.title")}>
          <h4 className="ws-inputs__h">{t("ws.jobs.title")}</h4>
          <div className="ws-inputs__jobs">
            {active.map((j) => <JobCard key={j.id} job={j} onStop={canEdit ? (x) => stop.mutate(x) : undefined} stopping={stop.isPending && stop.variables?.id === j.id} />)}
            {recent.map((j) => <JobCard key={j.id} job={j} />)}
          </div>
        </section>
      ) : null}

      <section aria-label={t("ws.inputs.agGoProjects")}>
        <div className="ws-inputs__head">
          <h4 className="ws-inputs__h">{t("ws.inputs.agGoProjects")}</h4>
          {canEdit ? <Button size="small" icon={<Plus size={13} />} onClick={() => setProjectPicker(true)}>{t("ws.inputs.addProject")}</Button> : null}
        </div>
        {agGoProjects.length ? (
          <ul className="ws-inputs__list">
            {agGoProjects.map((s) => (
              <li key={s.id} className="ws-inputs__row">
                <FolderKanban size={14} aria-hidden />
                <div className="ws-inputs__text">
                  <span className="ws-inputs__name">{s.label}</span>
                  {typeof s.meta.videos === "number" ? <span className="ws-hint">{t("ws.inputs.videoCount", { count: s.meta.videos as number })}</span> : null}
                </div>
                {canEdit ? (
                  <Popconfirm title={t("ws.inputs.removeConfirm", { name: s.label })} onConfirm={() => remove.mutate(s)} okText={t("ws.inputs.remove")} cancelText={t("common.cancel")}>
                    <button type="button" className="ws-icon-button" aria-label={t("ws.inputs.removeNamed", { name: s.label })}><Trash2 size={13} /></button>
                  </Popconfirm>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <p className="ws-hint">{t("ws.inputs.noProjectYet")}</p>}
      </section>

      {videoId ? (
        <section aria-label={t("ws.inputs.videoFootage")}>
          <div className="ws-inputs__head">
            <h4 className="ws-inputs__h">{t("ws.inputs.videoFootage")}</h4>
            {canEdit ? <Button size="small" icon={<Plus size={13} />} disabled={!agGoProjects.length} onClick={() => setFootagePicker(true)}>{t("ws.inputs.pickVideos")}</Button> : null}
          </div>
          {videoAssets.length ? (
            <ol className="ws-inputs__list">
              {videoAssets.map((s) => (
                <AssetLine key={s.id} s={s} canEdit={canEdit} onOpenFile={onOpenFile} onPrepare={(assetId, again) => prepare.mutate({ assetId, again })} onRemove={(x) => remove.mutate(x)} />
              ))}
            </ol>
          ) : <p className="ws-hint">{agGoProjects.length ? t("ws.inputs.noVideoYet") : t("ws.inputs.addProjectFirst")}</p>}
        </section>
      ) : videoAssets.length ? (
        <section aria-label={t("ws.inputs.preparedFootage")}>
          <h4 className="ws-inputs__h">{t("ws.inputs.preparedFootage")}</h4>
          <ul className="ws-inputs__list">
            {videoAssets.map((s) => <AssetLine key={s.id} s={s} canEdit={canEdit} onOpenFile={onOpenFile} onPrepare={(assetId, again) => prepare.mutate({ assetId, again })} onRemove={(x) => remove.mutate(x)} />)}
          </ul>
        </section>
      ) : null}

      <section aria-label={t("ws.inputs.files")}>
        <div className="ws-inputs__head">
          <h4 className="ws-inputs__h">{t("ws.inputs.files")}</h4>
          {canEdit ? (
            <>
              <Button size="small" icon={<Upload size={13} />} loading={upload.isPending} onClick={() => fileInput.current?.click()}>{t("ws.inputs.upload")}</Button>
              <input ref={fileInput} type="file" multiple hidden accept={UPLOAD_ACCEPT} aria-label={t("ws.inputs.upload")}
                onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) upload.mutate(files); }} />
            </>
          ) : null}
        </div>
        <p className="ws-hint">{t("ws.inputs.filesHint")}</p>
        {uploads.length ? (
          <ul className="ws-inputs__list">
            {uploads.map((s) => {
              const Icon = KIND_ICON[s.mediaType];
              return (
                <li key={s.id} className="ws-inputs__row">
                  <Icon size={14} aria-hidden />
                  <button type="button" className="ws-link ws-inputs__name" onClick={() => onOpenFile(s.ref)}>{s.label}</button>
                  {s.mediaType === "audio" ? <UseAudioButtons projectId={projectId} path={s.ref} canEdit={canEdit} canProduce={canProduce} /> : null}
                  {canEdit ? (
                    <Popconfirm title={t("ws.inputs.removeUploadConfirm", { name: s.label })} onConfirm={() => remove.mutate(s)} okText={t("ws.inputs.remove")} cancelText={t("common.cancel")}>
                      <button type="button" className="ws-icon-button" aria-label={t("ws.inputs.removeNamed", { name: s.label })}><Trash2 size={13} /></button>
                    </Popconfirm>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <AudioSummary projectId={projectId} canProduce={canProduce} />

      <AgGoProjectPicker projectId={projectId} picked={all} open={projectPicker} onClose={() => setProjectPicker(false)} />
      {videoId ? <FootagePicker projectId={projectId} videoId={videoId} sources={all} open={footagePicker} onClose={() => setFootagePicker(false)} /> : null}
    </div>
  );
}
