import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useStudioClient, type OverviewGroup, type OverviewItem } from "../../api/studio-client";
import { stepLabelKey, stepOf } from "./steps";

export function GroupBadge({ group }: { group: OverviewGroup }) {
  const { t } = useTranslation();
  return <span className={`chat-badge chat-badge--${group}`}>{t(`chat.groups.${group}`)}</span>;
}

function StepText({ stage }: { stage: string | null }) {
  const { t } = useTranslation();
  const step = stepOf(stage);
  return step ? <span className="chat-nav__step">{t(stepLabelKey(step))}</span> : null;
}

/** Left column (mockup): "Video mới", then every video series → episodes, each with its step and what it needs. */
export function VideoTree({ productionId, episodeId }: { productionId?: string | undefined; episodeId?: string | undefined }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => client.getOverview(), refetchInterval: 5000 });
  const items: OverviewItem[] = data?.items ?? [];
  return (
    <nav className="chat-nav" aria-label={t("chat.yourVideos")}>
      <Link to="/" className="chat-nav__new"><Plus size={18} aria-hidden />{t("chat.newVideo")}</Link>
      <p className="chat-nav__label">{t("chat.yourVideos")}</p>
      {items.map((p) => (
        <div key={p.id}>
          <Link to={`/v/${p.id}`} className="chat-nav__item" aria-current={p.id === productionId && !episodeId ? "page" : undefined}>
            <span className="chat-nav__text">{p.title}<StepText stage={p.step} /></span>
            <GroupBadge group={p.group} />
          </Link>
          {p.episodes.map((e) => (
            <Link key={e.id} to={`/v/${p.id}/e/${e.id}`} className="chat-nav__item chat-nav__item--episode" aria-current={e.id === episodeId ? "page" : undefined}>
              <span className="chat-nav__text">{t("chat.episodeTitle", { idx: e.idx, title: e.title })}<StepText stage={e.step} /></span>
              <GroupBadge group={e.group} />
            </Link>
          ))}
        </div>
      ))}
      {data && items.length === 0 ? <p className="chat-nav__label">{t("chat.noVideos")}</p> : null}
    </nav>
  );
}
