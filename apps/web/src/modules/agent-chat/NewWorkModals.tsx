import { useEffect, useState } from "react";
import { App as AntApp, Input, Modal } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type Learning, type Thread } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { DEFAULT_LEARNING, LearningPicker } from "./LearningPicker";

/** A new video: what it is about (the first message to the agent, optional), a title, and what it learns from. */
export function NewVideoModal({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [learning, setLearning] = useState<Learning>(DEFAULT_LEARNING);
  useEffect(() => { if (open) { setTitle(""); setPrompt(""); setLearning(DEFAULT_LEARNING); } }, [open]);
  const create = useMutation({
    mutationFn: () => client.createVideo(projectId, {
      ...(title.trim() ? { title: title.trim() } : {}), ...(prompt.trim() ? { prompt: prompt.trim() } : {}), learning,
    }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
      void qc.invalidateQueries({ queryKey: ["threads", projectId] });
      onClose();
      navigate(`/p/${projectId}/v/${v.id}`);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.video.createFailed")),
  });
  return (
    <Modal open={open} title={t("ws.video.newTitle")} okText={t("ws.video.create")} cancelText={t("common.cancel")}
      onOk={() => create.mutate()} onCancel={onClose} confirmLoading={create.isPending} destroyOnHidden width={620}>
      <p style={{ marginTop: 0 }}>{t("ws.video.newLead")}</p>
      <Input.TextArea autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} autoSize={{ minRows: 3, maxRows: 10 }}
        placeholder={t("ws.video.promptPlaceholder")} aria-label={t("ws.video.prompt")} maxLength={20_000} />
      <Input style={{ marginTop: 10 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("ws.video.titlePlaceholder")}
        aria-label={t("ws.video.title")} maxLength={200} />
      <h4 className="ws-modal-h">{t("ws.learning.title")}</h4>
      <LearningPicker projectId={projectId} value={learning} onChange={setLearning} />
    </Modal>
  );
}

/** A new free chat of the project (brainstorming, ideas, the channel's documents), and what it learns from. */
export function NewChatModal({ projectId, open, onClose, onCreated }: { projectId: string; open: boolean; onClose: () => void; onCreated: (t: Thread) => void }) {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [learning, setLearning] = useState<Learning>(DEFAULT_LEARNING);
  useEffect(() => { if (open) { setTitle(""); setLearning(DEFAULT_LEARNING); } }, [open]);
  const create = useMutation({
    mutationFn: () => client.createThread(projectId, { ...(title.trim() ? { title: title.trim() } : {}), learning }),
    onSuccess: (thread) => {
      void qc.invalidateQueries({ queryKey: ["threads", projectId] });
      onClose();
      onCreated(thread);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.chat.createFailed")),
  });
  return (
    <Modal open={open} title={t("ws.chat.newTitle")} okText={t("common.create")} cancelText={t("common.cancel")}
      onOk={() => create.mutate()} onCancel={onClose} confirmLoading={create.isPending} destroyOnHidden width={560}>
      <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("ws.chat.titlePlaceholder")}
        aria-label={t("ws.chat.titleLabel")} maxLength={200} onPressEnter={() => create.mutate()} />
      <h4 className="ws-modal-h">{t("ws.learning.title")}</h4>
      <LearningPicker projectId={projectId} value={learning} onChange={setLearning} />
    </Modal>
  );
}

/** Changes what an existing thread learns from. */
export function LearningModal({ projectId, threadId, current, open, onClose }: {
  projectId: string; threadId: string; current: Learning; open: boolean; onClose: () => void;
}) {
  const { t } = useAiTranslation();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const [learning, setLearning] = useState<Learning>(current);
  // reset to the thread's choice each time the modal opens (not on every render: `current` is a new object each time)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setLearning(current); }, [open]);
  const save = useMutation({
    mutationFn: () => client.setLearning(threadId, learning),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["thread", threadId] }); onClose(); },
  });
  return (
    <Modal open={open} title={t("ws.learning.title")} okText={t("common.save")} cancelText={t("common.cancel")}
      onOk={() => save.mutate()} onCancel={onClose} confirmLoading={save.isPending} destroyOnHidden width={560}>
      <LearningPicker projectId={projectId} value={learning} onChange={setLearning} exclude={threadId} />
    </Modal>
  );
}
