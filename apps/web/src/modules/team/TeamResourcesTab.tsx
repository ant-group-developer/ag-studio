import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Alert, Button, Select, Tag, Tooltip } from "antd";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { StudioHttpError, useStudioClient, type ClaudeAccount, type FarmPoolMachine } from "../../api/studio-client";
import "../admin/admin.css";

/**
 * What a team runs on (plan 2026-10-30), all picked, nothing typed: its Claude accounts in the order turns try them
 * (none: the default account), and the farm pool its jobs go to, chosen among the pools the farm has (none: the shared
 * machines). Each choice shows what it means now: an account's state, a pool's machines and which are online.
 * Owners read it; only a Studio admin changes it.
 */
export function TeamResourcesTab({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const key = ["team-resources", teamId];
  const { data } = useQuery({ queryKey: key, queryFn: () => client.getTeamResources(teamId) });
  const { data: all } = useQuery({ queryKey: ["claude-accounts"], queryFn: () => client.listClaudeAccounts(), enabled: isAdmin });
  const { data: farm } = useQuery({ queryKey: ["farm-pools"], queryFn: () => client.listFarmPools(), staleTime: 30_000 });
  const [ids, setIds] = useState<string[]>([]);
  const [pool, setPool] = useState<string | null>(null);
  useEffect(() => { if (data) { setIds(data.claudeAccounts.map((a) => a.id)); setPool(data.farmPool); } }, [data]);
  const save = useMutation({
    mutationFn: () => client.setTeamResources(teamId, { claudeAccountIds: ids, farmPool: pool }),
    onSuccess: (r) => {
      qc.setQueryData(key, r);
      void qc.invalidateQueries({ queryKey: ["claude-accounts"] });
      void message.success(t("ws.teamResources.saved"));
    },
    onError: (e) => void message.error(e instanceof StudioHttpError && e.body?.message ? e.message : t("ws.teamResources.saveFailed")),
  });
  if (!data) return null;
  const changed = ids.join(",") !== data.claudeAccounts.map((a) => a.id).join(",") || pool !== data.farmPool;
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });

  // the accounts as the admin sees them (state, limits); an owner only has the team's own list
  const byId = new Map((all?.accounts ?? []).map((a) => [a.id, a]));
  const chosen = ids.map((id) => byId.get(id) ?? data.claudeAccounts.find((a) => a.id === id)).filter(Boolean) as (Pick<ClaudeAccount, "id" | "name" | "enabled"> & Partial<ClaudeAccount>)[];
  const addable = (all?.accounts ?? []).filter((a) => !a.isDefault && !ids.includes(a.id));
  const move = (i: number, by: number) => setIds((xs) => { const next = [...xs]; [next[i], next[i + by]] = [next[i + by]!, next[i]!]; return next; });

  const machinesOf = (p: string | null): FarmPoolMachine[] | null =>
    !farm?.ok ? null : p === null ? farm.shared : farm.pools.find((x) => x.pool === p)?.machines ?? [];
  const poolLabel = (p: string | null, list: FarmPoolMachine[]) =>
    t(p === null ? "ws.teamResources.sharedOption" : "ws.teamResources.poolOption", { pool: p, n: list.length, online: list.filter((m) => m.online).length });
  const poolOptions = [
    { value: "", label: poolLabel(null, farm?.shared ?? []) },
    ...(farm?.pools ?? []).map((p) => ({ value: p.pool, label: poolLabel(p.pool, p.machines) })),
    // the saved pool is kept even when the farm lists no machine in it any more (or the farm is out of reach)
    ...(pool && !(farm?.pools ?? []).some((p) => p.pool === pool) ? [{ value: pool, label: t("ws.teamResources.poolGone", { pool }) }] : []),
  ];
  const machines = machinesOf(pool);

  return (
    <div className="ws-admin__main ws-resources">
      <section className="ws-admin__section" aria-label={t("ws.teamResources.claude")}>
        <div className="ws-admin__head"><h2>{t("ws.teamResources.claude")}</h2></div>
        <p className="ws-admin__note">{t("ws.teamResources.claudeHelp")}</p>
        {chosen.length ? (
          <ol className="ws-resources__list" aria-label={t("ws.teamResources.order")}>
            {chosen.map((a, i) => (
              <li key={a.id} className="ws-resources__row">
                <span className="ws-resources__order">{i + 1}</span>
                <span className="ws-resources__name">{a.name}</span>
                <AccountState a={a} when={when} />
                {isAdmin ? (
                  <span className="ws-resources__tools">
                    <Tooltip title={t("ws.teamResources.up")}><Button size="small" type="text" icon={<ArrowUp size={14} />} aria-label={t("ws.teamResources.up")} disabled={i === 0} onClick={() => move(i, -1)} /></Tooltip>
                    <Tooltip title={t("ws.teamResources.down")}><Button size="small" type="text" icon={<ArrowDown size={14} />} aria-label={t("ws.teamResources.down")} disabled={i === chosen.length - 1} onClick={() => move(i, 1)} /></Tooltip>
                    <Tooltip title={t("ws.teamResources.remove")}><Button size="small" type="text" icon={<X size={14} />} aria-label={t("ws.teamResources.remove")} onClick={() => setIds((xs) => xs.filter((x) => x !== a.id))} /></Tooltip>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : <p className="ws-resources__empty">{t("ws.teamResources.usesDefault")}</p>}
        {isAdmin ? (
          <div className="ws-resources__add">
            <Select aria-label={t("ws.teamResources.addAccount")} placeholder={t("ws.teamResources.addAccount")} value={null} style={{ width: 320 }}
              options={addable.map((a) => ({ value: a.id, label: a.enabled ? a.name : `${a.name} (${t("ws.claudeAccounts.off")})` }))}
              notFoundContent={t("ws.teamResources.noMoreAccounts")} onChange={(id: string) => setIds((xs) => [...xs, id])} />
            <Link to="/claude-accounts">{t("ws.teamResources.manageAccounts")}</Link>
          </div>
        ) : null}
      </section>

      <section className="ws-admin__section" aria-label={t("ws.teamResources.farm")}>
        <div className="ws-admin__head"><h2>{t("ws.teamResources.farm")}</h2></div>
        <p className="ws-admin__note">{t("ws.teamResources.farmHelp")}</p>
        {isAdmin ? (
          <Select aria-label={t("ws.teamResources.pool")} value={pool ?? ""} style={{ width: 360 }} options={poolOptions}
            onChange={(v: string) => setPool(v || null)} />
        ) : <p><strong>{pool ? t("ws.teamResources.poolIs", { pool }) : t("ws.teamResources.sharedMachines")}</strong></p>}
        {farm && !farm.ok ? <p className="ws-admin__note ws-admin__bad">{t("ws.teamResources.farmDown")}</p> : null}
        {machines?.length ? (
          <ul className="ws-resources__machines" aria-label={t("ws.teamResources.machines")}>
            {machines.map((m) => (
              <li key={m.id}><span className={`ws-resources__dot${m.online ? " ws-resources__dot--on" : ""}`} aria-hidden />{m.name}
                <span className="ws-admin__note"> · {t(m.online ? "ws.queue.online" : "ws.queue.offline")}</span></li>
            ))}
          </ul>
        ) : null}
        {machines && pool && !machines.length ? <Alert type="warning" showIcon message={t("ws.teamResources.poolEmpty", { pool })} /> : null}
        {machines?.length && !machines.some((m) => m.online) ? <Alert type="warning" showIcon message={t("ws.teamResources.allOffline")} /> : null}
        {isAdmin ? <p className="ws-admin__note">{t("ws.teamResources.poolWhere")}</p> : null}
      </section>
      {isAdmin ? (
        <div className="ws-admin__actions">
          <Button type="primary" onClick={() => save.mutate()} disabled={!changed} loading={save.isPending}>{t("ws.teamResources.save")}</Button>
          {changed ? <Button onClick={() => { setIds(data.claudeAccounts.map((a) => a.id)); setPool(data.farmPool); }}>{t("ws.teamResources.reset")}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

/** How an account stands now: off, at its plan's limit, its token refused; nothing when it is fine. */
function AccountState({ a, when }: { a: Pick<ClaudeAccount, "enabled"> & Partial<ClaudeAccount>; when: (iso: string) => string }) {
  const { t } = useTranslation();
  if (!a.enabled) return <Tag>{t("ws.claudeAccounts.off")}</Tag>;
  if (a.rateLimitedUntil && Date.parse(a.rateLimitedUntil) > Date.now()) return <Tag color="orange">{t("ws.teamResources.limitedUntil", { until: when(a.rateLimitedUntil) })}</Tag>;
  if (a.lastError) return <Tooltip title={a.lastError}><Tag color="red">{t("ws.teamResources.hasError")}</Tag></Tooltip>;
  return null;
}
