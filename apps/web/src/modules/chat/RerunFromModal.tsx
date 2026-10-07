import { useEffect, useState } from "react";
import { Modal, Radio } from "antd";
import type { ChatStep } from "./steps";
import { stepLabelKey } from "./steps";
import { useAiTranslation } from "../common/assistant-name";

/**
 * ⋯ → Chạy lại từ bước…: a run that ended goes again from one step, its Claude stage writing that step anew; the steps
 * before it are kept. The series plan warns that a new episode plan replaces the episodes.
 */
export function RerunFromModal({ open, steps, plan, busy, onClose, onConfirm }: {
  open: boolean; steps: { step: ChatStep; stage: string }[]; plan: boolean; busy?: boolean | undefined;
  onClose: () => void; onConfirm: (stage: string) => void;
}) {
  const { t } = useAiTranslation();
  const [stage, setStage] = useState<string | null>(null);
  useEffect(() => { if (open) setStage(null); }, [open]);
  return (
    <Modal open={open} onCancel={onClose} title={t("chat.rerunFrom.title")} destroyOnHidden
      okText={t("chat.rerunFrom.ok")} cancelText={t("chat.rerun.cancel")} onOk={() => stage && onConfirm(stage)}
      okButtonProps={{ disabled: !stage || busy === true }}>
      <p>{t("chat.rerunFrom.body")}</p>
      <Radio.Group value={stage} onChange={(e) => setStage(e.target.value as string)} className="render-machine__group"
        aria-label={t("chat.rerunFrom.title")}
        options={steps.map((s) => ({ value: s.stage, label: t(stepLabelKey(s.step)) }))} />
      <p className="chat-doc__note">{plan ? t("chat.rerunFrom.planNote") : t("chat.rerunFrom.episodeNote")}</p>
    </Modal>
  );
}
