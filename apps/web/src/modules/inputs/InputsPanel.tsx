import { useMemo, useRef, useState } from "react";
import { App as AntApp, Button, Popconfirm, Spin } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, FileText, Film, FolderKanban, FolderSearch, Image as ImageIcon, Library, Music, Plus, Trash2, Upload } from "lucide-react";
import { useAiTranslation } from "../common/assistant-name";
import { StudioHttpError } from "../../api/http";
import { isFootage, useWorkspaceClient, type JobView, type SourceItem } from "../../api/workspace-client";
import { AddMenu, SectionCard } from "../common/SectionCard";
import { FootagePicker } from "./AgGoPickers";
import { AgGoProjectDrawer } from "./ag-go-projects/AgGoProjectDrawer";
import { JobList, JobsLine } from "./JobList";
import { AudioCard, UseAudioButtons, VideoMusicCard } from "./AudioControls";
import { useUploadProgress } from "../common/upload-progress";
import { AgGoProjectList, countAssets, FootageAssets, SummaryBar, type StateFilter } from "./FootageAssets";
import { FootageVideosModal, MediaLibraryDrawer } from "./media-library";
import { FOOTAGE_ACCEPT, MediaUploadModal, useMediaUpload } from "./media-upload";
import "./inputs.css";

/** Documents and images kept in the project's folder (audio and videos go to the media library). */
const DOC_ACCEPT = ".md,.txt,.pdf,.csv,.json,.srt,.vtt,.jpg,.jpeg,.png,.webp,.gif";
const AUDIO_ACCEPT = ".mp3,.wav,.m4a,.aac,.ogg,.flac";
const KIND_ICON = { document: FileText, image: ImageIcon, audio: Music, video: Film, mixed: FolderKanban } as const;
/** How many prepare requests one call takes (the API's limit). */
const PREPARE_BATCH = 40;

type LibraryUse = "footage" | "audio";

/**
 * The Sources tab (spec 2026-10-10 agent-workspace §4, layout plan 2026-10-29): how the footage stands and the
 * background jobs on top, then four sections, each in its own box with one way to add: the ag-go projects the agent
 * searches; Footage (of this video, or on the project page of every video grouped by video), each file showing the
 * videos it is in, added from ag-go, the computer or the person's media library; Sound (the voice, the music, the audio
 * files); and the documents and images uploaded. Reference videos live in the Style tab.
 */
