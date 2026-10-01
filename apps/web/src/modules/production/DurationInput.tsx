/**
 * A duration typed as hours, minutes and seconds; the form holds it as whole seconds (`undefined` while all three
 * are empty). Used for the target length of an episode.
 */
import { InputNumber, Space } from "antd";
import { useTranslation } from "react-i18next";

export interface DurationInputProps {
  value?: number;
  onChange?: (seconds: number | undefined) => void;
  disabled?: boolean;
}

/** `{h, m, s}` of a number of seconds. */
export function splitSeconds(total: number): { h: number; m: number; s: number } {
  const t = Math.max(0, Math.round(total));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

/** "1 giờ 5 phút 30 giây" style label (zero parts left out); "0 giây" for 0. */
export function formatDuration(total: number, units: { h: string; m: string; s: string }): string {
  const { h, m, s } = splitSeconds(total);
  const parts = [h ? `${h} ${units.h}` : "", m ? `${m} ${units.m}` : "", s ? `${s} ${units.s}` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : `0 ${units.s}`;
}

export function DurationInput({ value, onChange, disabled }: DurationInputProps) {
  const { t } = useTranslation();
  const parts = value === undefined ? undefined : splitSeconds(value);

  const set = (key: "h" | "m" | "s", n: number | null) => {
    const next = { ...(parts ?? { h: 0, m: 0, s: 0 }), [key]: n ?? 0 };
    const total = next.h * 3600 + next.m * 60 + next.s;
    const allEmpty = n === null && (parts === undefined || total === 0);
    onChange?.(allEmpty ? undefined : total);
  };

  const field = (key: "h" | "m" | "s", max: number) => (
    <InputNumber
      aria-label={t(`duration.${key}`)}
      min={0}
      max={max}
      precision={0}
      value={parts ? parts[key] : null}
      onChange={(n) => set(key, n)}
      addonAfter={t(`duration.${key}`)}
      disabled={disabled}
      style={{ width: 120 }}
    />
  );

  return (
    <Space wrap size={8}>
      {field("h", 99)}
      {field("m", 59)}
      {field("s", 59)}
    </Space>
  );
}
