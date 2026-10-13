import { useRef, useState, type ChangeEvent, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { TFunction } from "i18next";
import { App as AntApp, Button, Empty, Input, Modal, Radio, Spin, Tag, Tooltip } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Library, ListMusic, Mic, Music, RotateCcw, Sparkles, Upload, VolumeX, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useStudioClient } from "../../api/studio-client";
import { useWorkspaceClient, type ProjectAudioFile, type ProjectAudioView, type VoiceOrigin } from "../../api/workspace-client";
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

/** The team's music library: listen, then pick a track as the project's music. */
function MusicLibraryModal({ projectId, open, current, onClose }: { projectId: string; open: boolean; current: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const studio = useStudioClient();
  const client = useWorkspaceClient();
  const done = useAudioDone(projectId);
  const fail = useFail();
  const [q, setQ] = useState("");
  const library = useQuery({ queryKey: ["music-library"], queryFn: () => studio.listMusic(), enabled: open });
  const pick = useMutation({
    mutationFn: (trackId: string) => client.musicFromLibrary(projectId, trackId),
    onSuccess: () => { done(); void message.success(t("ws.audio.musicSet")); onClose(); },
    onError: fail,
  });
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

function musicStatus(t: TFunction, a: ProjectAudioView): string {
  const m = a.music;
  if (!m) return t("ws.audio.musicAuto");
  if (a.libraryTrack) return t("ws.audio.musicLibrary", { name: a.libraryTrack.displayName, time: clock(a.libraryTrack.durationSeconds) });
  const source = m.source as { filename?: string } | undefined;
  const parts = [source?.filename ?? null, typeof m.duration_s === "number" ? clock(m.duration_s) : null].filter(Boolean);
  return t("ws.audio.musicOwn", { detail: parts.join(" · ") });
}

/**
 * The project's narration voice and background music, first in the Inputs tab: what is chosen, and every way to
 * choose — upload a sample or a track and use it at once, pick a file already uploaded, pick a library track
 * (listening first), no narration, or let Studio pick music by the branding's mood. A producer picks the voice (saying
 * where it comes from); music, an editor. Never from the footage library. Buttons a person cannot use say why.
 */
export function AudioCard({ projectId, canEdit, canProduce }: { projectId: string; canEdit: boolean; canProduce: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const audio = useProjectAudio(projectId);
  const done = useAudioDone(projectId);
  const fail = useFail();
  const voiceInput = useRef<HTMLInputElement>(null);
  const musicInput = useRef<HTMLInputElement>(null);
  const [voicePath, setVoicePath] = useState<string | null>(null);
  const [picking, setPicking] = useState<"voice" | "music" | null>(null);
  const [library, setLibrary] = useState(false);

  // one file is used at once (the voice asks where it comes from); several are uploaded one by one, then one is picked
  const upload = useMutation({
    mutationFn: async ({ kind, files }: { kind: "voice" | "music"; files: File[] }) => {
      const paths: string[] = [];
      const failed: string[] = [];
      for (const f of files) {
        if (f.size > AUDIO_MAX_MB * MB) { failed.push(t("ws.audio.tooLarge", { name: f.name, mb: AUDIO_MAX_MB })); continue; }
        try {
          paths.push((await client.uploadSource(projectId, f)).source.ref);
        } catch (e) {
          failed.push(uploadError(t, f, e));
        }
      }
      if (kind === "music" && files.length === 1 && paths.length === 1) await client.audioFromFile(projectId, "music", { path: paths[0]! });
      return { kind, paths, failed, several: files.length > 1 };
    },
    onSuccess: ({ kind, paths, failed, several }) => {
      done();
      for (const f of failed) void message.error(f);
      if (!paths.length) return;
      if (several) { void message.success(t("ws.audio.uploaded", { count: paths.length })); setPicking(kind); }
      else if (kind === "voice") setVoicePath(paths[0]!);
      else void message.success(t("ws.audio.musicSet"));
    },
    onError: (e) => { done(); fail(e); },
  });
  const musicFromFile = useMutation({
    mutationFn: (path: string) => client.audioFromFile(projectId, "music", { path }),
    onSuccess: () => { done(); setPicking(null); void message.success(t("ws.audio.musicSet")); },
    onError: fail,
  });
  const decline = useMutation({ mutationFn: () => client.declineVoice(projectId), onSuccess: done, onError: fail });
  const clear = useMutation({ mutationFn: (kind: "voice" | "music") => client.clearAudio(projectId, kind), onSuccess: done, onError: fail });

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
  const pickFile = (input: RefObject<HTMLInputElement | null>) => () => input.current?.click();
  const onFiles = (kind: "voice" | "music") => (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length) upload.mutate({ kind, files });
  };
  const uploading = (kind: "voice" | "music") => upload.isPending && upload.variables?.kind === kind;

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
            <AudioButton why={voiceRole ?? noFfmpeg} icon={<Upload size={12} />} loading={uploading("voice")} onClick={pickFile(voiceInput)}>{t("ws.audio.uploadVoice")}</AudioButton>
            <AudioButton why={voiceRole ?? noFfmpeg ?? noFiles} icon={<ListMusic size={12} />} onClick={() => setPicking("voice")}>{t("ws.audio.pickUploaded")}</AudioButton>
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
          <div className="ws-audio__line"><strong>{t("ws.audio.music")}</strong><span className="ws-audio__status">{musicStatus(t, a)}</span></div>
          <div className="ws-audio__actions">
            <AudioButton why={musicRole ?? noFfmpeg} icon={<Upload size={12} />} loading={uploading("music")} onClick={pickFile(musicInput)}>{t("ws.audio.uploadMusic")}</AudioButton>
            <AudioButton why={musicRole} icon={<Library size={12} />} onClick={() => setLibrary(true)}>{t("ws.audio.fromLibrary")}</AudioButton>
            <AudioButton why={musicRole ?? noFfmpeg ?? noFiles} icon={<ListMusic size={12} />} onClick={() => setPicking("music")}>{t("ws.audio.pickUploaded")}</AudioButton>
            {a.music ? (
              <Tooltip title={t("ws.audio.autoHint")}>
                <span className="ws-audio__disabled">
                  <Button size="small" icon={<Sparkles size={12} />} disabled={musicRole !== null} loading={clear.isPending && clear.variables === "music"} onClick={() => clear.mutate("music")}>
                    {t("ws.audio.auto")}
                  </Button>
                </span>
              </Tooltip>
            ) : null}
          </div>
          {!a.music ? <p className="ws-hint ws-audio__note">{t("ws.audio.autoHint")}</p> : null}
        </div>
      </div>
      <input ref={voiceInput} type="file" multiple hidden accept={AUDIO_ACCEPT} aria-label={t("ws.audio.uploadVoice")} onChange={onFiles("voice")} />
      <input ref={musicInput} type="file" multiple hidden accept={AUDIO_ACCEPT} aria-label={t("ws.audio.uploadMusic")} onChange={onFiles("music")} />
      <AudioFileModal open={picking !== null} files={a.files} onClose={() => setPicking(null)}
        title={picking === "voice" ? t("ws.audio.pickVoiceTitle") : t("ws.audio.pickMusicTitle")}
        busy={musicFromFile.isPending ? musicFromFile.variables ?? null : null}
        onPick={(f) => { if (picking === "voice") { setPicking(null); setVoicePath(f.path); } else musicFromFile.mutate(f.path); }} />
      <VoiceOriginModal projectId={projectId} path={voicePath} onClose={() => setVoicePath(null)} />
      <MusicLibraryModal projectId={projectId} open={library} current={typeof a.music?.track === "string" ? a.music.track : null} onClose={() => setLibrary(false)} />
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
