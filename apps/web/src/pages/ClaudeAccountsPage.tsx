/**
 * Claude accounts (plan 2026-10-30), Studio admins only: add an account (the token `claude setup-token` prints), how
 * many turns run on it at once, turn it off, check it works, give it a new token. Which team uses which account is set
 * on the team's page (tab "Tài nguyên"). A token is never shown again, only its last 4 characters.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Button, Input, InputNumber, Popconfirm, Switch } from "antd";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { StudioHttpError, useStudioClient, type ClaudeAccount } from "../api/studio-client";
import { WorkspaceShell } from "../modules/workspace/WorkspaceShell";
import "../modules/admin/admin.css";

const ACCOUNTS_KEY = ["claude-accounts"];

function errorText(e: unknown, fallback: string): string {
  return e instanceof StudioHttpError && e.body?.message ? e.message : fallback;
}

export function ClaudeAccountsPage() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const admin = me?.isAdmin ?? false;
  // a check runs on a worker: look again until it says how it went
  const { data, isLoading } = useQuery({
    queryKey: ACCOUNTS_KEY, queryFn: () => client.listClaudeAccounts(), enabled: admin,
    refetchInterval: (q) => (q.state.data?.accounts.some((a) => a.check.requestedAt && (!a.check.at || a.check.at < a.check.requestedAt || !a.check.status)) ? 3000 : 15_000),
  });

  return (
    <WorkspaceShell crumbs={[{ label: t("ws.claudeAccounts.title") }]}>
      <main className="ws-page">
        <div className="ws-page__inner ws-admin__main">
          <div className="ws-page__head">
            <div>
              <h1 className="ws-page__title">{t("ws.claudeAccounts.title")}</h1>
              <p className="ws-page__lead">{t("ws.claudeAccounts.intro")}</p>
            </div>
          </div>
          {me && !admin ? <p className="ws-admin__note">{t("ws.claudeAccounts.adminOnly")}</p> : null}
          {admin && data && !data.canStoreTokens ? <p className="ws-admin__note ws-admin__bad">{t("ws.claudeAccounts.noSecretKey")}</p> : null}
          {admin && data?.canStoreTokens ? <AddForm /> : null}
          {admin ? (
            <section className="ws-admin__section" aria-label={t("ws.claudeAccounts.list")}>
              <div className="ws-admin__head"><h2>{t("ws.claudeAccounts.list")}</h2></div>
              {data?.accounts.length ? (
                <ul className="ws-admin__list">{data.accounts.map((a) => <AccountRow key={a.id} account={a} canStoreTokens={data.canStoreTokens} />)}</ul>
              ) : isLoading ? null : <p className="ws-admin__note">{t("ws.claudeAccounts.empty")}</p>}
            </section>
          ) : null}
        </div>
      </main>
    </WorkspaceShell>
  );
}

function AddForm() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [max, setMax] = useState<number | null>(null);
  const add = useMutation({
    mutationFn: () => client.createClaudeAccount({ name: name.trim(), token: token.trim(), maxConcurrent: max }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      void message.success(t("ws.claudeAccounts.added", { name: a.name }));
      setName(""); setToken(""); setMax(null);
    },
    onError: (e) => void message.error(errorText(e, t("ws.claudeAccounts.saveFailed"))),
  });
  const ready = name.trim() && token.trim();
  return (
    <section className="ws-admin__section" aria-label={t("ws.claudeAccounts.add")}>
      <div className="ws-admin__head"><h2>{t("ws.claudeAccounts.add")}</h2></div>
      <form className="ws-admin__form" onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate(); }}>
        <Input aria-label={t("ws.claudeAccounts.name")} placeholder={t("ws.claudeAccounts.namePlaceholder")} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <Input.Password aria-label={t("ws.claudeAccounts.token")} placeholder={t("ws.claudeAccounts.tokenPlaceholder")} value={token} autoComplete="off"
          visibilityToggle={false} onChange={(e) => setToken(e.target.value)} />
        <InputNumber aria-label={t("ws.claudeAccounts.max")} placeholder={t("ws.claudeAccounts.maxPlaceholder")} min={1} max={100} precision={0} value={max}
          onChange={(v) => setMax(v)} style={{ width: 200 }} />
        <Button type="primary" htmlType="submit" disabled={!ready} loading={add.isPending}>{t("ws.claudeAccounts.addButton")}</Button>
        <p className="ws-admin__note">{t("ws.claudeAccounts.tokenHelp")}</p>
      </form>
    </section>
  );
}

function AccountRow({ account: a, canStoreTokens }: { account: ClaudeAccount; canStoreTokens: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);
  const [max, setMax] = useState<number | null>(a.maxConcurrent);
  const [token, setToken] = useState("");
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const done = () => void qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof client.updateClaudeAccount>[1]) => client.updateClaudeAccount(a.id, patch),
    onSuccess: () => { done(); setEditing(false); setToken(""); },
    onError: (e) => void message.error(errorText(e, t("ws.claudeAccounts.saveFailed"))),
  });
  const check = useMutation({ mutationFn: () => client.checkClaudeAccount(a.id), onSuccess: done, onError: (e) => void message.error(errorText(e, t("ws.claudeAccounts.saveFailed"))) });
  const remove = useMutation({ mutationFn: () => client.deleteClaudeAccount(a.id), onSuccess: done, onError: (e) => void message.error(errorText(e, t("ws.claudeAccounts.saveFailed"))) });
  const limited = a.rateLimitedUntil && Date.parse(a.rateLimitedUntil) > Date.now();
  const checking = a.check.requestedAt && (!a.check.status || !a.check.at || a.check.at < a.check.requestedAt);

  return (
    <li className="ws-admin__track" aria-label={a.name}>
      <div>
        <strong>{a.name}</strong>
        {a.isDefault ? <span className="ws-admin__note"> · {t("ws.claudeAccounts.default")}</span> : null}
        {a.enabled ? null : <span className="ws-admin__note"> · {t("ws.claudeAccounts.off")}</span>}
        <div className="ws-admin__note">
          {a.isDefault ? t("ws.claudeAccounts.defaultToken") : t("ws.claudeAccounts.tokenEnds", { hint: a.tokenHint ?? "····" })}
          {" · "}{t("ws.claudeAccounts.runningLine", { running: a.running ?? 0, max: a.maxConcurrent ?? t("ws.claudeAccounts.noCap") })}
          {a.lastUsedAt ? ` · ${t("ws.claudeAccounts.lastUsed", { at: when(a.lastUsedAt) })}` : ""}
        </div>
        <div className="ws-admin__note">
          {a.teams.length
            ? <>{t("ws.claudeAccounts.teams")}{" "}{a.teams.map((x, i) => <span key={x.id}>{i ? ", " : ""}<Link to={`/teams/${x.id}`}>{x.name}</Link></span>)}</>
            : t(a.isDefault ? "ws.claudeAccounts.defaultTeams" : "ws.claudeAccounts.noTeams")}
        </div>
        {limited ? <div className="ws-admin__note ws-admin__bad">{t("ws.claudeAccounts.limited", { until: when(a.rateLimitedUntil!) })}</div> : null}
        {a.lastError ? <div className="ws-admin__note ws-admin__bad">{t("ws.claudeAccounts.lastError", { error: a.lastError })}</div> : null}
        {checking ? <div className="ws-admin__note">{t("ws.claudeAccounts.checking")}</div>
          : a.check.status ? (
            <div className={`ws-admin__note${a.check.status === "ok" ? "" : " ws-admin__bad"}`}>
              {t(`ws.claudeAccounts.check.${a.check.status}`, { at: when(a.check.at!), error: a.check.error ?? "" })}
            </div>
          ) : null}
        {editing ? (
          <form className="ws-admin__form" onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ ...(name.trim() !== a.name ? { name: name.trim() } : {}), ...(max !== a.maxConcurrent ? { maxConcurrent: max } : {}), ...(token.trim() ? { token: token.trim() } : {}) });
          }}>
            <Input aria-label={t("ws.claudeAccounts.name")} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <InputNumber aria-label={t("ws.claudeAccounts.max")} placeholder={t("ws.claudeAccounts.maxPlaceholder")} min={1} max={100} precision={0} value={max}
              onChange={(v) => setMax(v)} style={{ width: 200 }} />
            {!a.isDefault && canStoreTokens ? (
              <Input.Password aria-label={t("ws.claudeAccounts.newToken")} placeholder={t("ws.claudeAccounts.newToken")} value={token} autoComplete="off"
                visibilityToggle={false} onChange={(e) => setToken(e.target.value)} />
            ) : null}
            <Button type="primary" htmlType="submit" disabled={!name.trim()} loading={update.isPending}>{t("ws.claudeAccounts.save")}</Button>
            <Button onClick={() => { setEditing(false); setName(a.name); setMax(a.maxConcurrent); setToken(""); }}>{t("ws.claudeAccounts.cancel")}</Button>
          </form>
        ) : null}
      </div>
      <Switch checked={a.enabled} loading={update.isPending} aria-label={t("ws.claudeAccounts.enabled")} onChange={(enabled) => update.mutate({ enabled })} />
      <Button size="small" onClick={() => check.mutate()} loading={check.isPending} disabled={!!checking}>{t("ws.claudeAccounts.checkButton")}</Button>
      {editing ? null : <Button size="small" onClick={() => setEditing(true)}>{t("ws.claudeAccounts.edit")}</Button>}
      {a.isDefault ? null : (
        <Popconfirm title={t("ws.claudeAccounts.deleteConfirm", { name: a.name })} onConfirm={() => remove.mutate()} okText={t("ws.claudeAccounts.delete")} cancelText={t("ws.claudeAccounts.cancel")}>
          <Button size="small" danger loading={remove.isPending}>{t("ws.claudeAccounts.delete")}</Button>
        </Popconfirm>
      )}
    </li>
  );
}
