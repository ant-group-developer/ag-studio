/**
 * Claude accounts (plan 2026-10-30), Studio admins only: add an account (the token `claude setup-token` prints), how
 * many turns run on it at once, turn it off, check it works, give it a new token. Which team uses which account is set
 * on the team's page (tab "Tài nguyên"). A token is never shown again, only its last 4 characters.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntApp, Button, Form, Input, InputNumber, Popconfirm, Switch } from "antd";
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
  const { data, isLoading, error } = useQuery({
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
          {/* an API without these routes (not rebuilt) answers 404: say so, not "no accounts" */}
          {admin && error && !data ? (
            <p className="ws-admin__note ws-admin__bad">
              {error instanceof StudioHttpError && error.status === 404 ? t("ws.claudeAccounts.apiTooOld") : errorText(error, t("ws.claudeAccounts.loadFailed"))}
            </p>
          ) : null}
          {admin && data && !data.canStoreTokens ? <p className="ws-admin__note ws-admin__bad">{t("ws.claudeAccounts.noSecretKey")}</p> : null}
          {admin && data?.canStoreTokens ? <AddForm /> : null}
          {admin ? (
            <section className="ws-admin__section" aria-label={t("ws.claudeAccounts.list")}>
              <div className="ws-admin__head"><h2>{t("ws.claudeAccounts.list")}</h2></div>
              {data?.accounts.length ? (
                <ul className="ws-admin__list">{data.accounts.map((a) => <AccountRow key={a.id} account={a} canStoreTokens={data.canStoreTokens} />)}</ul>
              ) : isLoading || error ? null : <p className="ws-admin__note">{t("ws.claudeAccounts.empty")}</p>}
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
  const [form] = Form.useForm<AddValues>();
  const add = useMutation({
    mutationFn: (v: AddValues) => client.createClaudeAccount({ name: v.name.trim(), token: v.token.trim(), maxConcurrent: v.maxConcurrent ?? null }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      void message.success(t("ws.claudeAccounts.added", { name: a.name }));
      form.resetFields();
    },
    onError: (e) => void message.error(errorText(e, t("ws.claudeAccounts.saveFailed"))),
  });
  return (
    <section className="ws-admin__section" aria-label={t("ws.claudeAccounts.add")}>
      <div className="ws-admin__head"><h2>{t("ws.claudeAccounts.add")}</h2></div>
      {/* each field with its label, what it is for, and what it needs (checked here; the API checks again) */}
      <Form form={form} layout="vertical" requiredMark onFinish={(v) => add.mutate(v)} className="ws-admin__fields">
        <Form.Item name="name" label={t("ws.claudeAccounts.name")} extra={t("ws.claudeAccounts.nameHelp")}
          rules={[{ required: true, whitespace: true, message: t("ws.claudeAccounts.nameRequired") }, { max: 60, message: t("ws.claudeAccounts.nameTooLong") }]}>
          <Input placeholder={t("ws.claudeAccounts.namePlaceholder")} maxLength={60} />
        </Form.Item>
        <Form.Item name="token" label={t("ws.claudeAccounts.token")} extra={t("ws.claudeAccounts.tokenHelp")}
          rules={[{ required: true, whitespace: true, message: t("ws.claudeAccounts.tokenRequired") }, tokenRule(t)]}>
          <Input.Password placeholder={t("ws.claudeAccounts.tokenPlaceholder")} autoComplete="off" visibilityToggle={false} />
        </Form.Item>
        <Form.Item name="maxConcurrent" label={t("ws.claudeAccounts.max")} extra={t("ws.claudeAccounts.maxHelp")}
          rules={[{ type: "integer", min: 1, max: 100, message: t("ws.claudeAccounts.maxRange") }]}>
          <InputNumber placeholder={t("ws.claudeAccounts.maxPlaceholder")} min={1} max={100} precision={0} style={{ width: 200 }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={add.isPending}>{t("ws.claudeAccounts.addButton")}</Button>
      </Form>
    </section>
  );
}

interface AddValues { name: string; token: string; maxConcurrent?: number | null }
interface EditValues { name: string; maxConcurrent?: number | null; token?: string }

/** A token is the one line `claude setup-token` prints: no spaces inside, at most 2000 characters (as the API checks). */
function tokenRule(t: (k: string) => string) {
  return {
    validator: (_: unknown, v: string | undefined) => {
      const s = v?.trim() ?? "";
      return !s || (!/\s/.test(s) && s.length <= 2000) ? Promise.resolve() : Promise.reject(new Error(t("ws.claudeAccounts.tokenInvalid")));
    },
  };
}

function AccountRow({ account: a, canStoreTokens }: { account: ClaudeAccount; canStoreTokens: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm<EditValues>();
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const done = () => void qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof client.updateClaudeAccount>[1]) => client.updateClaudeAccount(a.id, patch),
    onSuccess: () => { done(); setEditing(false); },
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
        {/* renamed: still say it is the default one */}
        {a.isDefault && a.name.toLowerCase() !== t("ws.claudeAccounts.default").toLowerCase() ? <span className="ws-admin__note"> · {t("ws.claudeAccounts.default")}</span> : null}
        {a.enabled ? null : <span className="ws-admin__note"> · {t("ws.claudeAccounts.off")}</span>}
        <div className="ws-admin__note">
          {a.isDefault ? t("ws.claudeAccounts.defaultToken") : t("ws.claudeAccounts.tokenEnds", { hint: a.tokenHint ?? "····" })}
          {" · "}{a.maxConcurrent === null ? t("ws.claudeAccounts.runningNoCap", { running: a.running ?? 0 }) : t("ws.claudeAccounts.runningLine", { running: a.running ?? 0, max: a.maxConcurrent })}
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
          <Form form={form} layout="vertical" requiredMark className="ws-admin__fields ws-admin__fields--edit"
            initialValues={{ name: a.name, maxConcurrent: a.maxConcurrent, token: "" }}
            onFinish={(v) => {
              const name = v.name.trim(); const max = v.maxConcurrent ?? null; const token = v.token?.trim() ?? "";
              update.mutate({ ...(name !== a.name ? { name } : {}), ...(max !== a.maxConcurrent ? { maxConcurrent: max } : {}), ...(token ? { token } : {}) });
            }}>
            <Form.Item name="name" label={t("ws.claudeAccounts.name")}
              rules={[{ required: true, whitespace: true, message: t("ws.claudeAccounts.nameRequired") }, { max: 60, message: t("ws.claudeAccounts.nameTooLong") }]}>
              <Input maxLength={60} />
            </Form.Item>
            <Form.Item name="maxConcurrent" label={t("ws.claudeAccounts.max")} rules={[{ type: "integer", min: 1, max: 100, message: t("ws.claudeAccounts.maxRange") }]}>
              <InputNumber placeholder={t("ws.claudeAccounts.maxPlaceholder")} min={1} max={100} precision={0} style={{ width: 200 }} />
            </Form.Item>
            {!a.isDefault && canStoreTokens ? (
              <Form.Item name="token" label={t("ws.claudeAccounts.newToken")} rules={[tokenRule(t)]}>
                <Input.Password autoComplete="off" visibilityToggle={false} />
              </Form.Item>
            ) : null}
            <div className="ws-admin__actions">
              <Button type="primary" htmlType="submit" loading={update.isPending}>{t("ws.claudeAccounts.save")}</Button>
              <Button onClick={() => { setEditing(false); form.resetFields(); }}>{t("ws.claudeAccounts.cancel")}</Button>
            </div>
          </Form>
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
