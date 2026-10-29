import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { App as AntApp, Button, ColorPicker, Modal, Popconfirm, Segmented, Select, Spin, Switch } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Clapperboard, CopyCheck, FileText, Film, Layers, Library, Link2, Plus, Scissors, Sparkles, Trash2, Type, Upload } from "lucide-react";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type LookSource, type OwnLook, type ProjectLookView, type TextLook, type VideoLook, type VideoLookView } from "../../api/workspace-client";
import { AddMenu, SectionCard } from "../common/SectionCard";
import { MediaLibraryDrawer } from "../inputs/media-library";
import { useAiTranslation } from "../common/assistant-name";
import { useThumbnailUrl } from "../inputs/ag-go-projects/ProjectGridView";
import { REFERENCE_ACCEPT, useMediaUpload } from "../inputs/media-upload";
import "./style.css";

/** Studio's own look for the words when neither the video, its plan nor the branding says (white, black outline, m). */
const STUDIO_TEXT: TextLook = { text_color: "#FFFFFF", outline_color: "#000000", box_color: null, size: "m" };
const PREVIEW_PX = { s: 20, m: 26, l: 34 } as const;
const STYLE_FILE = "channel/style.md";
const BRANDING_FILE = "channel/branding.md";
/**
 * The picture looks as the browser can show them: close to the render's ffmpeg grades (`lookFilter` of @harness/core),
 * mild on purpose like them. A preview, not the render.
 */
const LOOK_CSS: Record<VideoLook, string> = {
  none: "none",
  natural: "contrast(1.04) saturate(1.1) brightness(1.01)",
  vivid: "contrast(1.1) saturate(1.35)",
  warm: "sepia(0.14) saturate(1.12) hue-rotate(-6deg)",
  cinematic: "contrast(1.1) saturate(0.86) brightness(0.97) hue-rotate(-4deg)",
};

/**
 * The font the preview draws: the render machines' fonts are Google Fonts (OFL), Arial is the computer's. Until the
 * new one has loaded the preview keeps the last, so changing the font never flashes a fallback.
 */
