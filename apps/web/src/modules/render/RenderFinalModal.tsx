import { useEffect, useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import type { EpisodeRender, FarmNode, RenderMachine } from "../../api/studio-client";
import { RenderMachinePicker } from "./RenderMachinePicker";

/**
 * Render lại the final cut (⋯ → Render bản cuối…, or the chat's render card): the machine type, and what will run
 * again — only the render, or the timeline and the kit approved again first when the timeline changed since.
 */
export function RenderFinalModal({ open, render, nodes, onClose, onConfirm, busy }: {
  open: boolean; render: EpisodeRender; nodes?: FarmNode[] | undefined; onClose: () => void;
  onConfirm: (m: RenderMachine, node: string | null) => void; busy?: boolean | undefined;
}) {
  const { t } = useTranslation();
  const [machine, setMachine] = useState<RenderMachine>(render.defaultMachine);
  const [node, setNode] = useState<string | null>(render.node?.id ?? null);
  useEffect(() => { if (open) { setMachine(render.defaultMachine); setNode(render.node?.id ?? null); } }, [open, render.defaultMachine, render.node?.id]);
  const from = render.restartFrom;
  return (
    <Modal open={open} onCancel={onClose} title={t("chat.render.finalTitle")} destroyOnClose
      okText={t("chat.render.confirm")} cancelText={t("chat.render.cancel")} onOk={() => onConfirm(machine, node)}
      okButtonProps={{ disabled: from === null || busy === true }}>
      <p>{from ? t(`chat.render.from.${from}`) : t("chat.render.producing")}</p>
      <RenderMachinePicker value={machine} onChange={setMachine} nodes={nodes} node={node} onNode={setNode} />
    </Modal>
  );
}
