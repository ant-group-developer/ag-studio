import { useEffect, useMemo, useState } from "react";
import { Descriptions, Drawer, Empty, Segmented, Select, Spin, Table, Tag, Tooltip, type TableColumnsType } from "antd";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronRight, FileText, MessageSquare, Wrench, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useStudioClient, type ClaudeTurn, type ClaudeTurnDetail, type ClaudeTurnOutcome, type ClaudeTurnSort, type ClaudeTurnsQuery } from "../../api/studio-client";
import type { AgentPart } from "../../api/workspace-client";
import { toolLabel, toolTarget } from "../agent-chat/labels";
import { useAiTranslation } from "../common/assistant-name";
import { UserCell } from "../common/UserCell";
import { Markdown } from "../files/Markdown";
import { clock } from "../workspace/time";

const PAGE = 50;

/** What the turns are narrowed to, from a row of the stats table: a team, a project, a video (or the project chats), a person. */
export type TurnScope = { label: string } & Pick<ClaudeTurnsQuery, "teamId" | "projectId" | "videoId" | "userId">;

const usd = (n: number) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;
const chatLink = (r: Pick<ClaudeTurn, "projectId" | "videoId" | "threadId">) =>
  r.projectId ? (r.videoId ? `/p/${r.projectId}/v/${r.videoId}` : `/p/${r.projectId}/c/${r.threadId}`) : null;

function Outcome({ outcome }: { outcome: string }) {
  const { t } = useAiTranslation();
  const color = outcome === "accepted" ? "green" : outcome === "rate_limited" ? "gold" : "red";
  return <Tag color={color} bordered={false}>{t(`ws.stats.turn.outcome.${outcome}`, { defaultValue: outcome })}</Tag>;
}

/** One tool call of the turn: what and on what, how long, and its input and answer when opened. */
function ToolStep({ tool }: { tool: ClaudeTurnDetail["tools"][number] }) {
  const { t } = useAiTranslation();
  const [open, setOpen] = useState(false);
  const part = { kind: "tool", id: tool.id, name: tool.name, input: tool.input, started_at: tool.startedAt } as Extract<AgentPart, { kind: "tool" }>;
  const target = toolTarget(part, t);
  const seconds = tool.endedAt ? (Date.parse(tool.endedAt) - Date.parse(tool.startedAt)) / 1000 : null;
  return (
    <li className={`ws-turn__step${tool.isError ? " ws-turn__step--error" : ""}`}>
      <button type="button" className="ws-turn__stephead" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="ws-tool__caret" aria-hidden />
        {tool.isError ? <X size={13} aria-hidden /> : <Check size={13} aria-hidden />}
        {/^(Read|Write|Edit|MultiEdit)$/.test(tool.name) ? <FileText size={13} aria-hidden /> : <Wrench size={13} aria-hidden />}
        <span className="ws-turn__stepname" title={tool.name}>{toolLabel(t, tool.name)}</span>
        {target ? <span className="ws-turn__steptarget" title={target}>{target}</span> : null}
        <span className="ws-turn__steptime">{seconds !== null && Number.isFinite(seconds) ? clock(seconds) : ""}</span>
      </button>
      {open ? (
        <div className="ws-turn__stepbody">
          {tool.input !== null && tool.input !== undefined ? <pre>{JSON.stringify(tool.input, null, 2)}</pre> : null}
          {tool.result ? <pre className={tool.isError ? "ws-turn__bad" : undefined}>{tool.result}</pre> : null}
        </div>
      ) : null}
    </li>
  );
}

