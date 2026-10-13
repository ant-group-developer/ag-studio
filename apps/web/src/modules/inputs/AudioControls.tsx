import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { App as AntApp, Button, Checkbox, Empty, Input, InputNumber, Modal, Radio, Spin, Tag, Tooltip } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, Library, ListMusic, Mic, Music, RotateCcw, Sparkles, Upload, VolumeX, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useStudioClient } from "../../api/studio-client";
import { useWorkspaceClient, type MusicFilesInput, type ProjectAudioFile, type ProjectAudioView, type VideoAudioView, type VoiceOrigin } from "../../api/workspace-client";
import { useUploadProgress } from "../common/upload-progress";
import { clock } from "../workspace/time";

const AUDIO_ACCEPT = ".mp3,.wav,.m4a,.aac,.ogg,.flac";
const MB = 1024 * 1024;
/** The largest audio file the API takes (`AUDIO_UPLOAD_MAX_BYTES`, a whole music track). */
const AUDIO_MAX_MB = 100;

/**
 * Why a file did not upload, naming it. A 413 without Studio's own answer comes from a proxy in front of the API
 * (its body limit is lower than Studio's), which only an admin can raise.
 */
function uploadError(t: TFunction, f: File, e: unknown): string {
  if (e instanceof StudioHttpError && e.status === 413 && !e.code) return t("ws.audio.proxyTooLarge", { name: f.name, mb: (f.size / MB).toFixed(1) });
  return `${f.name}: ${e instanceof StudioHttpError ? e.message : t("ws.audio.failed")}`;
}

/** The project's audio as the Inputs tab reads it (one query for the card and the buttons on audio rows). */
function useProjectAudio(projectId: string) {
  const client = useWorkspaceClient();
  return useQuery({ queryKey: ["audio", projectId], queryFn: () => client.getAudio(projectId) });
}

/** After a change: the card, the uploads list, the Files tab and the playbook (its audio step) follow. */
function useAudioDone(projectId: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of ["audio", "sources", "files", "playbook"]) void qc.invalidateQueries({ queryKey: [k, projectId] });
  };
}

function useFail() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  return (e: unknown) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.audio.failed"));
}

/** A button that, when it cannot be used, says why on hover (a missing role, no ffmpeg, no file yet). */
function AudioButton({ why, children, ...rest }: { why: string | null; children: ReactNode } & ComponentProps<typeof Button>) {
  const button = <Button size="small" {...rest} disabled={why !== null || rest.disabled}>{children}</Button>;
  return why ? <Tooltip title={why}><span className="ws-audio__disabled">{button}</span></Tooltip> : button;
}

/** Says where the voice sample comes from (synthetic, own, licensed) and what it says, then uses `path` as the voice. */
function VoiceOriginModal({ projectId, path, onClose }: { projectId: string; path: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const done = useAudioDone(projectId);
  const fail = useFail();
  const [origin, setOrigin] = useState<VoiceOrigin | null>(null);
  const [text, setText] = useState("");
  const use = useMutation({
    mutationFn: () => client.audioFromFile(projectId, "voice", { path: path!, origin: origin!, referenceText: text.trim() || null }),
    onSuccess: () => { done(); void message.success(t("ws.audio.voiceSet")); close(); },
    onError: fail,
  });
  const close = () => { setOrigin(null); setText(""); onClose(); };
  return (
    <Modal open={path !== null} title={t("ws.audio.voiceTitle")} okText={t("ws.audio.useAsVoice")} cancelText={t("common.cancel")} onCancel={close}
      okButtonProps={{ disabled: !origin }} confirmLoading={use.isPending} onOk={() => use.mutate()} destroyOnHidden>
      <p style={{ marginTop: 0 }}>{t("ws.audio.voiceLead")}</p>
      {path ? <p className="ws-hint">{path.split("/").pop()}</p> : null}
      <Radio.Group value={origin} onChange={(e) => setOrigin(e.target.value as VoiceOrigin)} aria-label={t("ws.audio.origin")}>
        {(["synthetic", "own", "licensed"] as const).map((o) => <Radio key={o} value={o}>{t(`ws.audio.origins.${o}`)}</Radio>)}
      </Radio.Group>
      <Input.TextArea style={{ marginTop: 12 }} value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} maxLength={500}
        placeholder={t("ws.audio.referenceText")} aria-label={t("ws.audio.referenceText")} />
    </Modal>
  );
}

