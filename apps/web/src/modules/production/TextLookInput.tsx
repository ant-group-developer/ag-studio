/**
 * The branding's text look (`on_screen_text.look`, plan 2026-10-08 task 28): how the words appear on a shot-cut
 * episode's video. Off = the Studio default look (the key absent). A controlled input: antd `Form.Item` and the chat's
 * document editor both pass `value` / `onChange`.
 */
import { Checkbox, Select, Space, Switch, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { TEXT_LOOK_SIZES, type TextLook } from "@harness/contracts";
import { textLookStyle } from "../editor/Player";

const { Text } = Typography;

/** What switching the look on starts from: the default look's colours, no box, medium. */
export const DEFAULT_TEXT_LOOK: TextLook = { text_color: "#FFFFFF", outline_color: "#000000", box_color: null, size: "m" };
const DEFAULT_BOX = "#1D3557";

const hex = (v: string) => v.toUpperCase();

export function TextLookInput({ value, onChange, disabled }: { value?: TextLook | null; onChange?: (v: TextLook | undefined) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const look = value ?? null;
  const set = (patch: Partial<TextLook>) => onChange?.({ ...(look ?? DEFAULT_TEXT_LOOK), ...patch });
  return (
    <Space direction="vertical" size={8}>
      <Space>
        <Switch size="small" aria-label={t("brandingEditor.textLookCustom")} checked={!!look} disabled={disabled}
          onChange={(on) => onChange?.(on ? DEFAULT_TEXT_LOOK : undefined)} />
        <Text>{look ? t("brandingEditor.textLookCustom") : t("brandingEditor.textLookDefault")}</Text>
      </Space>
      {look ? (
        <>
          <Space wrap>
            <label>
              <Text type="secondary">{t("brandingEditor.textLookText")} </Text>
              <input type="color" aria-label={t("brandingEditor.textLookText")} value={look.text_color.toLowerCase()} disabled={disabled}
                onChange={(e) => set({ text_color: hex(e.target.value) })} />
            </label>
            <label>
              <Text type="secondary">{t("brandingEditor.textLookOutline")} </Text>
              <input type="color" aria-label={t("brandingEditor.textLookOutline")} value={look.outline_color.toLowerCase()} disabled={disabled}
                onChange={(e) => set({ outline_color: hex(e.target.value) })} />
            </label>
            <Checkbox checked={look.box_color !== null} disabled={disabled} onChange={(e) => set({ box_color: e.target.checked ? DEFAULT_BOX : null })}>
              {t("brandingEditor.textLookBox")}
            </Checkbox>
            {look.box_color !== null ? (
              <input type="color" aria-label={t("brandingEditor.textLookBoxColor")} value={look.box_color.toLowerCase()} disabled={disabled}
                onChange={(e) => set({ box_color: hex(e.target.value) })} />
            ) : null}
            <Select size="small" aria-label={t("brandingEditor.textLookSize")} value={look.size} disabled={disabled} style={{ width: 100 }}
              options={TEXT_LOOK_SIZES.map((s) => ({ value: s, label: t(`brandingEditor.textLookSizes.${s}`) }))}
              onChange={(size) => set({ size })} />
          </Space>
          <TextLookSample look={look} />
        </>
      ) : null}
    </Space>
  );
}

/** A title and a callout drawn in the look, on a dark-to-light strip (as over a picture). */
export function TextLookSample({ look }: { look: TextLook | null | undefined }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", padding: 8, borderRadius: 4, fontFamily: "Arial, Helvetica, sans-serif",
      fontWeight: 600, background: "linear-gradient(90deg, #2b2b2b, #9aa4ad)" }}>
      <span style={{ padding: "2px 6px", ...textLookStyle(look, "title") }}>{t("brandingEditor.textLookSample")}</span>
      <span style={{ padding: "2px 6px", ...textLookStyle(look, "callout") }}>{t("brandingEditor.textLookSampleCallout")}</span>
    </div>
  );
}
