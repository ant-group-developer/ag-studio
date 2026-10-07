import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ListOrdered, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
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

/** Episodes that wait for the person or have a problem: they keep their series open. */
const CALLS: ReadonlySet<OverviewGroup> = new Set(["waiting_you", "needs_attention"]);

/** One video series and its episodes, a block of its own; the episodes fold under the series. */
function SeriesBlock({ p, productionId, episodeId }: { p: OverviewItem; productionId?: string | undefined; episodeId?: string | undefined }) {
  const { t } = useTranslation();
  const active = p.id === productionId;
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (active || p.episodes.some((e) => CALLS.has(e.group)));
  const has = p.episodes.length > 0;
  return (
    <li className={active ? "chat-nav__series chat-nav__series--active" : "chat-nav__series"}>
      <div className="chat-nav__series-head">
        <Link to={`/v/${p.id}`} className="chat-nav__item" aria-current={active && !episodeId ? "page" : undefined}>
          <span className="chat-nav__text">
            <span className="chat-nav__title">{p.title}</span>
            <StepText stage={p.step} />
          </span>
          <GroupBadge group={p.group} />
        </Link>
        {has ? (
          <button type="button" className="chat-nav__fold" aria-expanded={expanded}
            aria-label={t(expanded ? "chat.nav.collapse" : "chat.nav.expand", { title: p.title })} onClick={() => setOpen(!expanded)}>
            <ChevronRight size={16} aria-hidden />
          </button>
        ) : null}
      </div>
      {has && !expanded ? (
        <button type="button" className="chat-nav__summary" onClick={() => setOpen(true)}>
          {t("chat.nav.episodeCount", { count: p.episodes.length })}
        </button>
      ) : null}
      {has && expanded ? (
        <ul className="chat-nav__episodes">
          {p.episodes.map((e) => (
            <li key={e.id}>
              <Link to={`/v/${p.id}/e/${e.id}`} className="chat-nav__item chat-nav__item--episode" aria-current={e.id === episodeId ? "page" : undefined}>
                <span className="chat-nav__text">{t("chat.episodeTitle", { idx: e.idx, title: e.title })}<StepText stage={e.step} /></span>
                <GroupBadge group={e.group} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Left column (mockup): "Video mới", then every video series → episodes, each with its step and what it needs. */
export function VideoTree({ productionId, episodeId }: { productionId?: string | undefined; episodeId?: string | undefined }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { pathname } = useLocation();
  const [query, setQuery] = useState("");
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => client.getOverview(), refetchInterval: 5000 });
  const items: OverviewItem[] = data?.items ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? items.filter((p) => p.title.toLowerCase().includes(needle) || p.episodes.some((e) => e.title.toLowerCase().includes(needle)))
    : items;
  return (
    <nav className="chat-nav" aria-label={t("chat.yourVideos")}>
      <div className="chat-nav__top">
        <Link to="/" className="chat-nav__new"><Plus size={18} aria-hidden />{t("chat.newVideo")}</Link>
        {items.length > 5 ? (
          <label className="chat-nav__search">
            <Search size={15} aria-hidden />
            <span className="chat-sr-only">{t("chat.nav.search")}</span>
            <input type="search" value={query} placeholder={t("chat.nav.search")} onChange={(e) => setQuery(e.target.value)} />
          </label>
        ) : null}
      </div>
      <div className="chat-nav__scroll">
        <p className="chat-nav__label">{t("chat.yourVideos")}{items.length ? <span>{items.length}</span> : null}</p>
        <ul className="chat-nav__list">
          {shown.map((p) => <SeriesBlock key={p.id} p={p} productionId={productionId} episodeId={episodeId} />)}
        </ul>
        {data && items.length === 0 ? <p className="chat-nav__empty">{t("chat.noVideos")}</p> : null}
        {items.length > 0 && shown.length === 0 ? <p className="chat-nav__empty">{t("chat.nav.noMatch")}</p> : null}
      </div>
      <div className="chat-nav__bottom">
        <Link to="/queue" className="chat-nav__queue" aria-current={pathname === "/queue" ? "page" : undefined}>
          <ListOrdered size={16} aria-hidden />{t("chat.queue.nav")}
        </Link>
      </div>
    </nav>
  );
}
