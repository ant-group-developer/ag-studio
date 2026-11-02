import { useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Button, Checkbox, Drawer, Empty, Input, Modal, Popconfirm, Segmented, Spin } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Library, Music, Plus, Trash2, Upload } from "lucide-react";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type MediaItem, type MediaKind, type MediaUseKind } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { useUploadProgress } from "../common/upload-progress";
import { AgMusicPicker, pauseOthers, useAgMusicEnabled } from "./ag-music-picker";
import "./media-library.css";

/** The library's kinds a use takes. */
const KINDS: Record<MediaUseKind, MediaKind[]> = { footage: ["video", "image"], audio: ["audio"], reference: ["video"] };
/** What the drawer's upload button takes, by use. */
const ACCEPT: Record<MediaUseKind, string> = {
  footage: ".mp4,.mov,.m4v,.mkv,.webm,.avi,.mts,.m2ts,.jpg,.jpeg,.png,.webp",
  audio: ".mp3,.wav,.m4a,.aac,.ogg,.flac",
  reference: ".mp4,.mov,.m4v,.mkv,.webm,.avi",
};
const LIMIT = 120;

interface VideoRef { id: string; idx: number; title: string }

/** ag-music's category kinds in the order its sidebar has them. */
const CATEGORY_ORDER = ["GENRE", "THEME", "MOOD", "EFFECT", "INSTRUMENT"];

const sizeOf = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Ticks for the videos of a project, newest first; the one open is marked. */
export function VideoChecklist({ videos, value, onChange, currentVideoId, label }: {
  videos: VideoRef[]; value: string[]; onChange: (ids: string[]) => void; currentVideoId?: string | undefined; label: string;
}) {
  const { t } = useAiTranslation();
  const sorted = [...videos].sort((a, b) => b.idx - a.idx);
  return (
    <div className="ws-vlist" role="group" aria-label={label}>
      {sorted.length ? sorted.map((v) => (
        <label key={v.id} className="ws-vlist__row">
          <Checkbox checked={value.includes(v.id)} onChange={(e) => onChange(e.target.checked ? [...value, v.id] : value.filter((x) => x !== v.id))} />
          <span className="ws-vlist__name">#{v.idx} {v.title}</span>
          {v.id === currentVideoId ? <span className="ws-hint">{t("ws.library.current")}</span> : null}
        </label>
      )) : <p className="ws-hint ws-vlist__none">{t("ws.library.noVideos")}</p>}
    </div>
  );
}

