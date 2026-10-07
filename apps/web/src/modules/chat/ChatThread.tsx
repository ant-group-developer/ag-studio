import { Fragment, useState } from "react";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatThreadView, ChatTurn, RenderMachine } from "../../api/studio-client";
import { RenderMachinePicker } from "../render/RenderMachinePicker";
import { messageParts } from "./mentions";
import { episodeStepsFor, PLAN_STEPS, stepLabelKey, stepOf, stepPosition, type ChatStep } from "./steps";

/** What a card under Claude's newest reply asks the person to confirm (spec local-chat §2.5). */
export type ChatCard = "approve" | "start" | "apply" | "render" | "renderFinal" | "export" | "retry";
/** Approving the YouTube kit starts the final render, so its card carries the machine type (phase 3). */
export const KIT_GATE = "approve-youtube-kit";
export interface CardOptions { renderMachine: RenderMachine }

interface Props {
  thread: ChatThreadView;
  /** Called when a card's button is pressed; the kit's approve card adds the machine type picked. */
  onCard: (card: ChatCard, turn: ChatTurn, options?: CardOptions) => void;
  /** Where the machine picker starts (the episode's `render.defaultMachine`). */
  renderDefault?: RenderMachine | undefined;
  /** A quick answer chip was pressed (intake questions). */
  onQuickAnswer?: ((text: string) => void) | undefined;
  busyCard?: ChatCard | null | undefined;
  /** Episode thread (render / export cards make sense there). */
  episode?: boolean | undefined;
  /** The episode run's workflow (`id@version`): a shot-cut episode has its own steps. */
  workflow?: string | null | undefined;
  /** A line a step's divider adds ("tự động · 24 video, 112 shot"). */
  notes?: Partial<Record<ChatStep, string>> | undefined;
}

interface Section { stageKey: string; turns: ChatTurn[] }

