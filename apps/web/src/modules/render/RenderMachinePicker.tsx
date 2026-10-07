import { useId } from "react";
import { Radio } from "antd";
import { useTranslation } from "react-i18next";
import { RENDER_MACHINES, type RenderMachine } from "../../api/studio-client";

/**
 * Which kind of farm machine renders the final cut (spec local-chat §3.4): any, one with NVENC, one with a GPU —
 * ag-farm's `requirements`, so no named machine. Shown on every confirm that starts a final render.
 */
export function RenderMachinePicker({ value, onChange }: { value: RenderMachine; onChange: (m: RenderMachine) => void }) {
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
      <p className="chat-doc__note">{t("chat.render.waitNote")}</p>
    </div>
  );
}
