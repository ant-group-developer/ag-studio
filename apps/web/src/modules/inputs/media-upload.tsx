import { useEffect, useState } from "react";
import "./inputs.css";
import { App as AntApp, Checkbox, Input, Modal, Radio } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { useUploadProgress } from "../common/upload-progress";
import { VideoChecklist } from "./media-library";

/** Footage from the computer: the API's `FOOTAGE_VIDEO_EXTS` and `FOOTAGE_IMAGE_EXTS`. */
export const FOOTAGE_ACCEPT = ".mp4,.mov,.m4v,.mkv,.webm,.avi,.mts,.m2ts,.jpg,.jpeg,.png,.webp";
/** Reference videos to learn an edit style from: the API's `REFERENCE_VIDEO_EXTS`. */
export const REFERENCE_ACCEPT = ".mp4,.mov,.m4v,.mkv,.webm,.avi";
const FOOTAGE_RE = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|jpe?g|png|webp)$/i;
const REFERENCE_RE = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
const PHOTO_RE = /\.(jpe?g|png|webp)$/i;
/** A plain file of the project (`WORKSPACE_UPLOAD_MAX_BYTES`); audio goes to its own place, not asked here. */
const FILE_MAX_BYTES = 50 * 1024 * 1024;

/** A video or a photo that can become footage (what the upload asks what it is for). */
export const isFootageFile = (f: File) => FOOTAGE_RE.test(f.name);

export type MediaUse = "footage" | "reference" | "file";
/** Which Studio videos footage goes into (any number), and a new one made first by its title. None: the project's own footage. */
export interface FootageTarget { videoIds: string[]; newTitle?: string }

/**
 * Uploads from the computer as footage of videos (a new one made first; prepared once like an ag-go video), as
 * reference videos to learn an edit style from, or as plain files of the project. Videos and audio go into the
 * person's media library on the bucket (plan 2026-10-29), so other projects pick them again. Each says how it went.
 */
export function useMediaUpload(projectId: string) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const progress = useUploadProgress();
  const refresh = (...keys: string[]) => { for (const k of ["sources", "jobs", "activity", "playbook", ...keys]) void qc.invalidateQueries({ queryKey: [k, projectId] }); };
  const fail = (fallback: string) => (e: unknown) => void message.error(e instanceof StudioHttpError ? e.message : fallback);
  const upload = useMutation({
    mutationFn: async ({ files, use, target }: { files: File[]; use: MediaUse; target?: FootageTarget }) => {
      let videoIds: string[] = [];
      if (use === "footage") {
        if (!target) throw new Error("no video");
        videoIds = [...target.videoIds, ...(target.newTitle ? [(await client.createVideo(projectId, { title: target.newTitle })).id] : [])];
      }
      const each = progress.start(files);
      await Promise.all(files.map((f, i) => (use === "footage" ? client.uploadFootage(projectId, f, videoIds, each[i])
        : use === "reference" ? client.uploadSource(projectId, f, undefined, { reference: true, onProgress: each[i] })
          : client.uploadFile(projectId, f, "context", each[i]))));
      return { use, count: files.length, newVideo: !!target?.newTitle };
    },
    onSettled: progress.done,
    onSuccess: ({ use, count, newVideo }) => {
      refresh("files", ...(newVideo ? ["project", "threads", "videos"] : []));
      void message.success(t(use === "footage" ? "ws.inputs.footageUploaded" : use === "reference" ? "ws.media.referencesUploaded" : "ws.files.uploaded", { count }));
    },
    onError: (e) => { refresh(); fail(t("ws.inputs.uploadFailed"))(e); },
  });
  return { upload, percent: progress.percent };
}

/**
 * What the videos and photos just picked or dropped are for: footage of videos (this one ticked first, any others, a new
 * one), reference videos for the edit style, or only files of the project (photos only: a video is never kept on the
 * server). `uses` limits the choices.
 */
export function MediaUploadModal({ open, files, videos, currentVideoId, uses = ["footage", "reference", "file"], busy, onCancel, onConfirm }: {
  open: boolean;
  files: File[];
  videos: { id: string; idx: number; title: string }[];
  currentVideoId?: string | undefined;
  uses?: MediaUse[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (use: MediaUse, target?: FootageTarget) => void;
}) {
  const { t } = useAiTranslation();
  const references = files.every((f) => REFERENCE_RE.test(f.name));
  const tooBig = files.some((f) => f.size > FILE_MAX_BYTES);
  const photos = files.every((f) => PHOTO_RE.test(f.name));
  const allowed = uses.filter((u) => (u === "reference" ? references : u === "file" ? !tooBig && photos : true));
  const [use, setUse] = useState<MediaUse>("footage");
  const [picked, setPicked] = useState<string[]>([]);
  const [makeNew, setMakeNew] = useState(false);
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (!open) return;
    setUse(allowed[0] ?? "footage");
    setPicked(currentVideoId ? [currentVideoId] : videos[0] ? [videos[0].id] : []);
    setMakeNew(!videos.length && !currentVideoId);
    setTitle("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const newTitle = makeNew ? title.trim() : "";
  const target: FootageTarget | undefined = use !== "footage" ? undefined : { videoIds: picked, ...(newTitle ? { newTitle } : {}) };
  const ready = use !== "footage" || ((picked.length > 0 || !!newTitle) && (!makeNew || !!newTitle));
  const names = files.slice(0, 3).map((f) => f.name).join(", ") + (files.length > 3 ? t("ws.media.andMore", { count: files.length - 3 }) : "");
  return (
    <Modal open={open} title={t("ws.media.title", { count: files.length })} okText={t("ws.media.ok")} cancelText={t("common.cancel")}
      okButtonProps={{ disabled: !ready }} confirmLoading={busy} onCancel={onCancel} onOk={() => onConfirm(use, target)} destroyOnHidden>
      <p className="ws-hint" style={{ marginTop: 0 }}>{names}</p>
      <Radio.Group className="ws-media__uses" value={use} onChange={(e) => setUse(e.target.value as MediaUse)} aria-label={t("ws.media.useLabel")}>
        {uses.map((u) => (
          <Radio key={u} value={u} disabled={!allowed.includes(u)}>
            <span className="ws-media__use">{t(`ws.media.use.${u}`)}</span>
            <span className="ws-hint ws-media__usehint">{t(!allowed.includes(u) ? `ws.media.cannot.${u}` : `ws.media.hint.${u}`)}</span>
          </Radio>
        ))}
      </Radio.Group>
      {use === "footage" ? (
        <div className="ws-media__target">
          <span className="ws-media__use">{t("ws.media.pickVideos")}</span>
          <VideoChecklist videos={videos} value={picked} onChange={setPicked} currentVideoId={currentVideoId} label={t("ws.media.pickVideos")} />
          <Checkbox checked={makeNew} onChange={(e) => setMakeNew(e.target.checked)}>{t("ws.media.newVideo")}</Checkbox>
          {makeNew ? (
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={t("ws.media.newVideoTitle")} aria-label={t("ws.media.newVideoTitle")} />
          ) : null}
          <p className="ws-media__lib">{t("ws.media.toLibrary")}</p>
        </div>
      ) : use === "reference" ? <p className="ws-media__lib">{t("ws.media.toLibrary")}</p> : null}
    </Modal>
  );
}
