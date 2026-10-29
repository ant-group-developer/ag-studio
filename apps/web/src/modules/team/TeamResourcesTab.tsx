import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Button, Input, Select } from "antd";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { StudioHttpError, useStudioClient } from "../../api/studio-client";
import "../admin/admin.css";

/**
 * What a team runs on (plan 2026-10-30): its Claude accounts, tried in order (none: the default account), and the
 * farm pool its jobs go to (none: the shared machines). Owners read it; only a Studio admin changes it.
 */
export function TeamResourcesTab({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const key = ["team-resources", teamId];
  const { data } = useQuery({ queryKey: key, queryFn: () => client.getTeamResources(teamId) });
  const { data: all } = useQuery({ queryKey: ["claude-accounts"], queryFn: () => client.listClaudeAccounts(), enabled: isAdmin });
  const { data: farm } = useQuery({ queryKey: ["farm-pools"], queryFn: () => client.listFarmPools(), enabled: isAdmin, staleTime: 60_000 });
  const [ids, setIds] = useState<string[]>([]);
  const [pool, setPool] = useState("");
  useEffect(() => { if (data) { setIds(data.claudeAccounts.map((a) => a.id)); setPool(data.farmPool ?? ""); } }, [data]);
  const save = useMutation({
    mutationFn: () => client.setTeamResources(teamId, { claudeAccountIds: ids, farmPool: pool.trim() || null }),
    onSuccess: (r) => {
      qc.setQueryData(key, r);
      void qc.invalidateQueries({ queryKey: ["claude-accounts"] });
      void message.success(t("ws.teamResources.saved"));
    },
    onError: (e) => void message.error(e instanceof StudioHttpError && e.body?.message ? e.message : t("ws.teamResources.saveFailed")),
  });
  if (!data) return null;
  const changed = ids.join(",") !== data.claudeAccounts.map((a) => a.id).join(",") || (pool.trim() || null) !== data.farmPool;

  return (
    <div className="ws-admin__main">
      <section className="ws-admin__section" aria-label={t("ws.teamResources.claude")}>
        <div className="ws-admin__head"><h2>{t("ws.teamResources.claude")}</h2></div>
        <p className="ws-admin__note">{t("ws.teamResources.claudeHelp")}</p>
        {isAdmin ? (
          <>
            <Select mode="multiple" aria-label={t("ws.teamResources.claude")} style={{ width: "100%", maxWidth: 520 }} value={ids} onChange={setIds}
              placeholder={t("ws.teamResources.usesDefault")}
              options={(all?.accounts ?? []).filter((a) => !a.isDefault).map((a) => ({ value: a.id, label: a.enabled ? a.name : `${a.name} (${t("ws.claudeAccounts.off")})` }))} />
            <p className="ws-admin__note"><Link to="/claude-accounts">{t("ws.teamResources.manageAccounts")}</Link></p>
          </>
        ) : data.claudeAccounts.length ? (
          <ol className="ws-admin__list">{data.claudeAccounts.map((a) => <li key={a.id}>{a.name}{a.enabled ? "" : ` (${t("ws.claudeAccounts.off")})`}</li>)}</ol>
        ) : <p>{t("ws.teamResources.usesDefault")}</p>}
      </section>
      <section className="ws-admin__section" aria-label={t("ws.teamResources.farm")}>
        <div className="ws-admin__head"><h2>{t("ws.teamResources.farm")}</h2></div>
        <p className="ws-admin__note">{t("ws.teamResources.farmHelp")}</p>
        {isAdmin ? (
          <>
            <Input aria-label={t("ws.teamResources.pool")} placeholder={t("ws.teamResources.sharedMachines")} value={pool} maxLength={40} style={{ maxWidth: 320 }}
              onChange={(e) => setPool(e.target.value)} />
            {farm?.pools.length ? (
              <p className="ws-admin__note">{t("ws.teamResources.knownPools", { pools: farm.pools.map((p) => `${p.pool} (${p.machines})`).join(", ") })}</p>
            ) : null}
          </>
        ) : <p>{data.farmPool ? t("ws.teamResources.poolIs", { pool: data.farmPool }) : t("ws.teamResources.sharedMachines")}</p>}
      </section>
      {isAdmin ? <Button type="primary" onClick={() => save.mutate()} disabled={!changed} loading={save.isPending}>{t("ws.teamResources.save")}</Button> : null}
    </div>
  );
}
