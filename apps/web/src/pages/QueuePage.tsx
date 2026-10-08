import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  RENDER_MACHINES, useStudioClient, type OverviewItem, type QueueClaudeItem, type QueueRender,
} from "../api/studio-client";
import { ChatShell } from "../modules/chat/ChatShell";
import { AssistantNameForm } from "../modules/chat/AssistantNameForm";
import { ClaudeSettingsForm } from "../modules/chat/ClaudeSettingsForm";
import { stepLabelKey, stepOf } from "../modules/chat/steps";
import { useAiTranslation } from "../modules/common/assistant-name";

/** "m:ss" since `iso`. */
function elapsed(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function useWhere() {
  const { t } = useAiTranslation();
  return (w: { productionTitle: string; episodeIdx: number | null }, step?: string | null) => {
    const label = step ? stepOf(step) : null;
    return [w.productionTitle, w.episodeIdx !== null ? t("chat.queue.episode", { idx: w.episodeIdx }) : null, label ? t(stepLabelKey(label)) : null]
      .filter(Boolean).join(" · ");
  };
}

function ClaudeRow({ item }: { item: QueueClaudeItem }) {
  const { t } = useAiTranslation();
  const where = useWhere();
  const source = t(item.source === "chat" ? "chat.queue.sourceChat" : "chat.queue.sourceStage");
  const meta = item.waiting ? `${t("chat.queue.waitingSlot")} · ${source}` : item.since ? `${elapsed(item.since)} · ${source}` : source;
  const to = item.episodeId ? `/v/${item.productionId}/e/${item.episodeId}` : `/v/${item.productionId}`;
  return (
    <li>
      <div className="chat-queue__row">
        <span className={`chat-badge chat-badge--${item.waiting ? "waiting_you" : "running"}`}>{t(item.waiting ? "chat.queue.waitingSlot" : "chat.queue.running")}</span>
        <Link to={to} className="chat-queue__what">{where(item, item.step)}</Link>
        <span className="chat-queue__meta">{meta}</span>
      </div>
    </li>
  );
}

function RenderRow({ job }: { job: QueueRender }) {
  const { t } = useAiTranslation();
  const where = useWhere();
  const machine = job.pinned ? t("chat.queue.pinnedTo", { name: job.pinned.name ?? job.pinned.id.slice(0, 8) })
    : job.machine ? t(`chat.render.inline.${job.machine}`) : t("chat.queue.unknownMachine");
  const on = job.status === "leased" && job.node ? ` · ${t("chat.queue.onNode", { name: job.node.name ?? job.node.id.slice(0, 8) })}` : "";
  const status = t(`chat.queue.status.${job.status}`, { defaultValue: job.status });
  const extra = job.status === "leased" && job.progress !== null ? ` · ${job.progress}%`
    : job.status === "queued" ? ` · ${t("chat.queue.minutes", { n: Math.max(0, Math.floor((Date.now() - Date.parse(job.createdAt)) / 60_000)) })}` : "";
  const to = job.episodeId ? `/v/${job.productionId}/e/${job.episodeId}` : `/v/${job.productionId}`;
  return (
    <li>
      <div className="chat-queue__row">
        <Link to={to} className="chat-queue__what">{`${where(job)} · ${t(`chat.queue.kinds.${job.kind}`)}`}</Link>
        <span className="chat-queue__meta">{`farm · ${machine} · ${status}${on}${extra}`}</span>
      </div>
      {job.status === "leased" && job.progress !== null ? (
        <div className="chat-progress" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100} aria-label={t("chat.outputs.rendering")}>
          <span style={{ width: `${job.progress}%` }} />
        </div>
      ) : null}
      {job.stuck ? <p className="chat-doc__note chat-outputs__stuck">{t("chat.queue.stuck")}</p> : null}
    </li>
  );
}

/** What waits for the person: productions and episodes at a gate, or with a problem. */
function waitingYou(items: OverviewItem[]) {
  const out: { key: string; to: string; productionTitle: string; episodeIdx: number | null; step: string | null; bad: boolean }[] = [];
  for (const p of items) {
    if (p.step && (p.group === "waiting_you" || p.group === "needs_attention")) {
      out.push({ key: p.id, to: `/v/${p.id}`, productionTitle: p.title, episodeIdx: null, step: p.step, bad: p.group === "needs_attention" });
    }
    for (const e of p.episodes) {
      if (e.group !== "waiting_you" && e.group !== "needs_attention") continue;
      out.push({ key: e.id, to: `/v/${p.id}/e/${e.id}`, productionTitle: p.title, episodeIdx: e.idx, step: e.step, bad: e.group === "needs_attention" });
    }
  }
  return out;
}

