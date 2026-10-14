import { useState } from "react";
import { Button, Popover, Progress } from "antd";
import { CheckCircle2, Circle, Rocket } from "lucide-react";
import { Link } from "react-router-dom";
import { useAiTranslation } from "../common/assistant-name";
import { GUIDE_SECTION, stepTarget, useOnboarding, usePrefs, useUpdatePrefs } from "./use-onboarding";
import "./onboarding.css";

/**
 * "Getting started n/7" in the header: the seven steps to a first video, each ticked by what the person has done in
 * their teams, with a way to the page where it is done and to the guide's section on it. Hidden for good once every
 * step is done or the person hides it (the guide page shows it again).
 */
export function StartChecklist() {
  const { t } = useAiTranslation();
  const { data: prefs } = usePrefs();
  const { data, refetch } = useOnboarding(!!prefs && !prefs.checklistHidden);
  const update = useUpdatePrefs();
  const [open, setOpen] = useState(false);
  if (!prefs || prefs.checklistHidden || !data || data.done >= data.total) return null;

  const close = () => setOpen(false);
  const content = (
    <div className="ws-start">
      <p className="ws-start__lead">{t("ws.start.lead")}</p>
      <Progress percent={Math.round((data.done / data.total) * 100)} showInfo={false} size="small" />
      <ol className="ws-start__list">
        {data.steps.map((s) => (
          <li key={s.key} className={s.done ? "ws-start__step ws-start__step--done" : "ws-start__step"}>
            {s.done
              ? <CheckCircle2 size={18} className="ws-start__tick" aria-label={t("ws.start.done")} />
              : <Circle size={18} className="ws-start__tick" aria-label={t("ws.start.todo")} />}
            <div className="ws-start__body">
              <span className="ws-start__title">{t(`ws.start.steps.${s.key}.title`)}</span>
              {s.done ? null : <span className="ws-start__hint">{t(`ws.start.steps.${s.key}.hint`)}</span>}
              <span className="ws-start__links">
                <Link to={stepTarget(s.key, data.links)} onClick={close}>{t("ws.start.goTo")}</Link>
                <Link to={`/guide#${GUIDE_SECTION[s.key]}`} onClick={close}>{t("ws.start.howTo")}</Link>
              </span>
            </div>
          </li>
        ))}
      </ol>
      <div className="ws-start__foot">
        <span className="ws-hint">{t("ws.start.hideHint")}</span>
        <Button size="small" onClick={() => { close(); update.mutate({ checklistHidden: true }); }}>{t("ws.start.hide")}</Button>
      </div>
    </div>
  );
  return (
    <Popover
      trigger="click" placement="bottomRight" open={open} title={t("ws.start.title")} content={content} destroyOnHidden
      onOpenChange={(o) => { setOpen(o); if (o) void refetch(); }}
    >
      <button type="button" className="ws-icon-button ws-icon-button--outline ws-start-button" data-tour="start" aria-expanded={open}>
        <Rocket size={14} aria-hidden />{t("ws.start.button", { done: data.done, total: data.total })}
      </button>
    </Popover>
  );
}
