import { useTranslation } from "react-i18next";

export type EnumGroup =
  | "productionStatus"
  | "runState"
  | "stageState"
  | "stage"
  | "check"
  | "language"
  | "aspect"
  | "exportKind";

export const PRODUCTION_STATUS_COLORS: Record<string, string> = {
  in_progress: "blue",
  review: "gold",
  done: "green",
};

const ASPECT_KEYS: Record<string, string> = { "16:9": "landscape", "9:16": "portrait" };

/** The readable name of an API code (`enums.<group>.<code>`), or null when there is none. */
export function useEnumLabel(): (group: EnumGroup, code: string) => string | null {
  const { t, i18n } = useTranslation();
  return (group, code) => {
    const key = group === "aspect" ? ASPECT_KEYS[code] : code;
    // i18next reads "." and ":" in a key as separators; such codes simply have no label.
    if (!key || /[.:]/.test(key)) return null;
    const path = `enums.${group}.${key}`;
    return i18n.exists(path) ? t(path) : null;
  };
}

/** A code shown as its readable name followed by the code itself, dimmed; just the code when it has no name. */
export function EnumText({ group, code }: { group: EnumGroup; code: string }) {
  const label = useEnumLabel()(group, code);
  if (!label) return <>{code}</>;
  return (
    <span>
      {label}
      <span style={{ marginLeft: 6, opacity: 0.6, fontFamily: "monospace", fontSize: "0.85em" }}>
        {code}
      </span>
    </span>
  );
}
