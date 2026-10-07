import { useRef, useState } from "react";
import { Checkbox, Input, Popconfirm, Radio, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  StudioHttpError, useStudioClient, type AudioInput, type AudioKind, type ProductionAudio, type VoiceOrigin,
} from "../../../api/studio-client";
import { useAiTranslation } from "../../common/assistant-name";

/** Accepted by the file picker; the server checks the file itself with ffprobe. */
const AUDIO_ACCEPT = "audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus";

export const productionAudioKey = (productionId: string) => ["production-audio", productionId] as const;

function errorText(e: unknown, t: (k: string) => string): string {
  const code = e instanceof StudioHttpError && typeof e.body?.code === "string" ? e.body.code : null;
  const known = code ? t(`chat.audio.errors.${code}`) : null;
  return known && known !== `chat.audio.errors.${code}` ? known : e instanceof Error ? e.message : String(e);
}

/** Give one audio file: paste a link or upload; a voice also says whose it is and that the person may use it. */
function AudioPicker({ kind, suggestedUrl, saving, onSave, onCancel }: {
  kind: AudioKind; suggestedUrl?: string | null | undefined; saving: boolean;
  onSave: (input: AudioInput) => void; onCancel: () => void;
}) {
  const { t } = useAiTranslation();
  const [tab, setTab] = useState<"link" | "upload">("link");
  const [url, setUrl] = useState(suggestedUrl ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [origin, setOrigin] = useState<VoiceOrigin | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [referenceText, setReferenceText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const hasAudio = tab === "link" ? url.trim().length > 0 : !!file;
  const ready = hasAudio && (kind === "music" || (!!origin && confirm));
  const save = () => onSave({
    ...(tab === "link" ? { url: url.trim() } : { file: file! }),
    ...(kind === "voice" ? { origin: origin!, confirm, ...(referenceText.trim() ? { referenceText: referenceText.trim() } : {}) } : {}),
  });

  return (
    <div className="chat-audio__picker">
      <Radio.Group size="small" value={tab} onChange={(e) => setTab(e.target.value as "link" | "upload")} optionType="button"
        options={[{ value: "link", label: t("chat.audio.tabs.link") }, { value: "upload", label: t("chat.audio.tabs.upload") }]} />
      {tab === "link" ? (
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("chat.audio.linkPlaceholder")} aria-label={t("chat.audio.tabs.link")} />
      ) : (
        <div>
          <input ref={fileInput} type="file" accept={AUDIO_ACCEPT} hidden data-testid={`audio-file-${kind}`}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" className="chat-card__button chat-button--secondary" onClick={() => fileInput.current?.click()}>{t("chat.audio.pick")}</button>
          {file ? <span className="chat-audio__hint"> {t("chat.audio.picked", { name: file.name })}</span> : null}
        </div>
      )}
      {kind === "voice" ? (
        <>
          <Radio.Group value={origin} onChange={(e) => setOrigin(e.target.value as VoiceOrigin)} aria-label={t("chat.audio.origin.label")}
            options={(["synthetic", "own", "licensed"] as const).map((o) => ({ value: o, label: t(`chat.audio.origin.${o}`) }))} />
          <Input value={referenceText} onChange={(e) => setReferenceText(e.target.value)} placeholder={t("chat.audio.referenceText")} aria-label={t("chat.audio.referenceText")} />
          <Checkbox checked={confirm} onChange={(e) => setConfirm(e.target.checked)}>{t("chat.audio.confirm")}</Checkbox>
        </>
      ) : null}
      <div className="chat-audio__actions">
        <button type="button" className="chat-card__button" disabled={!ready || saving} onClick={save}>{saving ? t("chat.audio.saving") : t("chat.audio.save")}</button>
        <button type="button" className="chat-card__button chat-button--secondary" disabled={saving} onClick={onCancel}>{t("chat.audio.cancel")}</button>
      </div>
    </div>
  );
}

function describe(a: ProductionAudio, kind: AudioKind, t: (k: string, o?: Record<string, unknown>) => string): string {
  const what = kind === "voice" ? a.voice : a.music;
  if (!what) return t("chat.audio.none");
  if ("mode" in what && what.mode === "none") return t("chat.audio.declined");
  const source = what.source;
  const from = !source ? (kind === "voice" ? t("chat.audio.studioDefault") : t("chat.audio.typed"))
    : source.kind === "upload" ? t("chat.audio.fromUpload", { name: source.filename }) : t("chat.audio.fromLink");
  return what.duration_s ? `${from} · ${t("chat.audio.seconds", { s: Math.round(what.duration_s) })}` : from;
}

/**
 * The production's voice sample and background music (plan optional-audio): both optional, given by link or upload.
 * `needsVoice`: an episode waits at its narration step; the panel says so and offers to drop narration instead.
 */
export function ProductionAudioPanel({ productionId, episodeId, canEdit, needsVoice = false, suggested, onChanged }: {
  productionId: string; canEdit: boolean; needsVoice?: boolean;
  /** The episode waiting for a voice: it may drop narration for itself alone. */
  episodeId?: string | undefined;
  /** Links the person pasted in the intake chat (`audio_links`). */
  suggested?: { voice?: string | null; music?: string | null } | null | undefined;
  onChanged?: () => void;
}) {
  const { t } = useAiTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState<AudioKind | null>(needsVoice ? "voice" : null);
  const { data } = useQuery({ queryKey: productionAudioKey(productionId), queryFn: () => client.getProductionAudio(productionId) });
  const changed = (next: ProductionAudio) => {
    qc.setQueryData(productionAudioKey(productionId), next);
    onChanged?.();
  };
  const give = useMutation({
    mutationFn: (v: { kind: AudioKind; input: AudioInput }) => client.giveProductionAudio(productionId, v.kind, v.input),
    onSuccess: (r, v) => {
      setOpen(null);
      void message.success(v.kind === "voice" && r.resumedEpisodes.length ? t("chat.audio.saved.resumed", { n: r.resumedEpisodes.length }) : t(`chat.audio.saved.${v.kind}`));
      changed(r);
    },
    onError: (e) => { void message.error(errorText(e, t)); },
  });
  const decline = useMutation({
    mutationFn: () => client.declineNarration(productionId),
    onSuccess: (r) => { setOpen(null); void message.success(t("chat.audio.declined_ok", { n: r.resumedEpisodes.length })); changed(r); },
    onError: (e) => { void message.error(errorText(e, t)); },
  });
  const declineEpisode = useMutation({
    mutationFn: () => client.setEpisodeNarration(productionId, episodeId!, true),
    onSuccess: () => { setOpen(null); void message.success(t("chat.audio.declinedEpisode_ok")); onChanged?.(); },
    onError: (e) => { void message.error(errorText(e, t)); },
  });
  const remove = useMutation({
    mutationFn: (kind: AudioKind) => client.removeProductionAudio(productionId, kind),
    onSuccess: changed,
    onError: (e) => { void message.error(errorText(e, t)); },
  });
  const audio: ProductionAudio = data ?? { voice: null, music: null };
  const busy = give.isPending || decline.isPending || declineEpisode.isPending || remove.isPending;

  const row = (kind: AudioKind) => {
    const what = kind === "voice" ? audio.voice : audio.music;
    const listenUrl = what && "listenUrl" in what ? what.listenUrl : null;
    const suggestedUrl = kind === "voice" ? suggested?.voice : suggested?.music;
    return (
      <div className="chat-audio__row" key={kind}>
        <div className="chat-audio__line">
          <strong>{t(`chat.audio.${kind}`)}</strong>
          <span className="chat-audio__state">{describe(audio, kind, t)}</span>
          {listenUrl ? <audio className="chat-audio__player" controls preload="none" src={listenUrl} aria-label={t("chat.audio.listen")} /> : null}
          {canEdit && open !== kind ? (
            <span className="chat-audio__buttons">
              <button type="button" className="chat-link-button" disabled={busy} onClick={() => setOpen(kind)}>{what ? t("chat.audio.change") : t("chat.audio.add")}</button>
              {what ? <button type="button" className="chat-link-button" disabled={busy} onClick={() => remove.mutate(kind)}>{t("chat.audio.remove")}</button> : null}
            </span>
          ) : null}
        </div>
        {canEdit && !what && suggestedUrl && open !== kind ? (
          <div className="chat-audio__hint">
            {t("chat.audio.suggested", { url: suggestedUrl })}{" "}
            <button type="button" className="chat-link-button" onClick={() => setOpen(kind)}>{t("chat.audio.useLink")}</button>
          </div>
        ) : null}
        {open === kind ? (
          <AudioPicker kind={kind} suggestedUrl={suggestedUrl} saving={give.isPending}
            onSave={(input) => give.mutate({ kind, input })} onCancel={() => setOpen(null)} />
        ) : null}
      </div>
    );
  };

  return (
    <section className="chat-audio" aria-label={t("chat.audio.title")}>
      <p className="chat-doc__note">{needsVoice ? t("chat.audio.needsVoice") : t("chat.audio.optional")}</p>
      {row("voice")}
      {row("music")}
      {needsVoice && canEdit ? (
        <div className="chat-audio__buttons">
          <Popconfirm title={t("chat.audio.declineConfirm")} onConfirm={() => decline.mutate()} okText={t("chat.audio.decline")} cancelText={t("chat.audio.cancel")}>
            <button type="button" className="chat-card__button chat-button--secondary" disabled={busy}>{t("chat.audio.decline")}</button>
          </Popconfirm>
          {episodeId ? (
            <Popconfirm title={t("chat.audio.declineEpisodeConfirm")} onConfirm={() => declineEpisode.mutate()} okText={t("chat.audio.declineEpisode")} cancelText={t("chat.audio.cancel")}>
              <button type="button" className="chat-card__button chat-button--secondary" disabled={busy}>{t("chat.audio.declineEpisode")}</button>
            </Popconfirm>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
