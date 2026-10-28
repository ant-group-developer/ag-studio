import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { App as AntApp, Button, ColorPicker, Segmented, Select, Spin, Switch } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Film, Sparkles } from "lucide-react";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type LookSource, type OwnLook, type TextLook, type VideoLook, type VideoLookView } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import "./style.css";

/** Studio's own look for the words when neither the video, its plan nor the branding says (white, black outline, m). */
const STUDIO_TEXT: TextLook = { text_color: "#FFFFFF", outline_color: "#000000", box_color: null, size: "m" };
const PREVIEW_PX = { s: 20, m: 26, l: 34 } as const;
const STYLE_FILE = "channel/style.md";
const BRANDING_FILE = "channel/branding.md";

/** The font drawn in the preview: the render machines' fonts are Google Fonts (OFL), Arial is the computer's. */
function useFontLoaded(font: string | undefined) {
  useEffect(() => {
    if (!font || font === "Arial") return;
    const id = `studio-font-${font.replace(/\s+/g, "-")}`;
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, "+")}&display=swap`;
    document.head.appendChild(link);
  }, [font]);
}

const hex = (c: { toHexString: () => string }) => c.toHexString().slice(0, 7).toUpperCase();

/** The video's words as they will look on a frame: font, size, colours, outline, box, shadow. */
function TextPreview({ look, text }: { look: TextLook; text: string }) {
  useFontLoaded(look.font);
  const o = look.outline_color;
  const shadows = [`1px 1px 0 ${o}`, `-1px -1px 0 ${o}`, `1px -1px 0 ${o}`, `-1px 1px 0 ${o}`, `0 0 2px ${o}`, ...(look.shadow ? ["0 3px 10px rgba(0,0,0,0.65)"] : [])];
  const style: CSSProperties = {
    fontFamily: `"${look.font ?? "Arial"}", Arial, sans-serif`, fontSize: PREVIEW_PX[look.size], color: look.text_color, textShadow: shadows.join(", "),
    ...(look.box_color ? { background: look.box_color, padding: "4px 12px", borderRadius: 4 } : {}),
  };
  return <div className="ws-style__frame" aria-hidden><span style={style}>{text}</span></div>;
}

/**
 * The Style tab (plan 2026-10-28 P3). In a video: the words on screen (font, size, colours, box, shadow) and the
 * picture (look, colour matching) picked for this video, over its edit plan and the channel's branding, saved onto its
 * latest timeline. Everywhere: the channel's edit style, its reference videos, and asking the agent to learn one.
 */
export function StylePanel({ projectId, video, canEdit, onOpenFile, onPrompt, onReferences }: {
  projectId: string;
  video?: { id: string; title: string } | undefined;
  canEdit: boolean;
  onOpenFile: (path: string) => void;
  /** Puts a message for the agent in the chat box. */
  onPrompt: (text: string) => void;
  /** Shows where reference videos are added (the Sources tab). */
  onReferences: () => void;
}) {
  const { t } = useAiTranslation();
  const client = useWorkspaceClient();
  const files = useQuery({ queryKey: ["files", projectId], queryFn: () => client.listFiles(projectId) });
  const has = (path: string) => !!files.data?.entries.some((e) => e.path === path);
  return (
    <div className="ws-style">
      {video ? <VideoLookForm videoId={video.id} title={video.title} canEdit={canEdit} /> : (
        <section className="ws-style__section" aria-label={t("ws.style.textTitle")}>
          <h4 className="ws-style__h">{t("ws.style.textTitle")}</h4>
          <p className="ws-hint">{t("ws.style.perVideo")}</p>
          {has(BRANDING_FILE) ? <Button size="small" icon={<FileText size={14} />} onClick={() => onOpenFile(BRANDING_FILE)}>{t("ws.style.openBranding")}</Button> : null}
        </section>
      )}
      <section className="ws-style__section" aria-label={t("ws.style.editTitle")}>
        <h4 className="ws-style__h">{t("ws.style.editTitle")}</h4>
        <p className="ws-hint">{t(has(STYLE_FILE) ? "ws.style.editHas" : "ws.style.editNone")}</p>
        <div className="ws-style__actions">
          {has(STYLE_FILE) ? <Button size="small" icon={<FileText size={14} />} onClick={() => onOpenFile(STYLE_FILE)}>{t("ws.style.openStyle")}</Button> : null}
          <Button size="small" icon={<Film size={14} />} onClick={onReferences}>{t("ws.style.references")}</Button>
          {canEdit ? <Button size="small" icon={<Sparkles size={14} />} onClick={() => onPrompt(t("ws.style.learnPrompt"))}>{t("ws.style.learn")}</Button> : null}
        </div>
      </section>
    </div>
  );
}

function VideoLookForm({ videoId, title, canEdit }: { videoId: string; title: string; canEdit: boolean }) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["videoLook", videoId], queryFn: () => client.getVideoLook(videoId) });
  const [text, setText] = useState<TextLook>(STUDIO_TEXT);
  const [look, setLook] = useState<VideoLook>("none");
  const [match, setMatch] = useState(false);
  const [dirty, setDirty] = useState({ text: false, look: false, match: false });
  const reset = (v: VideoLookView) => {
    setText(v.effective.text_look ?? STUDIO_TEXT);
    setLook(v.effective.look);
    setMatch(v.effective.color_match);
    setDirty({ text: false, look: false, match: false });
  };
  useEffect(() => { if (data) reset(data); }, [data]);
  const save = useMutation({
    mutationFn: (own: OwnLook) => client.setVideoLook(videoId, own),
    onSuccess: (v) => {
      qc.setQueryData(["videoLook", videoId], v);
      reset(v);
      if (v.revision !== null) void qc.invalidateQueries({ queryKey: ["timeline", videoId] });
      void message.success(t(v.revision !== null ? "ws.style.savedTimeline" : "ws.style.saved"));
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.style.saveFailed")),
  });
  const fontOptions = useMemo(() => {
    const fonts = data?.choices.fonts ?? [];
    const group = (f: (typeof fonts)[number]) => (f.scripts.includes("korean") ? "korean" : f.scripts.includes("japanese") ? "japanese" : "latin");
    return (["latin", "japanese", "korean"] as const).map((g) => ({
      label: t(`ws.style.fontGroup.${g}`),
      options: fonts.filter((f) => group(f) === g).map((f) => ({ value: f.name, label: f.scripts.includes("vietnamese") ? `${f.name} (VN)` : f.name })),
    })).filter((g) => g.options.length);
  }, [data, t]);

  if (isLoading || !data) return <div className="ws-center"><Spin /></div>;
  const edit = (patch: Partial<TextLook>) => { setText((x) => ({ ...x, ...patch })); setDirty((d) => ({ ...d, text: true })); };
  const from = (s: LookSource) => <span className={`ws-style__from ws-style__from--${s}`}>{t(`ws.style.from.${s}`)}</span>;
  const own = data.own.text_look !== null || data.own.look !== null || data.own.color_match !== null;
  const changed = dirty.text || dirty.look || dirty.match;
  const ro = !canEdit;

  return (
    <>
      <section className="ws-style__section" aria-label={t("ws.style.textTitle")}>
        <div className="ws-style__head"><h4 className="ws-style__h">{t("ws.style.textTitle")}</h4>{dirty.text ? null : from(data.effective.from.text_look)}</div>
        <TextPreview look={text} text={title} />
        <label className="ws-style__row">{t("ws.style.font")}
          <Select size="small" showSearch value={text.font ?? "Arial"} disabled={ro} options={fontOptions} style={{ width: 210 }} aria-label={t("ws.style.font")}
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
      </section>

      <section className="ws-style__section" aria-label={t("ws.style.pictureTitle")}>
        <h4 className="ws-style__h">{t("ws.style.pictureTitle")}</h4>
        <label className="ws-style__row"><span>{t("ws.style.look")} {dirty.look ? null : from(data.effective.from.look)}</span>
          <Select size="small" value={look} disabled={ro} style={{ width: 150 }} aria-label={t("ws.style.look")}
            onChange={(v: VideoLook) => { setLook(v); setDirty((d) => ({ ...d, look: true })); }}
            options={data.choices.looks.map((l) => ({ value: l, label: t(`ws.style.looks.${l}`) }))} />
        </label>
        <div className="ws-style__row"><span>{t("ws.style.colorMatch")} {dirty.match ? null : from(data.effective.from.color_match)}</span>
          <Switch size="small" checked={match} disabled={ro} onChange={(v) => { setMatch(v); setDirty((d) => ({ ...d, match: true })); }} aria-label={t("ws.style.colorMatch")} />
        </div>
        <p className="ws-hint">{t("ws.style.colorMatchHint")}</p>
      </section>

      {canEdit ? (
        <div className="ws-style__actions">
          <Button type="primary" size="small" disabled={!changed} loading={save.isPending && changed}
            onClick={() => save.mutate({
              text_look: dirty.text ? text : data.own.text_look, look: dirty.look ? look : data.own.look, color_match: dirty.match ? match : data.own.color_match,
            })}>{t("ws.style.save")}</Button>
          {changed ? <Button size="small" onClick={() => reset(data)}>{t("common.cancel")}</Button> : null}
          {own && !changed ? (
            <Button size="small" loading={save.isPending} onClick={() => save.mutate({ text_look: null, look: null, color_match: null })}>{t("ws.style.backToChannel")}</Button>
          ) : null}
        </div>
      ) : null}
      <p className="ws-hint">{t("ws.style.appliesHint")}</p>
    </>
  );
}