/** One turn in full, beside the stats: where and for whom, tokens and cost, what asked, the answer, each step, the files changed. */
function TurnDrawer({ turnId, onClose }: { turnId: string | null; onClose: () => void }) {
  const { t, i18n } = useAiTranslation();
  const client = useStudioClient();
  const q = useQuery({ queryKey: ["claude-turn", turnId], queryFn: () => client.getClaudeTurn(turnId!), enabled: Boolean(turnId) });
  const d = q.data;
  const num = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const link = d ? chatLink(d) : null;
  return (
    <Drawer open={Boolean(turnId)} onClose={onClose} width="min(760px, 100vw)" destroyOnHidden
      title={d ? <span>{t("ws.stats.turn.title")} · {new Date(d.at).toLocaleString(i18n.language)}</span> : t("ws.stats.turn.title")}
      extra={link ? <Link to={link} onClick={onClose}><MessageSquare size={14} style={{ verticalAlign: -2, marginRight: 4 }} />{t("ws.stats.turn.openChat")}</Link> : null}>
      {q.isLoading ? <div className="ws-center"><Spin /></div> : q.error || !d ? <Empty description={t("ws.stats.turn.loadFailed")} /> : (
        <div className="ws-turn">
          <Descriptions size="small" column={2} bordered items={[
            { key: "who", label: t("ws.stats.turn.who"), children: d.user ? <UserCell user={d.user} size={22} /> : (d.userId ?? "—") },
            { key: "where", label: t("ws.stats.turn.where"), children: [d.projectName, d.videoTitle ?? d.threadTitle].filter(Boolean).join(" · ") || "—" },
            { key: "outcome", label: t("ws.stats.turn.result"), children: <><Outcome outcome={d.outcome} />{d.status && d.status !== "done" ? <Tag bordered={false}>{d.status}</Tag> : null}</> },
            { key: "model", label: t("ws.stats.turn.model"), children: d.model },
            { key: "cost", label: t("ws.stats.cost"), children: usd(d.costUsd) },
            { key: "time", label: t("ws.stats.time"), children: clock(d.wallSeconds) },
            { key: "in", label: t("ws.stats.inputTokens"), children: `${num.format(d.inputTokens)} (${t("ws.stats.turn.cacheSplit", { read: num.format(d.cacheReadTokens), write: num.format(d.cacheCreationTokens) })})` },
            { key: "out", label: t("ws.stats.outputTokens"), children: num.format(d.outputTokens) },
            { key: "steps", label: t("ws.stats.turn.steps"), children: `${d.numTurns ?? "—"} · ${t("ws.stats.turn.tools", { count: d.tools.length })}` },
            { key: "attempts", label: t("ws.stats.turn.attempts"), children: d.attempts ?? "—" },
          ]} />
          {d.error ? <p className="ws-turn__error" role="alert"><AlertTriangle size={14} aria-hidden /> {d.error}</p> : null}
          <section>
            <h3>{t("ws.stats.turn.asked")}{d.promptUser ? <span className="ws-hint"> · {d.promptUser.name || d.promptUser.email}</span> : null}</h3>
            {d.promptText ? <div className="ws-turn__msg"><Markdown text={d.promptText} /></div> : <p className="ws-hint">—</p>}
          </section>
          <section>
            <h3>{t("ws.stats.turn.steps")}</h3>
            {d.tools.length ? <ol className="ws-turn__steps">{d.tools.map((x) => <ToolStep key={x.id} tool={x} />)}</ol> : <p className="ws-hint">{t("ws.stats.turn.noTools")}</p>}
          </section>
          <section>
            <h3>{t("ws.stats.turn.answer")}</h3>
            {d.text ? <div className="ws-turn__msg"><Markdown text={d.text} /></div> : <p className="ws-hint">—</p>}
          </section>
          {d.changed.length ? (
            <section>
              <h3>{t("ws.stats.turn.changed", { count: d.changed.length })}</h3>
              <ul className="ws-turn__files">{d.changed.map((f) => <li key={f}><FileText size={13} aria-hidden /> <code>{f}</code></li>)}</ul>
            </section>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

/**
 * The turns behind the stats, one by one: when, who, where, what asked, how it ended, tools, tokens, cost, time;
 * narrowed by a row of the stats table, by outcome, sorted; a turn opens in full.
 */
export function ClaudeTurns({ period, teamId, scope, onClearScope }: {
  period: { from: string; to: string }; teamId?: string | undefined; scope: TurnScope | null; onClearScope: () => void;
}) {
  const { t, i18n } = useAiTranslation();
  const client = useStudioClient();
  const [outcome, setOutcome] = useState<ClaudeTurnOutcome | undefined>();
  const [sortBy, setSortBy] = useState<ClaudeTurnSort>("at");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const { label: _label, ...narrow } = scope ?? { label: "" };
  const query: ClaudeTurnsQuery = {
    ...period, ...(teamId ? { teamId } : {}), ...narrow, ...(outcome ? { outcome } : {}), sortBy, sortOrder: "desc", page, pageSize: PAGE,
  };
  useEffect(() => setPage(1), [period.from, period.to, teamId, scope, outcome, sortBy]);
  const list = useQuery({ queryKey: ["claude-turns", query], queryFn: () => client.listClaudeTurns(query), placeholderData: (prev) => prev });
  const compact = useMemo(() => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }), [i18n.language]);

  const columns: TableColumnsType<ClaudeTurn> = [
    { key: "at", title: t("ws.stats.turn.at"), width: 150, render: (_, r) => new Date(r.at).toLocaleString(i18n.language) },
    { key: "who", title: t("ws.stats.turn.who"), width: 190, render: (_, r) => (r.user ? <UserCell user={r.user} size={22} /> : <span className="ws-hint">{r.userId ?? "—"}</span>) },
    {
      key: "where", title: t("ws.stats.turn.where"), width: 220, render: (_, r) => (
        <div className="ws-turns__where">
          <span>{r.projectName ?? "—"}</span>
          <span className="ws-hint">{r.videoTitle ?? r.threadTitle ?? ""}</span>
        </div>
      ),
    },
    { key: "prompt", title: t("ws.stats.turn.asked"), ellipsis: { showTitle: false }, render: (_, r) => (r.prompt ? <Tooltip title={r.prompt} placement="topLeft"><span>{r.prompt}</span></Tooltip> : <span className="ws-hint">—</span>) },
    { key: "outcome", title: t("ws.stats.turn.result"), width: 120, render: (_, r) => <Outcome outcome={r.outcome} /> },
    { key: "tools", title: t("ws.stats.turn.toolsShort"), width: 80, align: "right", render: (_, r) => r.toolCount },
    { key: "tokens", title: t("ws.stats.tokens"), width: 120, align: "right", render: (_, r) => `${compact.format(r.inputTokens)} / ${compact.format(r.outputTokens)}` },
    { key: "cost", title: t("ws.stats.cost"), width: 90, align: "right", render: (_, r) => usd(r.costUsd) },
    { key: "time", title: t("ws.stats.time"), width: 100, align: "right", render: (_, r) => clock(r.wallSeconds) },
  ];

  return (
    <section className="ws-turns" aria-label={t("ws.stats.turn.list")}>
      <div className="ws-stats__charthead">
        <h2>{t("ws.stats.turn.list")}</h2>
        <span className="ws-hint">{t("ws.stats.turn.count", { count: list.data?.total ?? 0 })}</span>
      </div>
      <div className="ws-stats__controls">
        {scope ? <Tag closable onClose={(e) => { e.preventDefault(); onClearScope(); }} color="blue">{scope.label}</Tag> : <span className="ws-hint">{t("ws.stats.turn.pickRow")}</span>}
        <span className="ws-spacer" />
        <Select allowClear placeholder={t("ws.stats.turn.anyOutcome")} aria-label={t("ws.stats.turn.result")} value={outcome} onChange={setOutcome} style={{ minWidth: 150 }}
          options={(["accepted", "failed", "rate_limited"] as const).map((o) => ({ value: o, label: t(`ws.stats.turn.outcome.${o}`) }))} />
        <Segmented<ClaudeTurnSort> aria-label={t("ws.stats.turn.sort")} value={sortBy} onChange={setSortBy} options={[
          { value: "at", label: t("ws.stats.turn.newest") }, { value: "cost", label: t("ws.stats.cost") },
          { value: "wall", label: t("ws.stats.time") }, { value: "tokens", label: t("ws.stats.tokens") },
        ]} />
      </div>
      <Table<ClaudeTurn>
        rowKey="id" size="small" columns={columns} dataSource={list.data?.items ?? []} loading={list.isFetching} scroll={{ x: 1100 }}
        locale={{ emptyText: t("ws.stats.none") }} rowClassName={() => "ws-turns__row"}
        onRow={(r) => ({ onClick: () => setOpen(r.id), onKeyDown: (e) => { if (e.key === "Enter") setOpen(r.id); }, tabIndex: 0, "aria-label": t("ws.stats.turn.openOne") })}
        pagination={{ current: page, pageSize: PAGE, total: list.data?.total ?? 0, showSizeChanger: false, hideOnSinglePage: true, onChange: setPage }}
      />
      <TurnDrawer turnId={open} onClose={() => setOpen(null)} />
    </section>
  );
}
