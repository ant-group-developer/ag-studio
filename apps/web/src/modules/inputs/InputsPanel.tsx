import { useRef, useState } from "react";
import { App as AntApp, Button, Popconfirm, Segmented, Spin } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Film, FolderKanban, Image as ImageIcon, Music, Plus, Trash2, Upload } from "lucide-react";
import { useAiTranslation } from "../common/assistant-name";
import { StudioHttpError } from "../../api/http";
import { isFootage, useWorkspaceClient, type JobView, type SourceItem } from "../../api/workspace-client";
import { FootagePicker } from "./AgGoPickers";
import { AgGoProjectDrawer } from "./ag-go-projects/AgGoProjectDrawer";
import { JobList, JobsLine } from "./JobList";
import { AudioCard, UseAudioButtons, VideoMusicCard } from "./AudioControls";
import { useUploadProgress } from "../common/upload-progress";
import { AgGoProjectList, countAssets, FootageAssets, SummaryBar, type StateFilter } from "./FootageAssets";
import "./inputs.css";

const UPLOAD_ACCEPT = ".md,.txt,.pdf,.csv,.json,.srt,.vtt,.jpg,.jpeg,.png,.webp,.gif,.mp3,.wav,.m4a,.aac,.ogg,.flac";
const REFERENCE_ACCEPT = ".mp4,.mov,.m4v,.mkv,.webm,.avi";
/** Footage from the computer: the API's `FOOTAGE_VIDEO_EXTS` and `FOOTAGE_IMAGE_EXTS`. */
const FOOTAGE_ACCEPT = ".mp4,.mov,.m4v,.mkv,.webm,.avi,.mts,.m2ts,.jpg,.jpeg,.png,.webp";
const KIND_ICON = { document: FileText, image: ImageIcon, audio: Music, video: Film, mixed: FolderKanban } as const;
/** The sub-section last shown (footage or files), remembered in this browser. */
const SECTION_KEY = "studio.inputs.section";
/** How many prepare requests one call takes (the API's limit). */
const PREPARE_BATCH = 40;

type Section = "footage" | "files";
function savedSection(): Section {
  try { return localStorage.getItem(SECTION_KEY) === "files" ? "files" : "footage"; } catch { return "footage"; }
}

/**
 * The Inputs tab (spec 2026-10-10 agent-workspace §4): first the project's voice and music, then how its ag-go videos
 * stand ("78 videos · 70 ready · …") and the background jobs in one line, then two sub-sections — Footage (the ag-go
 * projects the agent searches; the ag-go videos of this video, or on the project page of every video grouped by video,
 * with search, a state filter, paging and bulk prepare/retry) and Documents, images, audio (uploads into `context/`, and
 * reference videos to learn an edit style from, `context/references/`, never footage).
 */