/** The audio files of the project (uploaded, or put in context/audio through the Files tab) to pick one from. */
function AudioFileModal({ open, title, files, onPick, onClose, busy }: {
  open: boolean; title: string; files: ProjectAudioFile[]; onPick: (f: ProjectAudioFile) => void; onClose: () => void; busy: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={open} title={title} footer={null} onCancel={onClose} destroyOnHidden>
      {files.length ? (
        <ul className="ws-inputs__list ws-audio__files" aria-label={title}>
          {files.map((f) => (
            <li key={f.path} className="ws-inputs__row">
              <Music size={14} aria-hidden />
              <div className="ws-inputs__text">
                <span className="ws-inputs__name" title={f.path}>{f.name}</span>
                <span className="ws-hint">{(f.bytes / MB).toFixed(1)} MB · {f.path}</span>
              </div>
              <Button size="small" type="primary" loading={busy === f.path} onClick={() => onPick(f)} aria-label={t("ws.audio.pickNamed", { name: f.name })}>
                {t("ws.audio.pick")}
              </Button>
            </li>
          ))}
        </ul>
      ) : <Empty description={t("ws.audio.noFiles")} />}
    </Modal>
  );
}

/** The team's music library: listen, then pick a track as the music (`onPick`: the project's or a video's). */
function MusicLibraryModal({ open, current, onPick, onClose }: {
  open: boolean; current: string | null; onPick: (trackId: string) => Promise<unknown>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const studio = useStudioClient();
  const fail = useFail();
  const [q, setQ] = useState("");
  const library = useQuery({ queryKey: ["music-library"], queryFn: () => studio.listMusic(), enabled: open });
  const pick = useMutation({ mutationFn: onPick, onSuccess: onClose, onError: fail });
  const needle = q.trim().toLowerCase();
  const tracks = (library.data?.tracks ?? []).filter((x) => x.active)
    .filter((x) => !needle || x.displayName.toLowerCase().includes(needle) || x.moods.some((m) => m.toLowerCase().includes(needle)));
  return (
    <Modal open={open} title={t("ws.audio.libraryTitle")} footer={null} onCancel={onClose} width={640} destroyOnHidden>
      <Input.Search allowClear placeholder={t("ws.audio.librarySearch")} aria-label={t("ws.audio.librarySearch")} value={q} onChange={(e) => setQ(e.target.value)} />
      {library.isLoading ? <div className="ws-center"><Spin /></div> : library.isError ? (
        <p className="ws-error" role="alert">{t("ws.audio.libraryFailed")} <Button size="small" type="link" onClick={() => void library.refetch()}>{t("ws.audio.retry")}</Button></p>
      ) : tracks.length ? (
        <ul className="ws-inputs__list ws-audio__library" aria-label={t("ws.audio.libraryTitle")}>
          {tracks.map((x) => (
            <li key={x.trackId} className="ws-audio__track">
              <div className="ws-audio__trackhead">
                <div className="ws-inputs__text">
                  <span className="ws-inputs__name">{x.displayName}</span>
                  <span className="ws-hint">{clock(x.durationSeconds)}{x.loopOk ? ` · ${t("ws.audio.loops")}` : ""}</span>
                </div>
                {x.track === current ? <Tag color="green">{t("ws.audio.inUse")}</Tag> : (
                  <Button size="small" type="primary" loading={pick.isPending && pick.variables === x.trackId} onClick={() => pick.mutate(x.trackId)}
                    aria-label={t("ws.audio.pickNamed", { name: x.displayName })}>{t("ws.audio.pick")}</Button>
                )}
              </div>
              <div className="ws-audio__moods">{x.moods.map((m) => <Tag key={m}>{m}</Tag>)}</div>
              <audio controls preload="none" src={x.listenUrl} aria-label={t("ws.audio.listen", { name: x.displayName })} />
            </li>
          ))}
        </ul>
      ) : <Empty description={t("ws.audio.libraryEmpty")} />}
    </Modal>
  );
}

/** At most this many files are joined into one track (the API's `MUSIC_MIX_MAX_PARTS`). */
const MUSIC_MAX_PARTS = 20;

/**
 * Audio files to make the music of: tick one or several, put them in the order they play, and say how many seconds
 * each fades into the next (0: one right after the other). `initial`: ticked when it opens (files just uploaded).
 */
function MusicFilesModal({ open, files, initial, busy, onUse, onClose }: {
  open: boolean; files: ProjectAudioFile[]; initial: string[]; busy: boolean;
  onUse: (input: MusicFilesInput) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={open} title={t("ws.audio.pickMusicTitle")} footer={null} onCancel={onClose} width={640} destroyOnHidden>
      {files.length ? <MusicFilesForm files={files} initial={initial} busy={busy} onUse={onUse} /> : <Empty description={t("ws.audio.noFiles")} />}
    </Modal>
  );
}

function MusicFilesForm({ files, initial, busy, onUse }: { files: ProjectAudioFile[]; initial: string[]; busy: boolean; onUse: (input: MusicFilesInput) => void }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string[]>(initial.slice(0, MUSIC_MAX_PARTS));
  const [fade, setFade] = useState(2);
  const nameOf = (path: string) => files.find((f) => f.path === path)?.name ?? path.split("/").pop() ?? path;
  const toggle = (path: string, on: boolean) => setChosen((c) => (on ? [...c, path] : c.filter((p) => p !== path)));
  const move = (i: number, by: -1 | 1) => setChosen((c) => {
    const next = [...c];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    return next;
  });
  const several = chosen.length > 1;
  return (
    <div className="ws-audio__mix">
      <p className="ws-hint" style={{ marginTop: 0 }}>{t("ws.audio.pickHint", { max: MUSIC_MAX_PARTS })}</p>
      <ul className="ws-inputs__list ws-audio__files" aria-label={t("ws.audio.pickMusicTitle")}>
        {files.map((f) => {
          const on = chosen.includes(f.path);
          return (
            <li key={f.path} className="ws-inputs__row">
              <Checkbox checked={on} disabled={!on && chosen.length >= MUSIC_MAX_PARTS} onChange={(e) => toggle(f.path, e.target.checked)}
                aria-label={t("ws.audio.pickNamed", { name: f.name })} />
              <div className="ws-inputs__text">
                <span className="ws-inputs__name" title={f.path}>{f.name}</span>
                <span className="ws-hint">{(f.bytes / MB).toFixed(1)} MB · {f.path}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {several ? (
        <>
          <h5 className="ws-audio__h">{t("ws.audio.order")}</h5>
          <ol className="ws-audio__order" aria-label={t("ws.audio.order")}>
            {chosen.map((p, i) => (
              <li key={p}>
                <span className="ws-audio__ordername">{nameOf(p)}</span>
                <button type="button" className="ws-icon-button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("ws.audio.moveUp", { name: nameOf(p) })}><ArrowUp size={13} /></button>
                <button type="button" className="ws-icon-button" disabled={i === chosen.length - 1} onClick={() => move(i, 1)} aria-label={t("ws.audio.moveDown", { name: nameOf(p) })}><ArrowDown size={13} /></button>
                <button type="button" className="ws-icon-button" onClick={() => toggle(p, false)} aria-label={t("ws.audio.removeNamed", { name: nameOf(p) })}><X size={13} /></button>
              </li>
            ))}
          </ol>
          <label className="ws-audio__fade">
            {t("ws.audio.crossfade")}
            <InputNumber size="small" min={0} max={10} step={0.5} value={fade} onChange={(v) => setFade(typeof v === "number" ? v : 0)} aria-label={t("ws.audio.crossfade")} />
            <span className="ws-hint">{t("ws.audio.crossfadeHint")}</span>
          </label>
        </>
      ) : null}
      <div className="ws-audio__mixfoot">
        <Button type="primary" disabled={!chosen.length} loading={busy} onClick={() => onUse({ paths: chosen, ...(several ? { crossfadeS: fade } : {}) })}>
          {several ? t("ws.audio.joinMusic", { count: chosen.length }) : t("ws.audio.useOneAsMusic")}
        </Button>
      </div>
    </div>
  );
}

/** Uploads audio files one by one into the project (none over 100 MB), saying how far it is; answers what went and why the rest did not. */
function useAudioUpload(projectId: string) {
  const { t } = useTranslation();
  const client = useWorkspaceClient();
  const uploading = useUploadProgress();
  const run = async (files: File[]): Promise<{ paths: string[]; failed: string[] }> => {
    const paths: string[] = [];
    const failed: string[] = [];
    const fits = files.filter((f) => f.size <= AUDIO_MAX_MB * MB);
    const progress = uploading.start(fits);
    try {
      for (const f of files) {
        if (f.size > AUDIO_MAX_MB * MB) { failed.push(t("ws.audio.tooLarge", { name: f.name, mb: AUDIO_MAX_MB })); continue; }
        try {
          paths.push((await client.uploadSource(projectId, f, undefined, { onProgress: progress[fits.indexOf(f)] })).source.ref);
        } catch (e) {
          failed.push(uploadError(t, f, e));
        }
      }
    } finally {
      uploading.done();
    }
    return { paths, failed };
  };
  return { run, percent: uploading.percent };
}

/** Where music goes: the project's or a video's. */
interface MusicTarget {
  fromFiles: (input: MusicFilesInput) => Promise<unknown>;
  fromLibrary: (trackId: string) => Promise<unknown>;
  /** After a change (with what the change answered): what reads it follows, and the person is told. */
  changed: (result: unknown) => void;
}

/**
 * The ways to choose music: upload one file (used at once) or several (then ticked and ordered), pick files already
 * uploaded (one, or several joined), pick a library track. `extra`: the way back (Studio's pick, the project's music).
 */
function MusicActions({ projectId, target, files, enabled, canEdit, current, extra }: {
  projectId: string; target: MusicTarget; files: ProjectAudioFile[]; enabled: boolean; canEdit: boolean; current: string | null; extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const done = useAudioDone(projectId);
  const fail = useFail();
  const input = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState<string[] | null>(null);
  const [library, setLibrary] = useState(false);
  const audioUpload = useAudioUpload(projectId);
  const use = useMutation({
    mutationFn: target.fromFiles,
    onSuccess: (r) => { setPicking(null); target.changed(r); },
    onError: fail,
  });
  const upload = useMutation({
    mutationFn: async (list: File[]) => {
      const r = await audioUpload.run(list);
      const used = list.length === 1 && r.paths.length === 1 ? await target.fromFiles({ paths: r.paths }) : null;
      return { ...r, used, several: list.length > 1 };
    },
    onSuccess: (r) => {
      done();
      for (const f of r.failed) void message.error(f);
      if (!r.paths.length) return;
      if (r.several) { void message.success(t("ws.audio.uploaded", { count: r.paths.length })); setPicking(r.paths); }
      else target.changed(r.used);
    },
    onError: (e) => { done(); fail(e); },
  });
  const role = canEdit ? null : t("ws.audio.whyEditor");
  const noFfmpeg = enabled ? null : t("ws.audio.whyNoFfmpeg");
  const noFiles = files.length ? null : t("ws.audio.whyNoFiles");
  return (
    <div className="ws-audio__actions">
      <AudioButton why={role ?? noFfmpeg} icon={<Upload size={12} />} loading={upload.isPending} onClick={() => input.current?.click()}>
        {upload.isPending && audioUpload.percent !== null ? t("common.uploading", { pct: audioUpload.percent }) : t("ws.audio.uploadMusic")}
      </AudioButton>
      <AudioButton why={role} icon={<Library size={12} />} onClick={() => setLibrary(true)}>{t("ws.audio.fromLibrary")}</AudioButton>
      <AudioButton why={role ?? noFfmpeg ?? noFiles} icon={<ListMusic size={12} />} onClick={() => setPicking([])}>{t("ws.audio.pickUploaded")}</AudioButton>
      {extra}
      <input ref={input} type="file" multiple hidden accept={AUDIO_ACCEPT} aria-label={t("ws.audio.uploadMusic")}
        onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ""; if (list.length) upload.mutate(list); }} />
      <MusicFilesModal open={picking !== null} files={files} initial={picking ?? []} busy={use.isPending} onUse={(i) => use.mutate(i)} onClose={() => setPicking(null)} />
      <MusicLibraryModal open={library} current={current} onClose={() => setLibrary(false)}
        onPick={async (trackId) => target.changed(await target.fromLibrary(trackId))} />
    </div>
  );
}
function voiceStatus(t: TFunction, v: Record<string, unknown> | null): string {
  if (!v) return t("ws.audio.voiceNone");
  const mode = typeof v.mode === "string" ? v.mode : "clone";
  if (mode === "none") return t("ws.audio.voiceDeclined");
  if (mode === "designing") return t("ws.audio.voiceDesigning");
  const origin = typeof v.origin === "string" ? t(`ws.audio.origins.${v.origin}`) : null;
  const source = v.source as { kind?: string; filename?: string } | undefined;
  const parts = [
    source?.filename ?? null,
    typeof v.duration_s === "number" ? clock(v.duration_s) : null,
    origin,
  ].filter(Boolean);
  return t("ws.audio.voiceClone", { detail: parts.join(" · ") });
}

/** The music chosen in words: Studio's pick by mood, a library track, files joined, or one file. */
export function musicStatus(t: TFunction, m: Record<string, unknown> | null, libraryTrack: ProjectAudioView["libraryTrack"]): string {
  if (!m) return t("ws.audio.musicAuto");
  if (libraryTrack) return t("ws.audio.musicLibrary", { name: libraryTrack.displayName, time: clock(libraryTrack.durationSeconds) });
  const time = typeof m.duration_s === "number" ? clock(m.duration_s) : "";
  if (Array.isArray(m.parts)) {
    const fade = typeof m.crossfade_s === "number" && m.crossfade_s > 0 ? t("ws.audio.fadeSeconds", { s: m.crossfade_s }) : t("ws.audio.buttJoin");
    return t("ws.audio.musicJoined", { count: m.parts.length, time, fade });
  }
  const source = m.source as { filename?: string } | undefined;
  return t("ws.audio.musicOwn", { detail: [source?.filename ?? null, time || null].filter(Boolean).join(" · ") });
}
/**
 * The project's narration voice and background music, first in the Inputs tab: what is chosen, and every way to
 * choose — upload a sample or tracks (several tracks are joined into one), pick files already uploaded, pick a library
 * track (listening first), no narration, or let Studio pick music by the branding's mood. A producer picks the voice
 * (saying where it comes from); music, an editor. Never from the footage library. Buttons a person cannot use say why.
 */
export function AudioCard({ projectId, canEdit, canProduce }: { projectId: string; canEdit: boolean; canProduce: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const audio = useProjectAudio(projectId);
  const done = useAudioDone(projectId);
  const fail = useFail();
  const voiceInput = useRef<HTMLInputElement>(null);
  const [voicePath, setVoicePath] = useState<string | null>(null);
  const [pickingVoice, setPickingVoice] = useState(false);

  // one sample is used at once (it asks where the voice comes from); several are uploaded one by one, then one is picked
  const voiceUpload = useAudioUpload(projectId);
  const uploadVoice = useMutation({
    mutationFn: voiceUpload.run,
    onSuccess: ({ paths, failed }, files) => {
      done();
      for (const f of failed) void message.error(f);
      if (!paths.length) return;
      if (files.length > 1) { void message.success(t("ws.audio.uploaded", { count: paths.length })); setPickingVoice(true); }
      else setVoicePath(paths[0]!);
    },
    onError: (e) => { done(); fail(e); },
  });
  const decline = useMutation({ mutationFn: () => client.declineVoice(projectId), onSuccess: done, onError: fail });
  const clear = useMutation({ mutationFn: (kind: "voice" | "music") => client.clearAudio(projectId, kind), onSuccess: done, onError: fail });
  const music: MusicTarget = {
    fromFiles: (i) => (i.paths.length === 1 ? client.audioFromFile(projectId, "music", { path: i.paths[0]! }) : client.musicFromFiles(projectId, i)),
    fromLibrary: (trackId) => client.musicFromLibrary(projectId, trackId),
    changed: () => { done(); void message.success(t("ws.audio.musicSet")); },
  };

  if (audio.isLoading) {
    return <section className="ws-audio" aria-label={t("ws.audio.title")} aria-busy="true"><Spin size="small" /> <span className="ws-hint">{t("ws.audio.loading")}</span></section>;
  }
  if (audio.isError || !audio.data) {
    return (
      <section className="ws-audio" aria-label={t("ws.audio.title")}>
        <p className="ws-error ws-audio__error" role="alert">
          <AlertTriangle size={14} aria-hidden /> {t("ws.audio.loadFailed")}
          {audio.error instanceof StudioHttpError ? `: ${audio.error.message}` : ""}
        </p>
        <Button size="small" icon={<RotateCcw size={12} />} onClick={() => void audio.refetch()}>{t("ws.audio.retry")}</Button>
      </section>
    );
  }
  const a = audio.data;
  const voiceMode = a.voice ? (typeof a.voice.mode === "string" ? a.voice.mode : "clone") : null;
  const noFfmpeg = a.enabled ? null : t("ws.audio.whyNoFfmpeg");
  const noFiles = a.files.length ? null : t("ws.audio.whyNoFiles");
  const voiceRole = canProduce ? null : t("ws.audio.whyProducer");
  const musicRole = canEdit ? null : t("ws.audio.whyEditor");

  return (
    <section className="ws-audio" aria-label={t("ws.audio.title")}>
      {!a.enabled ? (
        <p className="ws-audio__warn" role="status"><AlertTriangle size={14} aria-hidden /> {t("ws.audio.disabled")}</p>
      ) : null}
      <div className="ws-audio__row" role="group" aria-label={t("ws.audio.voice")}>
        <Mic size={15} aria-hidden className="ws-audio__icon" />
        <div className="ws-audio__body">
          <div className="ws-audio__line"><strong>{t("ws.audio.voice")}</strong><span className="ws-audio__status">{voiceStatus(t, a.voice)}</span></div>
          <div className="ws-audio__actions">
            <AudioButton why={voiceRole ?? noFfmpeg} icon={<Upload size={12} />} loading={uploadVoice.isPending} onClick={() => voiceInput.current?.click()}>
              {uploadVoice.isPending && voiceUpload.percent !== null ? t("common.uploading", { pct: voiceUpload.percent }) : t("ws.audio.uploadVoice")}
            </AudioButton>
            <AudioButton why={voiceRole ?? noFfmpeg ?? noFiles} icon={<ListMusic size={12} />} onClick={() => setPickingVoice(true)}>{t("ws.audio.pickUploaded")}</AudioButton>
            {voiceMode !== "none" ? (
              <AudioButton why={voiceRole} icon={<VolumeX size={12} />} loading={decline.isPending} onClick={() => decline.mutate()}>{t("ws.audio.noNarration")}</AudioButton>
            ) : null}
            {voiceMode ? (
              <AudioButton why={voiceRole} icon={<X size={12} />} loading={clear.isPending && clear.variables === "voice"} onClick={() => clear.mutate("voice")}>{t("ws.audio.clear")}</AudioButton>
            ) : null}
          </div>
        </div>
      </div>
      <div className="ws-audio__row" role="group" aria-label={t("ws.audio.music")}>
        <Music size={15} aria-hidden className="ws-audio__icon" />
        <div className="ws-audio__body">
          <div className="ws-audio__line"><strong>{t("ws.audio.music")}</strong><span className="ws-audio__status">{musicStatus(t, a.music, a.libraryTrack)}</span></div>
          <MusicActions projectId={projectId} target={music} files={a.files} enabled={a.enabled} canEdit={canEdit}
            current={typeof a.music?.track === "string" ? a.music.track : null}
            extra={a.music ? (
              <Tooltip title={t("ws.audio.autoHint")}>
                <span className="ws-audio__disabled">
                  <Button size="small" icon={<Sparkles size={12} />} disabled={musicRole !== null} loading={clear.isPending && clear.variables === "music"} onClick={() => clear.mutate("music")}>
                    {t("ws.audio.auto")}
                  </Button>
                </span>
              </Tooltip>
            ) : null} />
          {!a.music ? <p className="ws-hint ws-audio__note">{t("ws.audio.autoHint")}</p> : null}
        </div>
      </div>
      <input ref={voiceInput} type="file" multiple hidden accept={AUDIO_ACCEPT} aria-label={t("ws.audio.uploadVoice")}
        onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ""; if (list.length) uploadVoice.mutate(list); }} />
      <AudioFileModal open={pickingVoice} files={a.files} onClose={() => setPickingVoice(false)} title={t("ws.audio.pickVoiceTitle")} busy={null}
        onPick={(f) => { setPickingVoice(false); setVoicePath(f.path); }} />
      <VoiceOriginModal projectId={projectId} path={voicePath} onClose={() => setVoicePath(null)} />
    </section>
  );
}

/**
 * A video's own music, in place of the project's for this video only: what it plays now (its own, the project's, or
 * Studio's pick by mood), the same ways to choose as the project's, and back to the project's music. Its latest
 * timeline takes a change at once (a new revision), so the next preview plays it.
 */
export function VideoMusicCard({ projectId, videoId, canEdit }: { projectId: string; videoId: string; canEdit: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const project = useProjectAudio(projectId);
  const video = useQuery({ queryKey: ["video-audio", videoId], queryFn: () => client.getVideoAudio(videoId) });
  const fail = useFail();
  const changed = (r: unknown) => {
    for (const k of [["video-audio", videoId], ["timeline", videoId], ["renders", videoId]]) void qc.invalidateQueries({ queryKey: k });
    const revision = (r as VideoAudioView | null)?.revision ?? null;
    void message.success(revision ? t("ws.audio.videoMusicSetTimeline", { revision }) : t("ws.audio.videoMusicSet"));
  };
  const target: MusicTarget = {
    fromFiles: (i) => client.videoMusicFromFiles(videoId, i),
    fromLibrary: (trackId) => client.videoMusicFromLibrary(videoId, trackId),
    changed,
  };
  const back = useMutation({ mutationFn: () => client.clearVideoMusic(videoId), onSuccess: changed, onError: fail });

  if (video.isLoading) {
    return <section className="ws-audio" aria-label={t("ws.audio.videoMusic")} aria-busy="true"><Spin size="small" /> <span className="ws-hint">{t("ws.audio.loading")}</span></section>;
  }
  if (video.isError || !video.data) {
    return (
      <section className="ws-audio" aria-label={t("ws.audio.videoMusic")}>
        <p className="ws-error ws-audio__error" role="alert"><AlertTriangle size={14} aria-hidden /> {t("ws.audio.loadFailed")}</p>
        <Button size="small" icon={<RotateCcw size={12} />} onClick={() => void video.refetch()}>{t("ws.audio.retry")}</Button>
      </section>
    );
  }
  const v = video.data;
  const p = project.data;
  const status = v.uses === "video"
    ? t("ws.audio.videoOwn", { status: musicStatus(t, v.music, v.libraryTrack) })
    : t("ws.audio.videoUsesProject", { status: p ? musicStatus(t, p.music, p.libraryTrack) : "…" });
  return (
    <section className="ws-audio" aria-label={t("ws.audio.videoMusic")}>
      <div className="ws-audio__row" role="group" aria-label={t("ws.audio.videoMusic")}>
        <Music size={15} aria-hidden className="ws-audio__icon" />
        <div className="ws-audio__body">
          <div className="ws-audio__line"><strong>{t("ws.audio.videoMusic")}</strong><span className="ws-audio__status">{status}</span></div>
          <MusicActions projectId={projectId} target={target} files={v.files} enabled={v.enabled} canEdit={canEdit}
            current={v.uses === "video" && typeof v.music?.track === "string" ? v.music.track : null}
            extra={v.uses === "video" ? (
              <AudioButton why={canEdit ? null : t("ws.audio.whyEditor")} icon={<RotateCcw size={12} />} loading={back.isPending} onClick={() => back.mutate()}>
                {t("ws.audio.useProjectMusic")}
              </AudioButton>
            ) : null} />
          <p className="ws-hint ws-audio__note">{t("ws.audio.videoMusicHint")}</p>
        </div>
      </div>
    </section>
  );
}

/** Buttons on an uploaded audio file: use it as the voice sample (producer) or the music (editor). */
export function UseAudioButtons({ projectId, path, canEdit, canProduce }: { projectId: string; path: string; canEdit: boolean; canProduce: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const audio = useProjectAudio(projectId);
  const done = useAudioDone(projectId);
  const fail = useFail();
  const [voicePath, setVoicePath] = useState<string | null>(null);
  const music = useMutation({
    mutationFn: () => client.audioFromFile(projectId, "music", { path }),
    onSuccess: () => { done(); void message.success(t("ws.audio.musicSet")); },
    onError: fail,
  });
  const noFfmpeg = audio.data && !audio.data.enabled ? t("ws.audio.whyNoFfmpeg") : null;
  return (
    <>
      {canProduce ? <AudioButton why={noFfmpeg} icon={<Mic size={12} />} onClick={() => setVoicePath(path)}>{t("ws.audio.useAsVoice")}</AudioButton> : null}
      {canEdit ? <AudioButton why={noFfmpeg} icon={<Music size={12} />} loading={music.isPending} onClick={() => music.mutate()}>{t("ws.audio.useAsMusic")}</AudioButton> : null}
      <VoiceOriginModal projectId={projectId} path={voicePath} onClose={() => setVoicePath(null)} />
    </>
  );
}
