import { useEffect, useRef, useState } from "react";
import { Tour, type TourProps } from "antd";
import { useLocation, useNavigate } from "react-router-dom";
import type { Team } from "../../api/studio-client";
import { rememberedTeam } from "../../helpers/last-team";
import { useAiTranslation } from "../common/assistant-name";
import { usePrefs, useUpdatePrefs } from "./use-onboarding";

export type TourKind = "projects" | "project";

/** The places each tour points at (`data-tour` on the element), in order; the words are `ws.tour.<kind>.<place>`. */
export const TOUR_STOPS: Record<TourKind, string[]> = {
  projects: ["team", "new-project", "start", "guide"],
  project: ["new-video", "steps", "composer", "tab-inputs", "tab-preview", "tab-files"],
};

const target = (place: string) => document.querySelector<HTMLElement>(`[data-tour="${place}"]`);

/**
 * A short tour of the page the first time the person opens it (projects list, project): it points at what is on the
 * page only (a button their role does not have is skipped) and is marked seen when closed or finished.
 */
export function ProductTour({ kind, ready }: { kind: TourKind; ready: boolean }) {
  const { t } = useAiTranslation();
  const { data: prefs } = usePrefs();
  const update = useUpdatePrefs();
  const [steps, setSteps] = useState<NonNullable<TourProps["steps"]>>([]);
  const [current, setCurrent] = useState(0);
  const closed = useRef(false);
  const unseen = !!prefs && !prefs.tourSeen[kind];

  useEffect(() => {
    if (!ready || !unseen) return;
    closed.current = false;
    // let the page lay out first, so the targets are where they will stay
    const timer = window.setTimeout(() => {
      const shown = TOUR_STOPS[kind].filter((place) => target(place));
      setCurrent(0);
      setSteps(shown.map((place) => ({
        title: t(`ws.tour.${kind}.${place}.title`),
        description: t(`ws.tour.${kind}.${place}.description`),
        target: () => target(place) ?? document.body,
      })));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [ready, unseen, kind, t]);

  const close = () => {
    setSteps([]);
    if (closed.current) return;
    closed.current = true;
    update.mutate({ tourSeen: { [kind]: true } });
  };
  if (steps.length === 0) return null;
  return <Tour open steps={steps} current={current} onChange={setCurrent} onClose={close} onFinish={close} />;
}

/**
 * "Replay the quick tour": every tour unseen again, then a page that has one — this page when it does, else the
 * projects of the team worked in last (home when the person is in no team).
 */
export function useReplayTour(teams: Team[]): () => void {
  const update = useUpdatePrefs();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return () => {
    update.mutate({ tourSeen: { projects: false, project: false } });
    if (/^\/(t|p)\//.test(pathname)) return;
    const team = teams.find((x) => x.id === rememberedTeam()) ?? teams.find((x) => x.isMember) ?? teams[0];
    navigate(team ? `/t/${team.id}` : "/");
  };
}
