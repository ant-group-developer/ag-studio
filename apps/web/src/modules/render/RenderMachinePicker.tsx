import { useId } from "react";
import { Radio, Select } from "antd";
import { useTranslation } from "react-i18next";
import { RENDER_MACHINES, type FarmNode, type RenderMachine } from "../../api/studio-client";

/**
 * Which kind of farm machine renders the final cut (spec local-chat §3.4): any, one with NVENC, one with a GPU —
 * ag-farm's `requirements`. With `nodes` (the farm's machines taking final renders) and `onNode`, the render may also
 * be pinned to one machine. Shown on every confirm that starts a final render.
 */
export function RenderMachinePicker({ value, onChange, nodes, node = null, onNode }: {
  value: RenderMachine; onChange: (m: RenderMachine) => void;
  nodes?: FarmNode[] | undefined; node?: string | null | undefined; onNode?: ((id: string | null) => void) | undefined;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="render-machine">
      <div role="radiogroup" aria-label={t("chat.render.machine")}>
        <Radio.Group value={value} onChange={(e) => onChange(e.target.value as RenderMachine)} className="render-machine__group">
          {RENDER_MACHINES.map((m) => (
            // the input is named by the machine type alone; the hint describes it
            <Radio key={m} value={m} className="render-machine__option" aria-label={t(`chat.render.machines.${m}`)} aria-describedby={`${id}-${m}`}>
              <span className="render-machine__name">{t(`chat.render.machines.${m}`)}</span>
              <span className="render-machine__hint" id={`${id}-${m}`}>{t(`chat.render.hints.${m}`)}</span>
            </Radio>
          ))}
        </Radio.Group>
      </div>
      {nodes?.length && onNode ? (
        <label className="render-machine__node">
          <span>{t("chat.render.node")}</span>
          <Select<string>
            aria-label={t("chat.render.node")}
            value={node ?? ""}
            onChange={(v) => onNode(v || null)}
            options={[
              { value: "", label: t("chat.render.noNode") },
              ...nodes.map((n) => ({
                value: n.id,
                label: t("chat.render.nodeOption", { name: n.name, state: t(n.online ? "chat.render.online" : "chat.render.offline") })
                  + (n.gpus.some((g) => g.nvenc) ? " · NVENC" : ""),
              })),
            ]}
          />
        </label>
      ) : null}
      <p className="chat-doc__note">{t("chat.render.waitNote")}</p>
    </div>
  );
}
