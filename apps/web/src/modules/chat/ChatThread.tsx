import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatThreadView, ChatTurn } from "../../api/studio-client";
import { messageParts } from "./mentions";
import { EPISODE_STEPS, PLAN_STEPS, stepLabelKey, stepOf, stepPosition } from "./steps";

/** What a card under Claude's newest reply asks the person to confirm (spec local-chat §2.5). */
export type ChatCard = "approve" | "start" | "apply" | "render" | "export" | "retry";

interface Props {
  thread: ChatThreadView;
  /** Called when a card's button is pressed. */
  onCard: (card: ChatCard, turn: ChatTurn) => void;
  /** A quick answer chip was pressed (intake questions). */
  onQuickAnswer?: ((text: string) => void) | undefined;
  busyCard?: ChatCard | null | undefined;
  /** Episode thread (render / export cards make sense there). */
  episode?: boolean | undefined;
}

interface Section { stageKey: string; turns: ChatTurn[] }

function sections(turns: ChatTurn[]): Section[] {
  const out: Section[] = [];
  for (const t of turns) {
    const step = stepOf(t.stage_key);
    const last = out.at(-1);
    if (last && stepOf(last.stageKey) === step) last.turns.push(t);
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

/** The chat (mockup screens 2–13): messages by step, dividers, Claude's state, and confirm cards. */
export function ChatThread({ thread, onCard, onQuickAnswer, busyCard, episode = false }: Props) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const all = sections(thread.turns);
  const newestReply = [...thread.turns].reverse().find((x) => x.role === "assistant");
  const row = episode ? EPISODE_STEPS : PLAN_STEPS;

  return (
    <div className="chat-thread" aria-live="polite">
      {all.map((sec, i) => {
        const step = stepOf(sec.stageKey);
        const current = thread.scope?.stageKey === sec.stageKey || (i === all.length - 1 && !thread.scope);
        const n = stepPosition(step, row);
        const state = current
          ? thread.scope?.scope === "failed" ? t("chat.thread.needsAttention") : thread.scope ? t("chat.thread.yourTurn") : ""
          : t("chat.thread.done");
        const collapsed = !!step && step !== "intake" && !current && !opened.has(i) && i < all.length - 1;
        return (
          <section key={`${sec.stageKey}-${i}`} className="chat-thread__section">
            {step && step !== "intake" ? (
              <div className="chat-divider">
                <span>
                  {n >= 0 ? `${t("chat.thread.step", { n: n + 1 })} · ` : ""}{t(stepLabelKey(step))}{state ? ` · ${state}` : ""}
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
                  <p className="chat-reply__who">Claude</p>
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
                  {card ? (
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