export function InputsPanel({ projectId, videoId, canEdit, canProduce = false, onOpenFile }: {
  projectId: string; videoId?: string; canEdit: boolean; canProduce?: boolean; onOpenFile: (path: string) => void;
}) {
  const { t } = useAiTranslation();
  const { message, modal } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const docInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const footageInput = useRef<HTMLInputElement>(null);
  const [projectPicker, setProjectPicker] = useState(false);
  const [footagePicker, setFootagePicker] = useState(false);
  const [library, setLibrary] = useState<LibraryUse | null>(null);
  const [videosOf, setVideosOf] = useState<SourceItem | null>(null);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [filter, setFilter] = useState<StateFilter>("all");
  const sources = useQuery({
    queryKey: ["sources", projectId, videoId ?? null], queryFn: () => client.listSources(projectId, videoId),
    refetchInterval: (q) => (q.state.data?.sources.some((s) => s.asset?.state === "queued" || s.asset?.state === "preparing") ? 3000 : false),
  });
  // every video's footage: which videos each file is in (on the project page, the list above already is it)
  const everyVideo = useQuery({ queryKey: ["sources", projectId, null], queryFn: () => client.listSources(projectId), enabled: !!videoId });
  const jobs = useQuery({
    queryKey: ["jobs", projectId, videoId ?? null], queryFn: () => client.listJobs(projectId, videoId ? { videoId } : {}),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === "queued" || j.status === "running") ? 2000 : false),
  });
  const videos = useQuery({ queryKey: ["videos", projectId], queryFn: () => client.listVideos(projectId) });
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
    onSuccess: () => { refresh(); void qc.invalidateQueries({ queryKey: ["audio", projectId] }); },
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
      return Promise.all(files.map((f, i) => client.uploadSource(projectId, f, undefined, { onProgress: progress[i] })));
    },
    onSettled: uploading.done,
    onSuccess: (r) => {
      refresh();
      for (const k of ["files", "audio"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
      void message.success(t("ws.inputs.uploaded", { count: r.length }));
    },
    onError: fail(t("ws.inputs.uploadFailed")),
  });
  // footage from the computer: asked which videos it goes into (this one ticked first), then uploaded into the library
  const media = useMediaUpload(projectId);
  const [picked, setPicked] = useState<File[] | null>(null);
  // on the project page, a video's group takes footage from the computer straight in
  const groupInput = useRef<HTMLInputElement>(null);
  const uploadInto = useRef<string | null>(null);

  const all = sources.data?.sources ?? [];
  const agGoProjects = all.filter((s) => s.kind === "ag_go_project");
  const videoAssets = all.filter((s) => isFootage(s) && (videoId ? s.videoId === videoId : true));
  const uploads = all.filter((s) => s.kind === "upload" && !s.meta.reference);
  const audioFiles = uploads.filter((s) => s.mediaType === "audio");
  const docs = uploads.filter((s) => s.mediaType !== "audio");
  const counts = videoId ? countAssets(videoAssets) : sources.data?.counts ?? countAssets(videoAssets);
  const jobList = jobs.data?.jobs ?? [];
  const active = jobList.filter((j) => j.status === "queued" || j.status === "running");
  const recent = jobList.filter((j) => j.status !== "queued" && j.status !== "running").slice(0, 3);
  const shownJobs = [...active, ...recent];
  const videoList = videos.data?.videos ?? [];
  const byId = useMemo(() => new Map(videoList.map((v) => [v.id, v])), [videoList]);
  // which videos each footage is in, across the project
  const inVideos = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of (videoId ? everyVideo.data?.sources : all) ?? []) {
      if (!isFootage(s) || !s.videoId) continue;
      m.set(s.ref, [...new Set([...(m.get(s.ref) ?? []), s.videoId])]);
    }
    return m;
  }, [all, everyVideo.data, videoId]);
  const libraryIn = (use: LibraryUse) => new Set(all.filter((s) => s.mediaId && (use === "footage" ? isFootage(s) : s.kind === "upload" && s.mediaType === "audio")).map((s) => s.mediaId!));

  const chips = (s: SourceItem) => {
    const ids = [...(inVideos.get(s.ref) ?? [])].sort((a, b) => (byId.get(a)?.idx ?? 0) - (byId.get(b)?.idx ?? 0));
    return (
      <span className="ws-vchips">
        {s.mediaId ? <span className="ws-badge-lib">{t("ws.library.badge")}</span> : null}
        {ids.map((id) => {
          const v = byId.get(id);
          return v ? <span key={id} className={`ws-vchip${id === videoId ? " ws-vchip--current" : ""}`} title={v.title}>#{v.idx}</span> : null;
        })}
        {canEdit ? <button type="button" className="ws-vchip ws-vchip--add" onClick={() => setVideosOf(s)} aria-label={t("ws.library.useForVideos", { name: s.label })}>{t("ws.library.addVideo")}</button> : null}
      </span>
    );
  };
  const removeButton = (s: SourceItem) => canEdit ? (
    <Popconfirm title={t(s.mediaId ? "ws.inputs.removeLibraryConfirm" : "ws.inputs.removeUploadConfirm", { name: s.label })} onConfirm={() => remove.mutate({ source: s })} okText={t("ws.inputs.remove")} cancelText={t("common.cancel")}>
      <button type="button" className="ws-icon-button" aria-label={t("ws.inputs.removeNamed", { name: s.label })}><Trash2 size={13} /></button>
    </Popconfirm>
  ) : null;

  return (
    <div className="ws-secs ws-inputs">
      {sources.isLoading ? <div className="ws-center"><Spin /></div> : (
        <>
          {counts.videos || shownJobs.length ? (
            <div className="ws-inputs__overview">
              {counts.videos ? <SummaryBar counts={counts} onFilter={setFilter} /> : null}
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

          <SectionCard icon={<FolderSearch size={15} />} title={t("ws.inputs.agGoProjects")} count={agGoProjects.length}
            action={canEdit ? <Button size="small" icon={<Plus size={14} />} onClick={() => setProjectPicker(true)}>{t("ws.inputs.addProject")}</Button> : null}>
            {agGoProjects.length ? <AgGoProjectList projects={agGoProjects} canEdit={canEdit} onRemove={(s) => remove.mutate({ source: s })} />
              : <p className="ws-hint ws-inputs__empty">{t("ws.inputs.noProjectYet")}</p>}
          </SectionCard>

          <SectionCard icon={<Film size={15} />} title={videoId ? t("ws.inputs.videoFootage") : t("ws.inputs.preparedFootage")} count={counts.videos}
            label={t(videoId ? "ws.inputs.videoFootage" : "ws.inputs.preparedFootage")}
            action={canEdit ? (
              <AddMenu primary icon={<Plus size={14} />} label={media.percent !== null ? t("common.uploading", { pct: media.percent }) : t("ws.inputs.addFootage")}
                loading={media.upload.isPending} items={[
                  ...(videoId ? [{ key: "ag-go", icon: <FolderSearch size={14} />, label: t("ws.inputs.pickVideos"), hint: t("ws.inputs.pickVideosHint"), disabled: !agGoProjects.length, onClick: () => setFootagePicker(true) }] : []),
                  { key: "upload", icon: <Upload size={14} />, label: t("ws.inputs.uploadFootage"), hint: t("ws.inputs.uploadFootageHint"), onClick: () => footageInput.current?.click() },
                  { key: "library", icon: <Library size={14} />, label: t("ws.library.fromLibrary"), hint: t("ws.library.fromLibraryHint"), onClick: () => setLibrary("footage") },
                ]} />
            ) : null}>
            {videoAssets.length ? (
              <FootageAssets assets={videoAssets} videos={videoList} grouped={!videoId} filter={filter} onFilter={setFilter} canEdit={canEdit}
                onOpenFile={onOpenFile} onPrepare={(assetId, again) => prepare.mutate({ assetId, again })} onRemove={(x) => remove.mutate({ source: x })}
                onBulk={(ids) => bulk.mutate(ids)} bulkBusy={bulk.isPending} lineExtra={chips}
                onUploadTo={videoId || !canEdit ? undefined : (id) => { uploadInto.current = id; groupInput.current?.click(); }} />
            ) : <p className="ws-hint ws-inputs__empty">{agGoProjects.length || videoId ? t("ws.inputs.noVideoYet") : t("ws.inputs.addFootageFirst")}</p>}
            <input ref={footageInput} type="file" multiple hidden accept={FOOTAGE_ACCEPT} aria-label={t("ws.inputs.uploadFootage")}
              onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) setPicked(files); }} />
            <input ref={groupInput} type="file" multiple hidden accept={FOOTAGE_ACCEPT} aria-label={t("ws.inputs.uploadToVideo")}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]; e.target.value = "";
                if (files.length && uploadInto.current) media.upload.mutate({ files, use: "footage", target: { videoIds: [uploadInto.current] } });
              }} />
          </SectionCard>

          <SectionCard icon={<AudioLines size={15} />} title={t("ws.inputs.sound")} count={audioFiles.length} className="ws-inputs__sound"
            action={canEdit ? (
              <AddMenu icon={<Plus size={14} />} label={uploading.percent !== null && upload.isPending ? t("common.uploading", { pct: uploading.percent }) : t("ws.inputs.addAudio")}
                loading={upload.isPending} items={[
                  { key: "upload", icon: <Upload size={14} />, label: t("ws.inputs.uploadAudio"), hint: t("ws.inputs.uploadAudioHint"), onClick: () => audioInput.current?.click() },
                  { key: "library", icon: <Library size={14} />, label: t("ws.library.fromLibrary"), onClick: () => setLibrary("audio") },
                ]} />
            ) : null}>
            <AudioCard projectId={projectId} canEdit={canEdit} canProduce={canProduce} />
            {videoId ? <VideoMusicCard projectId={projectId} videoId={videoId} canEdit={canEdit} /> : null}
            <span className="ws-sub">{t("ws.inputs.audioFiles")}</span>
            {audioFiles.length ? (
              <ul className="ws-inputs__list">
                {audioFiles.map((s) => (
                  <li key={s.id} className="ws-inputs__row">
                    <Music size={14} aria-hidden />
                    <span className="ws-inputs__text">
                      <button type="button" className="ws-link ws-inputs__name" onClick={() => onOpenFile(s.ref)}>{s.label}</button>
                      {s.mediaId ? <span className="ws-vchips"><span className="ws-badge-lib">{t("ws.library.badge")}</span></span> : null}
                    </span>
                    <UseAudioButtons projectId={projectId} path={s.ref} canEdit={canEdit} canProduce={canProduce} />
                    {removeButton(s)}
                  </li>
                ))}
              </ul>
            ) : <p className="ws-hint ws-inputs__empty">{t("ws.inputs.noAudio")}</p>}
            <input ref={audioInput} type="file" multiple hidden accept={AUDIO_ACCEPT} aria-label={t("ws.inputs.uploadAudio")}
              onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) upload.mutate(files); }} />
          </SectionCard>

          <SectionCard icon={<FileText size={15} />} title={t("ws.inputs.files")} count={docs.length} hint={t("ws.inputs.filesHint")}
            action={canEdit ? (
              <>
                <Button size="small" icon={<Upload size={14} />} loading={upload.isPending} onClick={() => docInput.current?.click()}>{t("ws.inputs.upload")}</Button>
                <input ref={docInput} type="file" multiple hidden accept={DOC_ACCEPT} aria-label={t("ws.inputs.upload")}
                  onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) upload.mutate(files); }} />
              </>
            ) : null}>
            {docs.length ? (
              <ul className="ws-inputs__list">
                {docs.map((s) => {
                  const Icon = KIND_ICON[s.mediaType];
                  return (
                    <li key={s.id} className="ws-inputs__row">
                      <Icon size={14} aria-hidden />
                      <button type="button" className="ws-link ws-inputs__name" onClick={() => onOpenFile(s.ref)}>{s.label}</button>
                      {removeButton(s)}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </SectionCard>
          <p className="ws-hint ws-inputs__moved">{t("ws.inputs.referencesMoved")}</p>
        </>
      )}

      <MediaUploadModal open={!!picked} files={picked ?? []} videos={videoList} currentVideoId={videoId} uses={["footage"]} busy={media.upload.isPending}
        onCancel={() => setPicked(null)}
        onConfirm={(use, target) => { const files = picked ?? []; setPicked(null); media.upload.mutate({ files, use, ...(target ? { target } : {}) }); }} />
      <MediaLibraryDrawer open={library !== null} projectId={projectId} use={library ?? "footage"} videos={videoList} currentVideoId={videoId}
        inProject={libraryIn(library ?? "footage")} onClose={() => setLibrary(null)} />
      <FootageVideosModal open={!!videosOf} projectId={projectId} assetId={videosOf?.ref ?? null} name={videosOf?.label ?? ""} videos={videoList}
        inVideos={videosOf ? inVideos.get(videosOf.ref) ?? [] : []} currentVideoId={videoId} onClose={() => setVideosOf(null)} />
      <AgGoProjectDrawer projectId={projectId} picked={all} open={projectPicker} onClose={() => setProjectPicker(false)} />
      {videoId ? <FootagePicker projectId={projectId} videoId={videoId} sources={all} open={footagePicker} onClose={() => setFootagePicker(false)} /> : null}
    </div>
  );
}