/** "Use for videos…": exactly the videos a footage of the project is in (it is prepared once for all of them). */
export function FootageVideosModal({ open, projectId, assetId, name, videos, inVideos, currentVideoId, onClose }: {
  open: boolean; projectId: string; assetId: string | null; name: string; videos: VideoRef[]; inVideos: string[]; currentVideoId?: string | undefined; onClose: () => void;
}) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const [value, setValue] = useState<string[]>(inVideos);
  useEffect(() => { if (open) setValue(inVideos); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => client.setFootageVideos(projectId, assetId!, value),
    onSuccess: () => {
      for (const k of ["sources", "jobs", "playbook"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
      void message.success(t("ws.library.videosSaved", { count: value.length }));
      onClose();
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.library.saveFailed")),
  });
  return (
    <Modal open={open} title={t("ws.library.useForVideos", { name })} okText={t("common.save")} cancelText={t("common.cancel")}
      confirmLoading={save.isPending} onOk={() => save.mutate()} onCancel={onClose} destroyOnHidden>
      <p className="ws-hint" style={{ marginTop: 0 }}>{t("ws.library.preparedOnce")}</p>
      <VideoChecklist videos={videos} value={value} onChange={setValue} currentVideoId={currentVideoId} label={t("ws.library.videosLabel")} />
    </Modal>
  );
}

/** One row of the library: tick, a small picture (a photo, a video's first frame, a note for audio), name, size, where it is used. */
function MediaRow({ item, selected, inProject, onToggle, onDelete, deleting }: {
  item: MediaItem; selected: boolean; inProject: boolean; onToggle: () => void; onDelete: () => void; deleting: boolean;
}) {
  const { t } = useAiTranslation();
  const ag = item.origin?.system === "ag-music" ? item.origin : null;
  const cats = [...(ag?.categories ?? [])].sort((a, b) => CATEGORY_ORDER.indexOf(a.kind) - CATEGORY_ORDER.indexOf(b.kind));
  const used = !item.usedIn.length ? t("ws.library.unused")
    : item.usedIn.length === 1 ? t("ws.library.usedIn", { name: item.usedIn[0]!.name }) : t("ws.library.usedInMore", { name: item.usedIn[0]!.name, count: item.usedIn.length - 1 });
  return (
    <li className={`ws-mrow${selected ? " ws-mrow--on" : ""}${inProject ? " ws-mrow--in" : ""}`}>
      <button type="button" className="ws-mrow__pick" aria-pressed={selected} disabled={inProject} onClick={onToggle} aria-label={item.name}>
        <span className="ws-mrow__tick" aria-hidden>{selected ? <Check size={12} /> : null}</span>
        <span className={`ws-mrow__cover ws-mrow__cover--${item.kind}`}>
          {item.kind === "image" ? <img src={item.previewUrl} alt="" loading="lazy" />
            : item.kind === "video" ? <video src={`${item.previewUrl}#t=0.5`} preload="metadata" muted playsInline />
              : <Music size={18} aria-hidden />}
        </span>
        <span className="ws-mrow__text">
          <span className="ws-mrow__name" title={item.name}>{item.name}</span>
          <span className="ws-mrow__meta">
            {ag ? <span className="ws-mrow__origin">{t("ws.library.agMusic.badge")} · {t(`ws.library.agMusic.type.${ag.type}`)}</span> : null}
            <span title={used}>{[ag?.artists?.join(", "), ag?.bpm ? `${ag.bpm} BPM` : null, sizeOf(item.bytes), used].filter(Boolean).join(" · ")}</span>
          </span>
          {cats.length ? (
            <span className="ws-mrow__tags">
              {cats.map((c) => (
                <span key={`${c.kind}:${c.name}`} className={`ws-mrow__tag ws-mrow__tag--${c.kind.toLowerCase()}`}
                  title={`${CATEGORY_ORDER.includes(c.kind) ? t(`ws.library.agMusic.group.${c.kind}`) : c.kind}: ${c.name}`}>{c.name}</span>
              ))}
            </span>
          ) : null}
        </span>
        {inProject ? <span className="ws-mrow__in">{t("ws.library.inProject")}</span> : null}
      </button>
      {item.kind === "audio" ? <audio className="ws-mrow__audio" src={item.previewUrl} controls preload="none" aria-label={item.name} onPlay={(e) => pauseOthers(e.currentTarget)} /> : null}
      <Popconfirm title={t("ws.library.deleteConfirm", { name: item.name })} okText={t("ws.library.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")} onConfirm={onDelete}>
        <button type="button" className="ws-icon-button ws-mrow__delete" aria-label={t("ws.library.deleteNamed", { name: item.name })} disabled={deleting}><Trash2 size={13} /></button>
      </Popconfirm>
    </li>
  );
}

/**
 * The person's own media library (plan 2026-10-29): what they uploaded in any project, to use here without uploading
 * again. Filtered to what `use` takes; footage goes into the videos ticked below (none: the project's own footage).
 * Items the project already uses are marked; an item a project uses cannot be deleted (it says where).
 */
export function MediaLibraryDrawer({ open, projectId, use, videos, currentVideoId, inProject, onClose }: {
  open: boolean; projectId: string; use: MediaUseKind; videos: VideoRef[]; currentVideoId?: string | undefined;
  /** Items of the library the project already uses this way. */
  inProject: Set<string>;
  onClose: () => void;
}) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const kinds = KINDS[use];
  const [kind, setKind] = useState<MediaKind | "all">("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const [agMusic, setAgMusic] = useState(false);
  const agMusicOn = useAgMusicEnabled(open && use === "audio");
  useEffect(() => {
    if (!open) return;
    setPicked([]); setQ(""); setKind("all");
    setTargets(currentVideoId ? [currentVideoId] : []);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useQuery({
    queryKey: ["media", kind === "all" ? kinds.join(",") : kind, q.trim()], enabled: open,
    queryFn: async () => {
      // one kind asked at a time; "all" of footage is videos and photos together
      const asks = kind === "all" ? kinds : [kind];
      const parts = await Promise.all(asks.map((k) => client.listMedia({ kind: k, ...(q.trim() ? { q: q.trim() } : {}), limit: LIMIT })));
      return parts.flatMap((p) => p.items).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  });
  const items = list.data ?? [];
  const fail = (fallback: string) => (e: unknown) => void message.error(e instanceof StudioHttpError ? e.message : fallback);
  const uploading = useUploadProgress();
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const progress = uploading.start(files);
      const out: MediaItem[] = [];
      for (const [i, f] of files.entries()) out.push(await client.uploadMedia(f, progress[i]));
      return out;
    },
    onSettled: uploading.done,
    onSuccess: (made) => { void qc.invalidateQueries({ queryKey: ["media"] }); setPicked((p) => [...new Set([...p, ...made.map((m) => m.id)])]); },
    onError: fail(t("ws.inputs.uploadFailed")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.deleteMedia(id),
    onSuccess: (_r, id) => { setPicked((p) => p.filter((x) => x !== id)); void qc.invalidateQueries({ queryKey: ["media"] }); },
    onError: fail(t("ws.library.deleteFailed")),
  });
  const add = useMutation({
    mutationFn: () => client.addFromMedia(projectId, { mediaIds: picked, use, ...(use === "footage" ? { videoIds: targets } : {}) }),
    onSuccess: () => {
      for (const k of ["sources", "jobs", "activity", "playbook", "audio", "files"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
      void qc.invalidateQueries({ queryKey: ["media"] });
      void message.success(t("ws.library.added", { count: picked.length }));
      onClose();
    },
    onError: fail(t("ws.library.addFailed")),
  });
  /** What "pick all" ticks: what is listed and not in the project yet. */
  const pickable = useMemo(() => items.filter((i) => !inProject.has(i.id)).map((i) => i.id), [items, inProject]);
  const allOn = pickable.length > 0 && pickable.every((id) => picked.includes(id));
  const pickedKinds = useMemo(() => {
    const by = new Map(items.map((i) => [i.id, i.kind]));
    return picked.map((id) => by.get(id)).filter(Boolean) as MediaKind[];
  }, [items, picked]);

  return (
    <Drawer open={open} onClose={onClose} width={880} destroyOnHidden rootClassName="ws-mlib"
      title={<span className="ws-mlib__title"><Library size={16} aria-hidden />{t("ws.library.title")}</span>}
      footer={(
        <div className="ws-mlib__foot">
          <strong>{t("ws.library.picked", { count: picked.length })}</strong>
          {pickedKinds.length ? <span className="ws-hint">{[...new Set(pickedKinds)].map((k) => t(`ws.library.kind.${k}`)).join(", ")}</span> : null}
          <span className="ws-sec__grow" />
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="primary" disabled={!picked.length} loading={add.isPending} onClick={() => add.mutate()}>{t("ws.library.add", { count: picked.length })}</Button>
        </div>
      )}>
      <div className="ws-mlib__tools">
        {kinds.length > 1 ? (
          <Segmented<MediaKind | "all"> value={kind} onChange={setKind} aria-label={t("ws.library.kindLabel")}
            options={[{ value: "all", label: t("ws.library.kind.all") }, ...kinds.map((k) => ({ value: k, label: t(`ws.library.kind.${k}`) }))]} />
        ) : null}
        <Input.Search allowClear placeholder={t("ws.library.search")} aria-label={t("ws.library.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button icon={<Upload size={14} />} loading={upload.isPending} onClick={() => input.current?.click()}>
          {uploading.percent !== null ? t("common.uploading", { pct: uploading.percent }) : t("ws.library.upload")}
        </Button>
        <input ref={input} type="file" multiple hidden accept={ACCEPT[use]} aria-label={t("ws.library.upload")}
          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) upload.mutate(files); }} />
        {use === "audio" && agMusicOn ? (
          <Button icon={<Music size={14} />} onClick={() => setAgMusic(true)}>{t("ws.library.agMusic.open")}</Button>
        ) : null}
      </div>
      <section className="ws-mlib__panel">
        <div className="ws-mlib__head">
          <Checkbox checked={allOn} indeterminate={!allOn && pickable.some((id) => picked.includes(id))} disabled={!pickable.length}
            onChange={(e) => setPicked((p) => (e.target.checked ? [...new Set([...p, ...pickable])] : p.filter((id) => !pickable.includes(id))))}>
            {t("ws.library.pickAll")}
          </Checkbox>
          <span className="ws-hint ws-mlib__for">{t(`ws.library.for.${use}`)}{list.data ? ` · ${t("ws.library.count", { count: items.length })}` : ""}</span>
        </div>
        {list.isLoading ? <div className="ws-center"><Spin /></div> : items.length ? (
          <ul className="ws-mlib__list" aria-label={t("ws.library.title")}>
            {items.map((i) => (
              <MediaRow key={i.id} item={i} selected={picked.includes(i.id)} inProject={inProject.has(i.id)} deleting={remove.isPending && remove.variables === i.id}
                onToggle={() => setPicked((p) => (p.includes(i.id) ? p.filter((x) => x !== i.id) : [...p, i.id]))} onDelete={() => remove.mutate(i.id)} />
            ))}
          </ul>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q.trim() ? t("ws.library.noMatch") : t("ws.library.empty")} />}
      </section>
      {use === "footage" ? (
        <div className="ws-mlib__panel ws-mlib__targets">
          <span className="ws-sub"><Plus size={12} aria-hidden /> {t("ws.library.intoVideos")}</span>
          <p className="ws-hint">{t("ws.library.intoVideosHint")}</p>
          <VideoChecklist videos={videos} value={targets} onChange={setTargets} currentVideoId={currentVideoId} label={t("ws.library.videosLabel")} />
        </div>
      ) : null}
      <AgMusicPicker open={agMusic} onClose={() => setAgMusic(false)}
        onFetched={(item) => { void qc.invalidateQueries({ queryKey: ["media"] }); setPicked((p) => (p.includes(item.id) ? p : [...p, item.id])); }} />
    </Drawer>
  );
}
