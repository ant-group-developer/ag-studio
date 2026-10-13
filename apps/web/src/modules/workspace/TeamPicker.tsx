import { useState } from "react";
import { Select, Spin, type SelectProps } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useStudioClient, type Paged, type Team, type TeamDetail } from "../../api/studio-client";
import { rememberTeam } from "../../helpers/last-team";
import { useDebouncedValue } from "../../helpers/use-debounced-value";

type TeamLike = Pick<Team, "id" | "name" | "isMember">;

/**
 * The team switch of the header, its first crumb: picking a team (the current one too) opens its projects. Everyone sees their teams; a Studio admin also sees "Other teams" (the ones they are
 * not in). Typing searches every team the person may see through the API (`q`), so nothing is cut at the first page.
 */
export function TeamPicker({ value, teams, current, isAdmin, onNewTeam }: {
  /** The team shown as picked (the page's team, or the one worked in last). */
  value: string | null;
  /** The first page of the person's teams (`useTeams`). */
  teams: Paged<Team>;
  /** The page's team as `GET /teams/:id` knows it: listed even when it is not on the first page. */
  current: TeamDetail | undefined;
  isAdmin: boolean;
  onNewTeam: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useStudioClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim(), 250);
  const { data: found, isFetching } = useQuery({
    queryKey: ["teams", "search", q], queryFn: () => client.listTeams({ q, page: 1, pageSize: 50 }), enabled: q.length > 0, staleTime: 30_000,
  });

  const searching = search.trim().length > 0;
  const base: TeamLike[] = searching ? found?.items ?? [] : teams.items;
  const list = !searching && current && !base.some((x) => x.id === current.id) ? [current, ...base] : base;
  const mine = list.filter((x) => x.isMember);
  const others = list.filter((x) => !x.isMember);
  const option = (x: TeamLike) => ({ value: x.id, label: x.name });
  const options: SelectProps["options"] = isAdmin && others.length > 0
    ? [
      ...(mine.length ? [{ label: t("ws.shell.myTeams"), title: t("ws.shell.myTeams"), options: mine.map(option) }] : []),
      { label: t("ws.shell.otherTeams"), title: t("ws.shell.otherTeams"), options: others.map(option) },
    ]
    : list.map(option);
  const more = !searching && teams.total > teams.items.length;
  const close = () => { setOpen(false); setSearch(""); };

  return (
    <Select
      className="ws-crumbs__select" size="small" variant="borderless" value={value} placeholder={t("ws.shell.pickTeam")} popupMatchSelectWidth={280}
      showSearch filterOption={false} searchValue={search} onSearch={setSearch}
      notFoundContent={searching && (isFetching || q !== search.trim()) ? <Spin size="small" /> : t("ws.shell.noTeamFound")}
      options={options}
      onSelect={(id: string) => { rememberTeam(id); close(); navigate(`/t/${id}`); }}
      open={open} onOpenChange={(o) => { if (o) setOpen(true); else close(); }}
      popupRender={(menu) => (
        <>
          {menu}
          {more ? <div className="ws-team-more">{t("ws.shell.searchMore", { total: teams.total })}</div> : null}
          <div className="ws-team-actions">
            <button type="button" className="ws-icon-button" onClick={() => { close(); onNewTeam(); }}>
              <Plus size={14} aria-hidden />{t("ws.shell.newTeam")}
            </button>
            <button type="button" className="ws-icon-button" onClick={() => { close(); navigate("/teams"); }}>
              <Users size={14} aria-hidden />{t("ws.shell.manageTeams")}
            </button>
          </div>
        </>
      )}
      aria-label={t("ws.shell.team")}
    />
  );
}
