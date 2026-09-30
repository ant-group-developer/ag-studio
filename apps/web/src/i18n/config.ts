import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { APP_LANGUAGES, DEFAULT_LANGUAGE, readStoredLanguage } from "./language";
import { vi } from "./locales/vi";
import { en } from "./locales/en";

const resources = {
  vi: { translation: vi },
  en: { translation: en },
} as const;

i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
});

void i18n.use(initReactI18next).init({
  resources,
  lng: readStoredLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...APP_LANGUAGES],
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
