import { useTranslation } from "react-i18next";
import type { EditPlan } from "@harness/contracts";

type Shot = EditPlan["shots"][number];
type Line = EditPlan["lines"][number];

const secs = (s: number) => `${Math.round(s * 10) / 10}s`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const length = (x: Shot) => x.out - x.in;

/** When each shot starts in the cut (pictures end to end, before the fit to the narration). */
export function shotStarts(plan: EditPlan): Map<number, number> {
  const out = new Map<number, number>();
  let at = 0;
  for (const x of plan.shots) { out.set(x.order, at); at += length(x); }
  return out;
}

/** What changed in the shot list, by shot: new, re-ranged (with the old range) or gone. */
export function shotChanges(plan: EditPlan, previous: EditPlan | undefined): { added: Set<string>; moved: Map<string, Shot>; removed: Shot[] } {
  const added = new Set<string>();
  const moved = new Map<string, Shot>();
  if (!previous) return { added, moved, removed: [] };
  const before = new Map(previous.shots.map((x) => [x.shot_id, x]));
  for (const x of plan.shots) {
    const b = before.get(x.shot_id);
    if (!b) added.add(x.shot_id);
    else if (b.in !== x.in || b.out !== x.out || b.order !== x.order || b.transition !== x.transition) moved.set(x.shot_id, b);
  }
  const now = new Set(plan.shots.map((x) => x.shot_id));
  return { added, moved, removed: previous.shots.filter((x) => !now.has(x.shot_id)) };
}

function LineText({ line, before }: { line: Line; before: Line | undefined | null }) {
  if (before === null || !before) return <ins className="chat-doc__new">{line.text}</ins>;
  if (before.text === line.text) return <>{line.text}</>;
  return <><del className="chat-doc__old">{before.text}</del><ins className="chat-doc__new">{line.text}</ins></>;
}

/**
 * "Kế hoạch dựng" of a shot-cut episode (mockup screen 9): the shots in order (# · shot · in–out · length), the
 * narration line by line, the words on screen at their estimated time, the total; what changed since the version
 * before struck out and marked. No video preview here: the cut is fitted to its narration after approval.
 */
export function EditPlanResult({ plan, previous }: { plan: EditPlan; previous?: EditPlan | undefined }) {
  const { t } = useTranslation();
  const starts = shotStarts(plan);
  const changes = shotChanges(plan, previous);
  const total = plan.shots.reduce((sum, x) => sum + length(x), 0);
  const prevLines = new Map((previous?.lines ?? []).map((l) => [l.line_id, l]));
  const goneLines = (previous?.lines ?? []).filter((l) => !plan.lines.some((x) => x.line_id === l.line_id));
  const anchor = new Map(plan.shots.filter((x) => x.line_id).map((x) => [x.line_id!, x.order]));

  return (
    <div className="chat-plan">
      <p className="chat-doc__note">
        {t("chat.editPlan.total", { n: plan.shots.length, duration: mmss(total), target: mmss(plan.target_seconds) })}
        {" · "}{t(`chat.cut.narration.${plan.narration}`)}
      </p>
      <table className="chat-plan__shots">
        <thead>
          <tr><th>#</th><th>{t("chat.editPlan.shot")}</th><th>{t("chat.editPlan.range")}</th><th>{t("chat.editPlan.length")}</th></tr>
        </thead>
        <tbody>
          {plan.shots.map((x) => {
            const old = changes.moved.get(x.shot_id);
            const fresh = changes.added.has(x.shot_id);
            return (
              <tr key={`${x.order}-${x.shot_id}`} className={fresh || old ? "chat-plan__row--changed" : undefined}>
                <td>{x.order}</td>
                <td>{fresh ? <ins className="chat-doc__new">{x.shot_id}</ins> : x.shot_id}{x.transition === "dissolve" ? <span className="chat-plan__tag">{t("chat.editPlan.dissolve")}</span> : null}</td>
                <td>
                  {old && (old.in !== x.in || old.out !== x.out) ? <del className="chat-doc__old">{secs(old.in)}–{secs(old.out)}</del> : null}
                  {secs(x.in)}–{secs(x.out)}
                </td>
                <td>{secs(length(x))}</td>
              </tr>
            );
          })}
          {changes.removed.map((x) => (
            <tr key={`gone-${x.shot_id}`} className="chat-plan__row--gone">
              <td /><td><del className="chat-doc__old">{x.shot_id}</del></td><td><del className="chat-doc__old">{secs(x.in)}–{secs(x.out)}</del></td><td />
            </tr>
          ))}
        </tbody>
      </table>

      {plan.lines.length || goneLines.length ? (
        <section>
          <h3>{t("chat.editPlan.narration")}</h3>
          <ol className="chat-plan__lines">
            {plan.lines.map((l) => (
              <li key={l.line_id}>
                <span className="chat-plan__anchor">{anchor.has(l.line_id) ? t("chat.editPlan.atShot", { n: anchor.get(l.line_id) }) : t("chat.editPlan.unanchored")}</span>
                <LineText line={l} before={previous ? prevLines.get(l.line_id) ?? null : l} />
              </li>
            ))}
            {goneLines.map((l) => <li key={`gone-${l.line_id}`}><del className="chat-doc__old">{l.text}</del></li>)}
          </ol>
        </section>
      ) : null}

      {plan.texts.length ? (
        <section>
          <h3>{t("chat.editPlan.texts")}</h3>
          <ul className="chat-doc__list">
            {plan.texts.map((x) => {
              const at = (starts.get(x.at_order) ?? 0) + x.offset_s;
              return <li key={x.text_id}>~{mmss(at)}–{mmss(at + x.duration)} · “{x.text}”</li>;
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
