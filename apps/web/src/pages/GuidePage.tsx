import { useEffect, type MouseEvent } from "react";
import { Button } from "antd";
import { Compass, ListChecks } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAiTranslation } from "../modules/common/assistant-name";
import { GuideText } from "../modules/onboarding/GuideText";
import { useReplayTour } from "../modules/onboarding/ProductTour";
import { usePrefs, useUpdatePrefs } from "../modules/onboarding/use-onboarding";
import { useTeams, WorkspaceShell } from "../modules/workspace/WorkspaceShell";
import "../modules/onboarding/onboarding.css";

/** The guide's sections, in order; the id is the anchor the checklist's "How to" links to. */
export const GUIDE_SECTIONS = ["teams", "projects", "footage", "audio", "video", "chat", "renders", "problems"] as const;

/**
 * `/guide`: how to make a video in Studio, for everyone — teams, projects, footage from the library, voice and music,
 * one video from brief to final, changes by chat, renders, common problems. Each section has an anchor; the list of
 * sections stays at the left on wide screens. Replays the quick tour and brings back the hidden checklist.
 */
export function GuidePage() {
  const { t } = useAiTranslation();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const { data: teams } = useTeams();
  const { data: prefs } = usePrefs();
  const update = useUpdatePrefs();
  const replayTour = useReplayTour(teams?.items ?? []);

  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [hash]);

  const jump = (e: MouseEvent, id: string) => {
    e.preventDefault();
    navigate({ hash: id }, { replace: true });
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <WorkspaceShell crumbs={[{ label: t("ws.guide.title") }]}>
      <main className="ws-page">
        <div className="ws-page__inner ws-guide">
          <div className="ws-page__head">
            <div>
              <h1 className="ws-page__title">{t("ws.guide.title")}</h1>
              <p className="ws-page__lead">{t("ws.guide.lead")}</p>
            </div>
            <div className="ws-page__actions">
              {prefs?.checklistHidden ? (
                <Button icon={<ListChecks size={16} />} onClick={() => update.mutate({ checklistHidden: false })}>{t("ws.guide.showChecklist")}</Button>
              ) : null}
              <Button icon={<Compass size={16} />} onClick={replayTour}>{t("ws.guide.replayTour")}</Button>
            </div>
          </div>
          <div className="ws-guide__layout">
            <nav className="ws-guide__toc" aria-label={t("ws.guide.toc")}>
              <span className="ws-guide__toc-title">{t("ws.guide.toc")}</span>
              <ol>
                {GUIDE_SECTIONS.map((id) => (
                  <li key={id}>
                    <a href={`#${id}`} aria-current={hash === `#${id}` ? "location" : undefined} onClick={(e) => jump(e, id)}>
                      {t(`ws.guide.sections.${id}.title`)}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
            <article className="ws-guide__body">
              {GUIDE_SECTIONS.map((id) => (
                <section key={id} id={id} className="ws-guide__section" aria-labelledby={`${id}-title`}>
                  <h2 id={`${id}-title`}>{t(`ws.guide.sections.${id}.title`)}</h2>
                  <GuideText text={t(`ws.guide.sections.${id}.body`)} />
                </section>
              ))}
            </article>
          </div>
        </div>
      </main>
    </WorkspaceShell>
  );
}
