import i18n from "i18next";

export const APP_LANGUAGES = ["vi", "en"] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: AppLanguage = "vi";

/** Native names, shown untranslated so users can always find their own language. */
export const LANGUAGE_NAMES: Record<AppLanguage, string> = {
  vi: "Tiếng Việt",
  en: "English",
};

const LANGUAGE_STORAGE_KEY = "ag-studio.language";

function isAppLanguage(value: unknown): value is AppLanguage {
  return APP_LANGUAGES.includes(value as AppLanguage);
}

export function readStoredLanguage(): AppLanguage {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isAppLanguage(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function currentLanguage(): AppLanguage {
  return isAppLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : DEFAULT_LANGUAGE;
}

/** Switches the UI language and remembers the choice for the next visit. */
export async function changeLanguage(language: AppLanguage): Promise<void> {
  await i18n.changeLanguage(language);
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage can be unavailable (private mode); the choice then only lasts for this session.
  }
}