function useLoadedFont(font: string): string {
  const [shown, setShown] = useState(font);
  useEffect(() => {
    if (font === "Arial" || typeof document === "undefined") { setShown(font); return; }
    const id = `studio-font-${font.replace(/\s+/g, "-")}`;
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, "+")}&display=block`;
      document.head.appendChild(link);
    }
    let alive = true;
    const ready = () => { if (alive) setShown(font); };
    // the stylesheet first, then the face itself; a font that cannot load still shows (in the fallback) after a while
    const wait = setTimeout(ready, 2500);
    const tryLoad = (n: number) => {
      if (!document.fonts?.load) return ready();
      void document.fonts.load(`20px "${font}"`).then((faces) => (faces.length || n > 10 ? ready() : setTimeout(() => tryLoad(n + 1), 150)), ready);
    };
    tryLoad(0);
    return () => { alive = false; clearTimeout(wait); };
  }, [font]);
  return shown;
}

const hex = (c: { toHexString: () => string }) => c.toHexString().slice(0, 7).toUpperCase();

/** A frame of the footage (the video's first ag-go video's thumbnail, or the project's on the project page), else a plain scene. */
function useFrameUrl(projectId: string, videoId: string | null): string | undefined {
  const client = useWorkspaceClient();
  const { data } = useQuery({ queryKey: ["sources", projectId, videoId], queryFn: () => client.listSources(projectId, videoId ?? undefined) });
  const asset = data?.sources.find((s) => s.kind === "ag_go_asset" && (!videoId || s.videoId === videoId))?.ref;
  return useThumbnailUrl(asset);
}

function Frame({ url, look, className, children }: { url?: string | undefined; look: VideoLook; className?: string; children?: ReactNode }) {
  return (
    <div className={`ws-style__frame${className ? ` ${className}` : ""}`}>
      <div className="ws-style__picture" style={{ filter: LOOK_CSS[look], ...(url ? { backgroundImage: `url("${url}")` } : {}) }} aria-hidden />
      {children}
    </div>
  );
}

/** The video's words as they will look on a frame: font, size, colours, outline, box, shadow, over the picture's look. */
function TextPreview({ look, picture, url, text }: { look: TextLook; picture: VideoLook; url?: string | undefined; text: string }) {
  const font = useLoadedFont(look.font ?? "Arial");
  const o = look.outline_color;
  const shadows = [`1px 1px 0 ${o}`, `-1px -1px 0 ${o}`, `1px -1px 0 ${o}`, `-1px 1px 0 ${o}`, `0 0 2px ${o}`, ...(look.shadow ? ["0 3px 10px rgba(0,0,0,0.65)"] : [])];
  const style: CSSProperties = {
    fontFamily: `"${font}", Arial, sans-serif`, fontSize: PREVIEW_PX[look.size], color: look.text_color, textShadow: shadows.join(", "),
    ...(look.box_color ? { background: look.box_color, padding: "4px 12px", borderRadius: 4 } : {}),
  };
  return <Frame url={url} look={picture} className="ws-style__frame--big"><span className="ws-style__words" style={style}>{text}</span></Frame>;
}

const NO_LOOK: OwnLook = { text_look: null, look: null, color_match: null };
const hasOwn = (l: OwnLook | undefined) => !!l && (l.text_look !== null || l.look !== null || l.color_match !== null);

/** Where each part of the look comes from, for the form: picked (video or project), else the plan's, the branding's, Studio's. */
interface LookState {
  own: OwnLook;
  effective: { text_look: TextLook | null; look: VideoLook; color_match: boolean; from: { text_look: LookSource; look: LookSource; color_match: LookSource } };
  choices: VideoLookView["choices"];
}

/** The project page's look: its own pick over the branding's (each edit plan may still say more, per video). */
function projectState(v: ProjectLookView): LookState {
  const pick = <T,>(own: T | null, channel: T | null): { value: T | null; from: LookSource } =>
    (own !== null ? { value: own, from: "project" } : channel !== null ? { value: channel, from: "channel" } : { value: null, from: "default" });
  const text = pick(v.own.text_look, v.channel.text_look);
  const look = pick(v.own.look, v.channel.look);
  const match = pick(v.own.color_match, v.channel.color_match);
  return {
    own: v.own, choices: v.choices,
    effective: { text_look: text.value, look: look.value ?? "none", color_match: match.value ?? false, from: { text_look: text.from, look: look.from, color_match: match.from } },
  };
}

/** "Apply to all videos?": which videos follow the project and whose own style is replaced, then it goes. */
function ApplyAllModal({ open, project, busy, onOk, onCancel }: {
  open: boolean; project: ProjectLookView | undefined; busy: boolean; onOk: () => void; onCancel: () => void;
}) {
  const { t } = useAiTranslation();
  const videos = [...(project?.videos ?? [])].sort((a, b) => a.idx - b.idx);
  return (
    <Modal open={open} title={t("ws.style.applyAllTitle")} okText={t("ws.style.applyAllOk", { count: videos.length })} cancelText={t("common.cancel")}
      confirmLoading={busy} onOk={onOk} onCancel={onCancel} destroyOnHidden>
      <p style={{ marginTop: 0 }}>{t("ws.style.applyAllBody")}</p>
      <ul className="ws-style__applylist">
        {videos.map((v) => (
          <li key={v.id} className={v.ownLook ? "ws-style__applyown" : undefined}>
            {v.ownLook ? <AlertTriangle size={13} aria-hidden /> : <Check size={13} aria-hidden />}
            <span className="ws-style__applyname">#{v.idx} {v.title}</span>
            <span className="ws-hint">{t(v.ownLook ? "ws.style.applyAllReplaces" : "ws.style.applyAllFollows")}</span>
          </li>
        ))}
      </ul>
      <p className="ws-hint">{t("ws.style.applyAllNote")}</p>
    </Modal>
  );
}

/**
 * The words and picture form (plan 2026-10-28 P3, project scope plan 2026-10-29): in a video, that video's pick over
 * the project's (a bar says which it follows; "Apply to all videos" makes it the project's and clears every video's
 * own); on the project page, the project's pick for every video without its own.
 */
function LookForm({ projectId, video, canEdit }: { projectId: string; video?: { id: string; idx: number; title: string } | undefined; canEdit: boolean }) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const frame = useFrameUrl(projectId, video?.id ?? null);
  const videoLook = useQuery({ queryKey: ["videoLook", video?.id], queryFn: () => client.getVideoLook(video!.id), enabled: !!video });
  const projectLook = useQuery({ queryKey: ["projectLook", projectId], queryFn: () => client.getProjectLook(projectId) });
  const data: LookState | undefined = video ? videoLook.data : projectLook.data ? projectState(projectLook.data) : undefined;
  const [text, setText] = useState<TextLook>(STUDIO_TEXT);
  const [look, setLook] = useState<VideoLook>("none");
  const [match, setMatch] = useState(false);
  const [dirty, setDirty] = useState({ text: false, look: false, match: false });
  const [applying, setApplying] = useState(false);
  const reset = (v: LookState) => {
    setText(v.effective.text_look ?? STUDIO_TEXT);
    setLook(v.effective.look);
    setMatch(v.effective.color_match);
    setDirty({ text: false, look: false, match: false });
  };
  useEffect(() => { if (data) reset(data); }, [videoLook.data, projectLook.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const fail = (e: unknown) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.style.saveFailed"));
  const timelinesChanged = () => { void qc.invalidateQueries({ queryKey: ["videoLook"] }); void qc.invalidateQueries({ queryKey: ["timeline"] }); };
  const saveVideo = useMutation({
    mutationFn: (own: OwnLook) => client.setVideoLook(video!.id, own),
    onSuccess: (v) => {
      qc.setQueryData(["videoLook", video!.id], v);
      void qc.invalidateQueries({ queryKey: ["projectLook", projectId] });
      reset(v);
      if (v.revision !== null) void qc.invalidateQueries({ queryKey: ["timeline", video!.id] });
      void message.success(t(v.revision !== null ? "ws.style.savedTimeline" : "ws.style.saved"));
    },
    onError: fail,
  });
  const saveProject = useMutation({
    mutationFn: (p: { own: OwnLook; everyVideo: boolean }) => client.setProjectLook(projectId, p.own, { everyVideo: p.everyVideo }),
    onSuccess: (v, p) => {
      qc.setQueryData(["projectLook", projectId], v);
      timelinesChanged();
      setApplying(false);
      void message.success(p.everyVideo ? t("ws.style.appliedAll", { count: v.videos.length }) : t("ws.style.savedProject"));
    },
    onError: fail,
  });
  const fontOptions = useMemo(() => {
    const fonts = data?.choices.fonts ?? [];
    const group = (f: (typeof fonts)[number]) => (f.scripts.includes("korean") ? "korean" : f.scripts.includes("japanese") ? "japanese" : "latin");
    return (["latin", "japanese", "korean"] as const).map((g) => ({
      label: t(`ws.style.fontGroup.${g}`),
      options: fonts.filter((f) => group(f) === g).map((f) => ({ value: f.name, label: f.scripts.includes("vietnamese") ? `${f.name} · ${t("ws.style.hasVietnamese")}` : f.name })),
    })).filter((g) => g.options.length);
  }, [data, t]);

  if (!data) return <div className="ws-center"><Spin /></div>;
  const edit = (patch: Partial<TextLook>) => { setText((x) => ({ ...x, ...patch })); setDirty((d) => ({ ...d, text: true })); };
  const from = (s: LookSource) => <span className={`ws-style__from ws-style__from--${s}`}>{t(`ws.style.from.${s}`)}</span>;
  const own = hasOwn(data.own);
  const changed = dirty.text || dirty.look || dirty.match;
  const ro = !canEdit;
  // what is saved: each part changed here, else what was picked before (null: the plan's or the branding's)
  const picked: OwnLook = { text_look: dirty.text ? text : data.own.text_look, look: dirty.look ? look : data.own.look, color_match: dirty.match ? match : data.own.color_match };
  // "apply to all": everything the form shows becomes the project's
  const shown: OwnLook = { text_look: text, look, color_match: match };
  const pv = projectLook.data;
  const following = pv ? pv.videos.filter((v) => !v.ownLook) : [];
  const ownList = pv ? pv.videos.filter((v) => v.ownLook).sort((a, b) => a.idx - b.idx).map((v) => `#${v.idx}`).join(", ") : "";
  const busy = saveVideo.isPending || saveProject.isPending;

  const scope = video ? (
    <div className={`ws-style__scope${own ? " ws-style__scope--own" : ""}`} role="status">
      <Link2 size={15} aria-hidden />
      <span className="ws-style__scopetext">{t(own ? "ws.style.videoOwn" : "ws.style.videoFollows", { idx: video.idx })}</span>
      <Segmented<"project" | "own"> size="small" value={own ? "own" : "project"} disabled={ro || busy} aria-label={t("ws.style.projectTitle")}
        options={[{ value: "project", label: t("ws.style.followProject") }, { value: "own", label: t("ws.style.ownVideo") }]}
        onChange={(v) => {
          if (v === "project") saveVideo.mutate(NO_LOOK);
          else setDirty({ text: true, look: true, match: true });
        }} />
    </div>
  ) : pv ? (
    <div className="ws-style__scope" role="status">
      <Layers size={15} aria-hidden />
      <span className="ws-style__scopetext">
        <strong>{t("ws.style.projectTitle")}</strong> · {t("ws.style.projectScope", { count: following.length, total: pv.videos.length })}
        {ownList ? <> {t("ws.style.ownVideos", { list: ownList })}</> : null}
      </span>
    </div>
  ) : null;

  return (
    <>
      {scope}
      <SectionCard icon={<Type size={15} />} title={t("ws.style.textAndTone")} className="ws-style__card"
        action={dirty.text ? null : from(data.effective.from.text_look)}
        footer={canEdit ? (
          <>
            <span className="ws-sec__grow">{t(video ? "ws.style.footVideo" : "ws.style.footProject")}</span>
            {changed ? <Button size="small" onClick={() => reset(data)}>{t("common.cancel")}</Button> : null}
            <Button size="small" icon={<CopyCheck size={14} />} disabled={busy} onClick={() => setApplying(true)}>{t("ws.style.applyAll")}</Button>
            <Button type="primary" size="small" disabled={!changed} loading={busy && changed}
              onClick={() => (video ? saveVideo.mutate(picked) : saveProject.mutate({ own: picked, everyVideo: false }))}>
              {video ? t("ws.style.saveVideo", { idx: video.idx }) : t("ws.style.saveProject")}
            </Button>
          </>
        ) : null}>
        <TextPreview look={text} picture={look} url={frame} text={video?.title ?? t("ws.style.sampleTitle")} />
        <label className="ws-style__row">{t("ws.style.font")}
          <Select size="small" showSearch value={text.font ?? "Arial"} disabled={ro} options={fontOptions} style={{ width: 230 }} aria-label={t("ws.style.font")}
            onChange={(font: string) => edit({ font })} />
        </label>
        <div className="ws-style__row">{t("ws.style.size")}
          <Segmented<TextLook["size"]> size="small" value={text.size} disabled={ro} onChange={(size) => edit({ size })} aria-label={t("ws.style.size")}
            options={data.choices.sizes.map((s) => ({ value: s, label: t(`ws.style.sizes.${s}`) }))} />
        </div>
        <div className="ws-style__row">{t("ws.style.textColor")}
          <ColorPicker size="small" disabledAlpha showText value={text.text_color} disabled={ro} onChangeComplete={(c) => edit({ text_color: hex(c) })} aria-label={t("ws.style.textColor")} />
        </div>
        <div className="ws-style__row">{t("ws.style.outline")}
          <ColorPicker size="small" disabledAlpha showText value={text.outline_color} disabled={ro} onChangeComplete={(c) => edit({ outline_color: hex(c) })} aria-label={t("ws.style.outline")} />
        </div>
        <div className="ws-style__row">{t("ws.style.box")}
          <span className="ws-style__pair">
            {text.box_color ? <ColorPicker size="small" disabledAlpha value={text.box_color} disabled={ro} onChangeComplete={(c) => edit({ box_color: hex(c) })} aria-label={t("ws.style.boxColor")} /> : null}
            <Switch size="small" checked={!!text.box_color} disabled={ro} onChange={(on) => edit({ box_color: on ? "#1A1A1A" : null })} aria-label={t("ws.style.box")} />
          </span>
        </div>
        <div className="ws-style__row">{t("ws.style.shadow")}
          <Switch size="small" checked={!!text.shadow} disabled={ro} onChange={(shadow) => edit({ shadow })} aria-label={t("ws.style.shadow")} />
        </div>
        <div className="ws-style__head"><span className="ws-sub">{t("ws.style.pictureTitle")}</span>{dirty.look ? null : from(data.effective.from.look)}</div>
        <div className="ws-style__looks" role="radiogroup" aria-label={t("ws.style.pictureTitle")}>
          {data.choices.looks.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={look === l} disabled={ro} className="ws-style__look"
              onClick={() => { setLook(l); setDirty((d) => ({ ...d, look: true })); }}>
              <Frame url={frame} look={l} />
              <span>{t(`ws.style.looks.${l}`)}</span>
            </button>
          ))}
        </div>
        <p className="ws-hint ws-style__note">{t(`ws.style.lookHint.${look}`)}</p>
        <div className="ws-style__row"><span>{t("ws.style.colorMatch")} {dirty.match ? null : from(data.effective.from.color_match)}</span>
          <Switch size="small" checked={match} disabled={ro} onChange={(v) => { setMatch(v); setDirty((d) => ({ ...d, match: true })); }} aria-label={t("ws.style.colorMatch")} />
        </div>
        <p className="ws-hint ws-style__note">{t("ws.style.colorMatchHint")}</p>
      </SectionCard>
      <ApplyAllModal open={applying} project={pv} busy={saveProject.isPending} onCancel={() => setApplying(false)}
        onOk={() => saveProject.mutate({ own: shown, everyVideo: true })} />
    </>
  );
}