export function InputsPanel({ projectId, videoId, canEdit, canProduce = false, onOpenFile }: {
  projectId: string; videoId?: string; canEdit: boolean; canProduce?: boolean; onOpenFile: (path: string) => void;
}) {
  const { t } = useAiTranslation();
  const { message, modal } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const footageInput = useRef<HTMLInputElement>(null);
  const [projectPicker, setProjectPicker] = useState(false);
  const [footagePicker, setFootagePicker] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [section, setSectionState] = useState<Section>(savedSection);
  const [filter, setFilter] = useState<StateFilter>("all");
  const setSection = (s: Section) => { setSectionState(s); try { localStorage.setItem(SECTION_KEY, s); } catch { /* this visit only */ } };
  const sources = useQuery({
    queryKey: ["sources", projectId, videoId ?? null], queryFn: () => client.listSources(projectId, videoId),
    refetchInterval: (q) => (q.state.data?.sources.some((s) => s.asset?.state === "queued" || s.asset?.state === "preparing") ? 3000 : false),
  });
  const jobs = useQuery({
    queryKey: ["jobs", projectId, videoId ?? null], queryFn: () => client.listJobs(projectId, videoId ? { videoId } : {}),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === "queued" || j.status === "running") ? 2000 : false),
  });
  const videos = useQuery({ queryKey: ["videos", projectId], queryFn: () => client.listVideos(projectId), enabled: !videoId });
  const refresh = () => {
    for (const k of ["sources", "jobs", "activity", "playbook"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
  };
  const fail = (fallback: string) => (e: unknown) => void message.error(e instanceof StudioHttpError ? e.message : fallback);
  const prepare = useMutation({ mutationFn: (p: { assetId: string; again: boolean }) => client.prepareInputs(projectId, [p.assetId], p.again), onSuccess: refresh, onError: fail(t("ws.inputs.prepareFailed")) });
  const bulk = useMutation({
    mutationFn: async (ids: string[]) => {
      for (let i = 0; i < ids.length; i += PREPARE_BATCH) await client.prepareInputs(projectId, ids.slice(i, i + PREPARE_BATCH));
      return ids.length;
    },
    onSuccess: (n) => { refresh(); void message.success(t("ws.inputs.bulkQueued", { count: n })); },
    onError: (e) => { refresh(); fail(t("ws.inputs.prepareFailed"))(e); },
  });
  const remove = useMutation({
    mutationFn: (p: { source: SourceItem; force?: boolean }) => client.removeSource(projectId, p.source.id, p.force ? { force: true } : {}),
    onSuccess: refresh,
    onError: (e, p) => {
      // an ag-go project whose videos are still used: removed only once the person says so
      if (e instanceof StudioHttpError && e.code === "project_in_use") {
        const titles = Array.isArray(e.body?.videos) ? (e.body.videos as string[]) : [];
        modal.confirm({
          title: t("ws.inputs.projectInUse.title", { name: p.source.label }),
          content: (
            <>
              <p>{t("ws.inputs.projectInUse.body", { count: typeof e.body?.assets === "number" ? e.body.assets : 1 })}</p>
              {titles.length ? <p className="ws-hint">{t("ws.inputs.projectInUse.videos", { titles: titles.join(", ") })}</p> : null}
            </>
          ),
          okText: t("ws.inputs.projectInUse.ok"), okButtonProps: { danger: true }, cancelText: t("common.cancel"),
          onOk: () => remove.mutate({ source: p.source, force: true }),
        });
        return;
      }
      fail(t("ws.inputs.removeFailed"))(e);
    },
  });
  const stop = useMutation({ mutationFn: (j: JobView) => client.cancelJob(projectId, j.id), onSuccess: refresh, onError: fail(t("ws.jobs.stopFailed")) });
  const uploading = useUploadProgress();
  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const progress = uploading.start(files);
      return Promise.all(files.map((f, i) => client.uploadSource(projectId, f, videoId, { onProgress: progress[i] })));
    },
    onSettled: uploading.done,
    onSuccess: (r) => {
      refresh();
      for (const k of ["files", "audio"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
      void message.success(t("ws.inputs.uploaded", { count: r.length }));
    },
    onError: fail(t("ws.inputs.uploadFailed")),
  });
  const uploadingFootage = useUploadProgress();
  const uploadFootage = useMutation({
    mutationFn: (files: File[]) => {
      const progress = uploadingFootage.start(files);
      return Promise.all(files.map((f, i) => client.uploadFootage(projectId, f, videoId!, progress[i])));
    },
    onSettled: uploadingFootage.done,
    onSuccess: (r) => { refresh(); void message.success(t("ws.inputs.footageUploaded", { count: r.length })); },
    onError: (e) => { refresh(); fail(t("ws.inputs.uploadFailed"))(e); },
  });
  const uploadingReference = useUploadProgress();
  const uploadReference = useMutation({
    mutationFn: (files: File[]) => {
      const progress = uploadingReference.start(files);
      return Promise.all(files.map((f, i) => client.uploadSource(projectId, f, undefined, { reference: true, onProgress: progress[i] })));
    },
    onSettled: uploadingReference.done,
    onSuccess: (r) => { refresh(); void qc.invalidateQueries({ queryKey: ["files", projectId] }); void message.success(t("ws.inputs.uploaded", { count: r.length })); },
    onError: fail(t("ws.inputs.uploadFailed")),
  });

  const all = sources.data?.sources ?? [];
  const agGoProjects = all.filter((s) => s.kind === "ag_go_project");
  const videoAssets = all.filter((s) => isFootage(s) && (videoId ? s.videoId === videoId : true));
  const uploads = all.filter((s) => s.kind === "upload" && !s.meta.reference);
  const references = all.filter((s) => s.kind === "upload" && s.meta.reference === true);
  const counts = videoId ? countAssets(videoAssets) : sources.data?.counts ?? countAssets(videoAssets);
  const jobList = jobs.data?.jobs ?? [];
  const active = jobList.filter((j) => j.status === "queued" || j.status === "running");
  const recent = jobList.filter((j) => j.status !== "queued" && j.status !== "running").slice(0, 3);
  const shownJobs = [...active, ...recent];
  const removeButton = (s: SourceItem) => canEdit ? (
    <Popconfirm title={t("ws.inputs.removeUploadConfirm", { name: s.label })} onConfirm={() => remove.mutate({ source: s })} okText={t("ws.inputs.remove")} cancelText={t("common.cancel")}>
      <button type="button" className="ws-icon-button" aria-label={t("ws.inputs.removeNamed", { name: s.label })}><Trash2 size={13} /></button>
    </Popconfirm>
  ) : null;

  return (
    <div className="ws-inputs">
      <AudioCard projectId={projectId} canEdit={canEdit} canProduce={canProduce} />
      {videoId ? <VideoMusicCard projectId={projectId} videoId={videoId} canEdit={canEdit} /> : null}

      {sources.isLoading ? <div className="ws-center"><Spin /></div> : (
        <>
          {counts.videos || shownJobs.length ? (
            <div className="ws-inputs__overview">
              {counts.videos ? <SummaryBar counts={counts} onFilter={(f) => { setFilter(f); setSection("footage"); }} /> : null}
              {shownJobs.length ? (
                <section aria-label={t("ws.jobs.title")} className="ws-inputs__jobs">
                  <JobsLine jobs={shownJobs} open={jobsOpen} onToggle={() => setJobsOpen(!jobsOpen)} />
                  {jobsOpen ? (
                    <JobList jobs={shownJobs} fold={false} onStop={canEdit ? (x) => stop.mutate(x) : undefined} stopping={stop.isPending ? stop.variables?.id ?? null : null} />
                  ) : null}
                </section>
              ) : null}
            </div>
          ) : null}

          <Segmented block size="small" value={section} onChange={(v) => setSection(v as Section)} aria-label={t("ws.inputs.sectionLabel")}
            options={[
              { value: "footage", label: t("ws.inputs.section.footage", { count: counts.videos }) },
              { value: "files", label: t("ws.inputs.section.files", { count: uploads.length + references.length }) },
            ]} />

          {section === "footage" ? (
            <>
              <section aria-label={t("ws.inputs.agGoProjects")}>
                <div className="ws-inputs__head">
                  <h4 className="ws-inputs__h">{t("ws.inputs.agGoProjects")} <span className="ws-hint">{agGoProjects.length || ""}</span></h4>
                  {canEdit ? <Button size="small" icon={<Plus size={13} />} onClick={() => setProjectPicker(true)}>{t("ws.inputs.addProject")}</Button> : null}
                </div>
                {agGoProjects.length ? <AgGoProjectList projects={agGoProjects} canEdit={canEdit} onRemove={(s) => remove.mutate({ source: s })} />
                  : <p className="ws-hint">{t("ws.inputs.noProjectYet")}</p>}
              </section>

              {videoId || videoAssets.length ? (
                <section aria-label={videoId ? t("ws.inputs.videoFootage") : t("ws.inputs.preparedFootage")}>
                  <div className="ws-inputs__head">
                    <h4 className="ws-inputs__h">{videoId ? t("ws.inputs.videoFootage") : t("ws.inputs.preparedFootage")}</h4>
                    {videoId && canEdit ? (
                      <span className="ws-inputs__actions">
                        <Button size="small" icon={<Plus size={13} />} disabled={!agGoProjects.length} onClick={() => setFootagePicker(true)}>{t("ws.inputs.pickVideos")}</Button>
                        <Button size="small" icon={<Upload size={13} />} loading={uploadFootage.isPending} title={t("ws.inputs.uploadFootageHint")} onClick={() => footageInput.current?.click()}>
                          {uploadingFootage.percent !== null ? t("common.uploading", { pct: uploadingFootage.percent }) : t("ws.inputs.uploadFootage")}
                        </Button>
                        <input ref={footageInput} type="file" multiple hidden accept={FOOTAGE_ACCEPT} aria-label={t("ws.inputs.uploadFootage")}
                          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) uploadFootage.mutate(files); }} />
                      </span>
                    ) : null}
                  </div>
                  {videoAssets.length ? (
                    <FootageAssets assets={videoAssets} videos={videos.data?.videos ?? []} grouped={!videoId} filter={filter} onFilter={setFilter} canEdit={canEdit}
                      onOpenFile={onOpenFile} onPrepare={(assetId, again) => prepare.mutate({ assetId, again })} onRemove={(x) => remove.mutate({ source: x })}
                      onBulk={(ids) => bulk.mutate(ids)} bulkBusy={bulk.isPending} />
                  ) : <p className="ws-hint">{agGoProjects.length || videoId ? t("ws.inputs.noVideoYet") : t("ws.inputs.addProjectFirst")}</p>}
                </section>
              ) : null}
            </>
          ) : (
            <>
              <section aria-label={t("ws.inputs.files")}>
                <div className="ws-inputs__head">
                  <h4 className="ws-inputs__h">{t("ws.inputs.files")}</h4>
                  {canEdit ? (
                    <>
                      <Button size="small" icon={<Upload size={13} />} loading={upload.isPending} onClick={() => fileInput.current?.click()}>
                        {uploading.percent !== null ? t("common.uploading", { pct: uploading.percent }) : t("ws.inputs.upload")}
                      </Button>
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
                          {removeButton(s)}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>

              <section aria-label={t("ws.inputs.references")}>
                <div className="ws-inputs__head">
                  <h4 className="ws-inputs__h">{t("ws.inputs.references")}</h4>
                  {canEdit ? (
                    <>
                      <Button size="small" icon={<Upload size={13} />} loading={uploadReference.isPending} onClick={() => referenceInput.current?.click()}>
                        {uploadingReference.percent !== null ? t("common.uploading", { pct: uploadingReference.percent }) : t("ws.inputs.uploadReference")}
                      </Button>
                      <input ref={referenceInput} type="file" multiple hidden accept={REFERENCE_ACCEPT} aria-label={t("ws.inputs.uploadReference")}
                        onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) uploadReference.mutate(files); }} />
                    </>
                  ) : null}
                </div>
                <p className="ws-hint">{t("ws.inputs.referencesHint")}</p>
                {references.length ? (
                  <ul className="ws-inputs__list">
                    {references.map((s) => (
                      <li key={s.id} className="ws-inputs__row">
                        <Film size={14} aria-hidden />
                        <button type="button" className="ws-link ws-inputs__name" onClick={() => onOpenFile(s.ref)}>{s.label}</button>
                        {removeButton(s)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            </>
          )}
        </>
      )}

      <AgGoProjectDrawer projectId={projectId} picked={all} open={projectPicker} onClose={() => setProjectPicker(false)} />
      {videoId ? <FootagePicker projectId={projectId} videoId={videoId} sources={all} open={footagePicker} onClose={() => setFootagePicker(false)} /> : null}
    </div>
  );
}
