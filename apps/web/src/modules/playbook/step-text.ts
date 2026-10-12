import { useTranslation } from "react-i18next";
import { wsVi } from "../../i18n/locales/ws.vi";

interface StepWords { key: string; title: string; description: string }

const DEFAULTS: Record<string, { title: string; description: string }> = wsVi.steps.def;

/**
 * A step's title and description in the UI language. The engine writes the default steps in Vietnamese; a step whose
 * words are still the default's (same key, same text) reads from `ws.steps.def.<key>`. A step a project wrote or
 * renamed itself (`.studio/playbook.yaml`) keeps its own words.
 */
export function useStepText(): (step: StepWords) => { title: string; description: string } {
  const { t } = useTranslation();
  return (step) => {
    const known = DEFAULTS[step.key];
    return {
      title: known && known.title === step.title ? t(`ws.steps.def.${step.key}.title`) : step.title,
      description: known && known.description === step.description ? t(`ws.steps.def.${step.key}.description`) : step.description,
    };
  };
}