/** The project's reference videos (only to learn an edit style from): listed, added from the computer or the library, removed. */
function ReferencesSection({ projectId, canEdit, onOpenFile }: { projectId: string; canEdit: boolean; onOpenFile: (path: string) => void }) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const media = useMediaUpload(projectId);
  const input = useRef<HTMLInputElement>(null);
  const [library, setLibrary] = useState(false);
  const sources = useQuery({ queryKey: ["sources", projectId, null], queryFn: () => client.listSources(projectId) });
  const videos = useQuery({ queryKey: ["videos", projectId], queryFn: () => client.listVideos(projectId) });
  const references = (sources.data?.sources ?? []).filter((s) => s.kind === "upload" && s.meta.reference === true);
  const remove = useMutation({
    mutationFn: (id: string) => client.removeSource(projectId, id),
    onSuccess: () => { for (const k of ["sources", "files"]) void qc.invalidateQueries({ queryKey: [k, projectId] }); },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.inputs.removeFailed")),
  });
  return (
    <SectionCard icon={<Clapperboard size={15} />} title={t("ws.style.referencesTitle")} count={references.length} hint={t("ws.style.referencesHint")}
      action={canEdit ? (
        <AddMenu icon={<Plus size={14} />} loading={media.upload.isPending}
          label={media.percent !== null ? t("common.uploading", { pct: media.percent }) : t("ws.style.addReference")} items={[
            { key: "upload", icon: <Upload size={14} />, label: t("ws.style.referenceUpload"), hint: t("ws.style.referenceUploadHint"), onClick: () => input.current?.click() },
            { key: "library", icon: <Library size={14} />, label: t("ws.library.fromLibrary"), onClick: () => setLibrary(true) },
          ]} />
      ) : null}>
      {references.length ? (
        <ul className="ws-inputs__list">
          {references.map((s) => (
            <li key={s.id} className="ws-inputs__row">
              <Film size={14} aria-hidden />
              <span className="ws-inputs__text">
                <button type="button" className="ws-link ws-inputs__name" onClick={() => onOpenFile(s.ref)}>{s.label}</button>
                {s.mediaId ? <span className="ws-vchips"><span className="ws-badge-lib">{t("ws.library.badge")}</span></span> : null}
              </span>
              {canEdit ? (
                <Popconfirm title={t("ws.style.removeReference", { name: s.label })} onConfirm={() => remove.mutate(s.id)} okText={t("ws.inputs.remove")} cancelText={t("common.cancel")}>
                  <button type="button" className="ws-icon-button" aria-label={t("ws.inputs.removeNamed", { name: s.label })}><Trash2 size={13} /></button>
                </Popconfirm>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="ws-hint ws-inputs__empty">{t("ws.style.noReferences")}</p>}
      <input ref={input} type="file" multiple hidden accept={REFERENCE_ACCEPT} aria-label={t("ws.style.referenceUpload")}
        onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ""; if (list.length) media.upload.mutate({ files: list, use: "reference" }); }} />
      <MediaLibraryDrawer open={library} projectId={projectId} use="reference" videos={videos.data?.videos ?? []}
        inProject={new Set(references.map((s) => s.mediaId).filter((x): x is string => !!x))} onClose={() => setLibrary(false)} />
    </SectionCard>
  );
}

/**
 * The Style tab (plan 2026-10-28 P3, layout plan 2026-10-29): the words and picture (in a video, its own over the
 * project's; on the project page, the project's for every video), then the channel's edit style and the reference
 * videos it is learned from, each in its own box.
 */
export function StylePanel({ projectId, video, canEdit, onOpenFile, onPrompt }: {
  projectId: string;
  video?: { id: string; idx?: number; title: string } | undefined;
  canEdit: boolean;
  onOpenFile: (path: string) => void;
  /** Puts a message for the agent in the chat box. */
  onPrompt: (text: string) => void;
}) {
  const { t } = useAiTranslation();
  const client = useWorkspaceClient();
  const files = useQuery({ queryKey: ["files", projectId], queryFn: () => client.listFiles(projectId) });
  const has = (path: string) => !!files.data?.entries.some((e) => e.path === path);
  return (
    <div className="ws-secs ws-style">
      <LookForm projectId={projectId} video={video ? { id: video.id, idx: video.idx ?? 0, title: video.title } : undefined} canEdit={canEdit} />
      <SectionCard icon={<Scissors size={15} />} title={t("ws.style.editTitle")} hint={t(has(STYLE_FILE) ? "ws.style.editHas" : "ws.style.editNone")}
        action={canEdit ? <Button type="primary" size="small" icon={<Sparkles size={14} />} onClick={() => onPrompt(t("ws.style.learnPrompt"))}>{t("ws.style.learn")}</Button> : null}>
        <div className="ws-style__actions">
          {has(STYLE_FILE) ? <Button size="small" icon={<FileText size={14} />} onClick={() => onOpenFile(STYLE_FILE)}>{t("ws.style.openStyle")}</Button> : null}
          {has(BRANDING_FILE) ? <Button size="small" icon={<FileText size={14} />} onClick={() => onOpenFile(BRANDING_FILE)}>{t("ws.style.openBranding")}</Button> : null}
        </div>
      </SectionCard>
      <ReferencesSection projectId={projectId} canEdit={canEdit} onOpenFile={onOpenFile} />
    </div>
  );
}