function sections(turns: ChatTurn[], workflow: string | null | undefined): Section[] {
  const out: Section[] = [];
  for (const t of turns) {
    const step = stepOf(t.stage_key, workflow);
    const last = out.at(-1);
    if (last && stepOf(last.stageKey, workflow) === step) last.turns.push(t);
    else out.push({ stageKey: t.stage_key, turns: [t] });
  }
  return out;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Message({ text }: { text: string }) {
  return (
    <>
      {messageParts(text).map((p, i) => (p.kind === "folder" ? <span key={i} className="chat-mention">@{p.name}</span> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}

/** The card a reply carries, if it is the newest reply of the step the production is at. */
function cardFor(turn: ChatTurn, thread: ChatThreadView, episode: boolean): ChatCard | null {
  if (turn.role !== "assistant" || turn.status !== "done") return null;
  const scope = thread.scope;
  if (!scope || scope.stageKey !== turn.stage_key) return null;
  if (thread.current?.pendingApply && thread.current.turnId === turn.id) return "apply";
  if (scope.scope === "failed") return "retry";
  if (turn.action === "suggest_approve") return scope.scope === "intake" ? "start" : scope.scope === "gate" ? "approve" : null;
  if (episode && turn.action === "render") return "render";
  if (episode && turn.action === "export") return "export";
  return null;
}

function KitRenderCard({ turn, busy, initial, onCard }: { turn: ChatTurn; busy: boolean; initial: RenderMachine; onCard: Props["onCard"] }) {
  const { t } = useTranslation();
  const [machine, setMachine] = useState<RenderMachine>(initial);
  return (
    <div className="chat-card chat-card--column">
      <span>{t("chat.cards.approveRender.question")}</span>
      <RenderMachinePicker value={machine} onChange={setMachine} />
      <button type="button" className="chat-card__button" disabled={busy} onClick={() => onCard("approve", turn, { renderMachine: machine })}>
        {t("chat.cards.approveRender.button")}
      </button>
    </div>
  );
}

/** The chat (mockup screens 2–13): messages by step, dividers, Claude's state, and confirm cards. */
export function ChatThread({ thread, onCard, onQuickAnswer, busyCard, episode = false, renderDefault = "any", workflow, notes }: Props) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const all = sections(thread.turns, workflow);
  // the step the production is at shows its divider even before anyone wrote in it
  const at = thread.scope && thread.scope.scope !== "intake" ? thread.scope.stageKey : null;
  if (at && !all.some((sec) => stepOf(sec.stageKey, workflow) === stepOf(at, workflow))) all.push({ stageKey: at, turns: [] });
  const newestReply = [...thread.turns].reverse().find((x) => x.role === "assistant");
  const row = episode ? episodeStepsFor(workflow) : PLAN_STEPS;

  return (
    <div className="chat-thread" aria-live="polite">
      {all.map((sec, i) => {
        const step = stepOf(sec.stageKey, workflow);
        const note = step ? notes?.[step] : undefined;
        const current = thread.scope?.stageKey === sec.stageKey || (i === all.length - 1 && !thread.scope);
        const n = stepPosition(step, row);
        const state = current
          ? thread.scope?.scope === "failed" ? t("chat.thread.needsAttention") : thread.scope ? t("chat.thread.yourTurn") : ""
          : t("chat.thread.done");
        const tone = !current ? "done" : thread.scope?.scope === "failed" ? "bad" : thread.scope ? "now" : "idle";
        const collapsed = !!step && step !== "intake" && !current && !opened.has(i) && i < all.length - 1;
        return (
          <section key={`${sec.stageKey}-${i}`} className="chat-thread__section">
            {step && step !== "intake" ? (
              <div className={`chat-divider chat-divider--${tone}`}>
                <span>
                  {n >= 0 ? `${t("chat.thread.step", { n: n + 1 })} · ` : ""}{t(stepLabelKey(step))}{note ? ` · ${note}` : ""}{state ? ` · ${state}` : ""}
                  {collapsed ? <> · <button type="button" className="chat-link-button" onClick={() => setOpened(new Set(opened).add(i))}>{t("chat.thread.show")}</button></> : null}
                </span>
              </div>
            ) : null}
            {collapsed ? null : sec.turns.map((turn) => {
              if (turn.role === "user") return <div key={turn.id} className="chat-bubble"><Message text={turn.text} /></div>;
              if (turn.role === "system") return <p key={turn.id} className="chat-system">{turn.text}</p>;
              const card = cardFor(turn, thread, episode);
              const questions = (turn.proposal as { questions?: { options?: string[] }[] } | null)?.questions;
              const options = turn.id === newestReply?.id && turn.scope === "intake" ? questions?.[0]?.options ?? [] : [];
              return (
                <div key={turn.id} className="chat-reply">
                  <p className="chat-reply__who"><span className="chat-reply__avatar" aria-hidden><Sparkles size={12} /></span>Claude</p>
                  {turn.status === "pending" ? (
                    <p className="chat-reply__wait">{thread.queueAhead > 0 ? t("chat.thread.queued", { n: thread.queueAhead }) : t("chat.thread.writing")}</p>
                  ) : turn.status === "running" ? (
                    <p className="chat-reply__wait">{t("chat.thread.writing")}</p>
                  ) : turn.status === "rate_limited" ? (
                    <p className="chat-reply__wait">{t("chat.thread.rateLimited", { at: turn.not_before ? hhmm(turn.not_before) : "" })}</p>
                  ) : (
                    <p className={turn.status === "failed" ? "chat-reply__text chat-reply__text--failed" : "chat-reply__text"}>{turn.text}</p>
                  )}
                  {turn.problems.length > 0 ? (
                    <div className="chat-reply__problems">
                      <p>{t("chat.thread.couldNotFix")}</p>
                      <ul>{turn.problems.map((p, k) => <li key={k}>{p.message}</li>)}</ul>
                    </div>
                  ) : null}
                  {options.length > 0 && onQuickAnswer ? (
                    <div className="chat-quick">
                      {options.map((o) => <button key={o} type="button" onClick={() => onQuickAnswer(o)}>{o}</button>)}
                    </div>
                  ) : null}
                  {card === "approve" && turn.stage_key === KIT_GATE ? (
                    <KitRenderCard key={renderDefault} turn={turn} busy={busyCard === card} initial={renderDefault} onCard={onCard} />
                  ) : card === "render" ? (
                    <div className="chat-card">
                      <span>{t("chat.cards.render.question")}</span>
                      <button type="button" className="chat-card__button" disabled={busyCard === "render"} onClick={() => onCard("render", turn)}>
                        {t("chat.cards.render.button")}
                      </button>
                      <button type="button" className="chat-card__button" onClick={() => onCard("renderFinal", turn)}>{t("chat.cards.render.final")}</button>
                    </div>
                  ) : card ? (
                    <div className="chat-card">
                      <span>{t(`chat.cards.${card}.question`, { step: step ? t(stepLabelKey(step)) : "" })}</span>
                      <button type="button" className="chat-card__button" disabled={busyCard === card} onClick={() => onCard(card, turn)}>
                        {t(`chat.cards.${card}.button`)}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
