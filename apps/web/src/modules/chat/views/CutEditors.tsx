import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input, InputNumber, Select, Switch } from "antd";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EditPlan, StudioSurvey } from "@harness/contracts";
import { useStudioClient } from "../../../api/studio-client";
import { filterShots, type ShotFilter } from "./SurveyResult";

type Row = StudioSurvey["shots"][number];
const secs = (s: number) => `${Math.round(s * 10) / 10}s`;

/**
 * The scene selection by hand: each shot kept or rejected, its score (0–5) and its note (why it was rejected).
 * The checks (one row per shot, a reason for each rejection) run on the server when it is saved.
 */
export function SurveyEditor({ productionId, episodeId, value, onChange }: {
  productionId: string; episodeId: string; value: StudioSurvey; onChange: (v: StudioSurvey) => void;
}) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const [filter, setFilter] = useState<ShotFilter>("all");
  const { data: frames } = useQuery({
    queryKey: ["episode-shots", productionId, episodeId], queryFn: () => client.getEpisodeShots(productionId, episodeId), retry: false,
  });
  const frameOf = new Map((frames?.shots ?? []).map((x) => [x.shotId, x.frameUrl]));
  const put = (id: string, patch: Partial<Row>) => onChange({ ...value, shots: value.shots.map((r) => (r.shot_id === id ? { ...r, ...patch } : r)) });
  const count = (f: ShotFilter) => filterShots(value.shots, f).length;
  return (
    <div className="chat-shots">
      <div className="chat-shots__filters" role="group" aria-label={t("chat.survey.filter")}>
        {(["usable", "rejected", "all"] as const).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} className={filter === f ? "chat-chip chat-chip--on" : "chat-chip"} onClick={() => setFilter(f)}>
            {t(`chat.survey.filters.${f}`, { n: count(f) })}
          </button>
        ))}
      </div>
      <ul className="chat-edit__shots">
        {filterShots(value.shots, filter).map((r) => {
          const frame = frameOf.get(r.shot_id);
          return (
            <li key={r.shot_id} className={r.usable ? "chat-edit__shot" : "chat-edit__shot chat-shot--rejected"}>
              {frame ? <img src={frame} alt="" loading="lazy" /> : <span className="chat-shot__noframe" />}
              <div className="chat-edit__shot-body">
                <div className="chat-edit__inline">
                  <strong>{r.shot_id}</strong>
                  <span className="chat-doc__note">{secs(r.out - r.in)}</span>
                  <Switch size="small" checked={r.usable} aria-label={t("chat.edit.keepShot", { shot: r.shot_id })}
                    onChange={(on) => put(r.shot_id, { usable: on })} />
                  <span>{t(r.usable ? "chat.edit.kept" : "chat.edit.rejected")}</span>
                  {r.usable ? (
                    <InputNumber size="small" min={0} max={5} precision={0} value={r.score} aria-label={t("chat.edit.score", { shot: r.shot_id })}
                      onChange={(v) => put(r.shot_id, { score: v ?? r.score })} />
                  ) : null}
                </div>
                <Input size="small" value={r.note} placeholder={t(r.usable ? "chat.edit.notePlaceholder" : "chat.edit.reasonPlaceholder")}
                  aria-label={t("chat.edit.note", { shot: r.shot_id })} onChange={(e) => put(r.shot_id, { note: e.target.value })} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Shots moved or removed: renumbered 1…n, the words on screen following the shot they were on (gone with it). */
export function reorderShots(plan: EditPlan, shots: EditPlan["shots"]): EditPlan {
  const newOrder = new Map(shots.map((x, i) => [x.order, i + 1]));
  return {
    ...plan,
    shots: shots.map((x, i) => ({ ...x, order: i + 1 })),
    texts: plan.texts.filter((x) => newOrder.has(x.at_order)).map((x) => ({ ...x, at_order: newOrder.get(x.at_order)! })),
  };
}

/**
 * The edit plan by hand: the shots in order (range, transition; moved up/down or removed), the narration line by
 * line, the words on screen. Which shots exist and their ranges are checked against the scene selection on save.
 */
export function EditPlanEditor({ value, onChange }: { value: EditPlan; onChange: (v: EditPlan) => void }) {
  const { t } = useTranslation();
  const shots = value.shots;
  const putShot = (i: number, patch: Partial<EditPlan["shots"][number]>) => onChange({ ...value, shots: shots.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  const move = (i: number, by: number) => {
    const next = [...shots];
    const [x] = next.splice(i, 1);
    next.splice(i + by, 0, x!);
    onChange(reorderShots(value, next));
  };
  return (
    <div className="chat-plan">
      <table className="chat-plan__shots chat-edit__table">
        <thead>
          <tr><th>#</th><th>{t("chat.editPlan.shot")}</th><th>{t("chat.edit.in")}</th><th>{t("chat.edit.out")}</th><th>{t("chat.edit.transition")}</th><th /></tr>
        </thead>
        <tbody>
          {shots.map((x, i) => (
            <tr key={`${x.shot_id}-${i}`}>
              <td>{x.order}</td>
              <td>{x.shot_id}</td>
              <td><InputNumber size="small" min={0} step={0.1} value={x.in} aria-label={t("chat.edit.inOf", { n: x.order })} onChange={(v) => putShot(i, { in: v ?? x.in })} /></td>
              <td><InputNumber size="small" min={0.1} step={0.1} value={x.out} aria-label={t("chat.edit.outOf", { n: x.order })} onChange={(v) => putShot(i, { out: v ?? x.out })} /></td>
              <td>
                <Select size="small" value={x.transition} aria-label={t("chat.edit.transitionOf", { n: x.order })} onChange={(v) => putShot(i, { transition: v })}
                  options={[{ value: "cut", label: t("chat.edit.cut") }, { value: "dissolve", label: t("chat.editPlan.dissolve") }]} />
              </td>
              <td className="chat-edit__actions">
                <button type="button" className="chat-edit__remove" disabled={i === 0} aria-label={t("chat.edit.up", { n: x.order })} onClick={() => move(i, -1)}><ArrowUp size={14} aria-hidden /></button>
                <button type="button" className="chat-edit__remove" disabled={i === shots.length - 1} aria-label={t("chat.edit.down", { n: x.order })} onClick={() => move(i, 1)}><ArrowDown size={14} aria-hidden /></button>
                <button type="button" className="chat-edit__remove" disabled={shots.length === 1} aria-label={t("chat.edit.removeShot", { n: x.order })}
                  onClick={() => onChange(reorderShots(value, shots.filter((_, k) => k !== i)))}><X size={14} aria-hidden /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {value.lines.length ? (
        <section>
          <h3>{t("chat.editPlan.narration")}</h3>
          <div className="chat-edit__list">
            {value.lines.map((l, i) => (
              <Input.TextArea key={l.line_id} aria-label={t("chat.edit.line", { n: i + 1 })} value={l.text} autoSize={{ minRows: 1, maxRows: 8 }}
                onChange={(e) => onChange({ ...value, lines: value.lines.map((x) => (x.line_id === l.line_id ? { ...x, text: e.target.value } : x)) })} />
            ))}
          </div>
        </section>
      ) : null}

      {value.texts.length ? (
        <section>
          <h3>{t("chat.editPlan.texts")}</h3>
          <div className="chat-edit__list">
            {value.texts.map((x, i) => (
              <div key={x.text_id} className="chat-edit__row">
                <Input maxLength={64} aria-label={t("chat.edit.text", { n: i + 1 })} value={x.text}
                  onChange={(e) => onChange({ ...value, texts: value.texts.map((y) => (y.text_id === x.text_id ? { ...y, text: e.target.value } : y)) })} />
                <button type="button" className="chat-edit__remove" aria-label={t("chat.edit.remove")}
                  onClick={() => onChange({ ...value, texts: value.texts.filter((y) => y.text_id !== x.text_id) })}><X size={14} aria-hidden /></button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
