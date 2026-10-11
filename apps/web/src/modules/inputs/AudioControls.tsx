import { useState } from "react";
import { App as AntApp, Button, Input, Modal, Radio } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic, Music } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type VoiceOrigin } from "../../api/workspace-client";

/**
 * The project's narration voice and background music (spec 2026-10-10 agent-workspace §P6): what is chosen, no
 * narration at all, clearing a choice. A producer picks the voice (and says where it comes from); music, an editor.
 */
export function AudioSummary({ projectId, canProduce }: { projectId: string; canProduce: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["audio", projectId], queryFn: () => client.getAudio(projectId) });
  const done = () => { void qc.invalidateQueries({ queryKey: ["audio", projectId] }); void qc.invalidateQueries({ queryKey: ["playbook", projectId] }); };
  const fail = (e: unknown) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.audio.failed"));
  const decline = useMutation({ mutationFn: () => client.declineVoice(projectId), onSuccess: done, onError: fail });
  const clear = useMutation({ mutationFn: (kind: "voice" | "music") => client.clearAudio(projectId, kind), onSuccess: done, onError: fail });
  if (!data) return null;
  const voiceMode = data.voice && typeof data.voice.mode === "string" ? data.voice.mode : data.voice ? "clone" : null;
  return (
    <section aria-label={t("ws.audio.title")}>
      <h4 className="ws-inputs__h">{t("ws.audio.title")}</h4>
      <ul className="ws-inputs__list">
        <li className="ws-inputs__row">
          <Mic size={14} aria-hidden />
          <div className="ws-inputs__text"><span className="ws-inputs__name">{t("ws.audio.voice")}</span><span className="ws-hint">{data.summary.voice}</span></div>
          {canProduce && voiceMode !== "none" ? <Button size="small" onClick={() => decline.mutate()} loading={decline.isPending}>{t("ws.audio.noNarration")}</Button> : null}
          {canProduce && voiceMode ? <Button size="small" onClick={() => clear.mutate("voice")} loading={clear.isPending && clear.variables === "voice"}>{t("ws.audio.clear")}</Button> : null}
        </li>
        <li className="ws-inputs__row">
          <Music size={14} aria-hidden />
          <div className="ws-inputs__text"><span className="ws-inputs__name">{t("ws.audio.music")}</span><span className="ws-hint">{data.summary.music}</span></div>
          {canProduce && data.music ? <Button size="small" onClick={() => clear.mutate("music")} loading={clear.isPending && clear.variables === "music"}>{t("ws.audio.clear")}</Button> : null}
        </li>
      </ul>
      <p className="ws-hint">{t("ws.audio.hint")}</p>
    </section>
  );
}

/** Buttons on an uploaded audio file: use it as the voice sample (producer) or the music (editor). */
export function UseAudioButtons({ projectId, path, canEdit, canProduce }: { projectId: string; path: string; canEdit: boolean; canProduce: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [origin, setOrigin] = useState<VoiceOrigin | null>(null);
  const [text, setText] = useState("");
  const use = useMutation({
    mutationFn: (kind: "voice" | "music") => client.audioFromFile(projectId, kind, kind === "voice" ? { path, origin: origin!, referenceText: text.trim() || null } : { path }),
    onSuccess: (_r, kind) => {
      void qc.invalidateQueries({ queryKey: ["audio", projectId] });
      void message.success(kind === "voice" ? t("ws.audio.voiceSet") : t("ws.audio.musicSet"));
      setVoiceOpen(false);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.audio.failed")),
  });
  return (
    <>
      {canProduce ? <Button size="small" icon={<Mic size={12} />} onClick={() => { setOrigin(null); setText(""); setVoiceOpen(true); }}>{t("ws.audio.useAsVoice")}</Button> : null}
      {canEdit ? <Button size="small" icon={<Music size={12} />} loading={use.isPending && use.variables === "music"} onClick={() => use.mutate("music")}>{t("ws.audio.useAsMusic")}</Button> : null}
      <Modal open={voiceOpen} title={t("ws.audio.voiceTitle")} okText={t("ws.audio.useAsVoice")} cancelText={t("common.cancel")} onCancel={() => setVoiceOpen(false)}
        okButtonProps={{ disabled: !origin }} confirmLoading={use.isPending} onOk={() => use.mutate("voice")} destroyOnHidden>
        <p style={{ marginTop: 0 }}>{t("ws.audio.voiceLead")}</p>
        <Radio.Group value={origin} onChange={(e) => setOrigin(e.target.value as VoiceOrigin)} aria-label={t("ws.audio.origin")}>
          {(["synthetic", "own", "licensed"] as const).map((o) => <Radio key={o} value={o}>{t(`ws.audio.origins.${o}`)}</Radio>)}
        </Radio.Group>
        <Input.TextArea style={{ marginTop: 12 }} value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} maxLength={500}
          placeholder={t("ws.audio.referenceText")} aria-label={t("ws.audio.referenceText")} />
      </Modal>
    </>
  );
}