/** The Queue (mockup 12): Claude calls, farm render jobs, what waits for you; the Claude cap; machine types. */
export function QueuePage() {
  const { t } = useAiTranslation();
  const client = useStudioClient();
  const where = useWhere();
  const { data: queue } = useQuery({ queryKey: ["queue"], queryFn: () => client.getQueue(), refetchInterval: 5000 });
  const { data: usage } = useQuery({ queryKey: ["claude-usage"], queryFn: () => client.getClaudeUsage(), refetchInterval: 5000 });
  const { data: overview } = useQuery({ queryKey: ["overview"], queryFn: () => client.getOverview(), refetchInterval: 5000 });
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const claude = queue?.claude;
  const waiting = waitingYou(overview?.items ?? []);

  return (
    <ChatShell>
      <main className="chat-main chat-queue">
        <h1>{t("chat.queue.title")}</h1>
        <section aria-label={t("chat.queue.claude")}>
          <div className="chat-queue__head">
            <h2>{t("chat.queue.claude")}</h2>
            {claude ? (
              <span>{`${t("chat.queue.claudeSummary", { running: claude.running, max: claude.max })} · ${claude.waiting ? t("chat.queue.waitingN", { n: claude.waiting }) : t("chat.queue.noneWaiting")}`}</span>
            ) : null}
          </div>
          {claude && claude.items.length ? (
            <ul className="chat-queue__list">{claude.items.map((it, i) => <ClaudeRow key={i} item={it} />)}</ul>
          ) : claude && !claude.hidden ? <p className="chat-doc__note">{t("chat.queue.noClaude")}</p> : null}
          {claude?.hidden ? <p className="chat-doc__note">{t("chat.queue.hiddenClaude", { n: claude.hidden })}</p> : null}
          <p className="chat-doc__note">{t("chat.claude.priority")}</p>
        </section>

        <section aria-label={t("chat.queue.renders")}>
          <div className="chat-queue__head"><h2>{t("chat.queue.renders")}</h2></div>
          {queue && !queue.farm.ok ? <p className="chat-doc__note chat-outputs__stuck">{t("chat.queue.farmDown", { error: queue.farm.error })}</p> : null}
          {queue?.renders.length ? (
            <ul className="chat-queue__list">{queue.renders.map((j) => <RenderRow key={j.farmJobId} job={j} />)}</ul>
          ) : queue?.farm.ok && !queue.hiddenRenders ? <p className="chat-doc__note">{t("chat.queue.noRenders")}</p> : null}
          {queue?.hiddenRenders ? <p className="chat-doc__note">{t("chat.queue.hiddenRenders", { n: queue.hiddenRenders })}</p> : null}
        </section>

        <section aria-label={t("chat.queue.waitingYou")}>
          <div className="chat-queue__head"><h2>{t("chat.queue.waitingYou")}</h2></div>
          {waiting.length ? (
            <div className="chat-queue__chips">
              {waiting.map((w) => (
                <Link key={w.key} to={w.to} className={w.bad ? "chat-queue__chip--bad" : undefined}>{where(w, w.step)}</Link>
              ))}
            </div>
          ) : overview ? <p className="chat-doc__note">{t("chat.queue.noneWaitingYou")}</p> : null}
        </section>
      </main>
      <aside className="chat-aside chat-queue-aside" aria-label={t("chat.queue.title")}>
        {me?.isAdmin ? <><h2>{t("chat.assistant.title")}</h2><AssistantNameForm /></> : null}
        <h2>{t("chat.claude.title")}</h2>
        {usage ? <ClaudeSettingsForm usage={usage} isAdmin={me?.isAdmin ?? false} /> : null}
        <h2>{t("chat.music.title")}</h2>
        <Link to="/music">{t("chat.music.open")}</Link>
        <h2>{t("chat.queue.farmMachines")}</h2>
        {queue?.machines?.length ? (
          <ul className="chat-doc__list chat-queue__machines">
            {queue.machines.map((m) => (
              <li key={m.id}>
                <strong>{m.name}</strong>{m.gpus.some((g) => g.nvenc) ? " · NVENC" : m.gpus.length ? " · GPU" : ""}
                <div className="chat-doc__note">{t("chat.queue.machineLine", { state: t(m.online ? "chat.render.online" : "chat.render.offline"), jobs: m.running_jobs })}</div>
              </li>
            ))}
          </ul>
        ) : queue ? <p className="chat-doc__note">{t("chat.queue.noMachines")}</p> : null}
        <h2>{t("chat.queue.machines")}</h2>
        <p className="chat-doc__note">{t("chat.queue.machinesNote")}</p>
        <ul className="chat-doc__list">
          {RENDER_MACHINES.map((m) => <li key={m}><strong>{t(`chat.render.machines.${m}`)}</strong> — {t(`chat.render.hints.${m}`)}</li>)}
        </ul>
      </aside>
    </ChatShell>
  );
}
