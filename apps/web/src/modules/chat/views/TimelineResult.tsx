import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { StoredTimeline } from "@harness/contracts";
import { isTimelineV4, layoutTimeline } from "@studio/timeline";
import { useStudioClient } from "../../../api/studio-client";

const secs = (s: number) => `${Math.round(s * 10) / 10}s`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export interface TimelineChange { key: string; label: string; before?: string | undefined; after?: string | undefined }

/** What a proposal changes in a timeline, as a list people read (mockup "Thay đổi so với bản trước"). */
export function timelineChanges(before: StoredTimeline, after: StoredTimeline, t: (k: string, o?: Record<string, unknown>) => string): TimelineChange[] {
  const out: TimelineChange[] = [];
  if (JSON.stringify(before.music) !== JSON.stringify(after.music)) {
    out.push({ key: "music", label: t("chat.timeline.music"), before: before.music ? `${before.music.gain_db} dB` : "—", after: after.music ? `${after.music.gain_db} dB` : "—" });
  }
  if (before.source_audio.muted !== after.source_audio.muted) {
    out.push({ key: "audio", label: t("chat.timeline.sourceAudio"), after: after.source_audio.muted ? t("chat.timeline.off") : t("chat.timeline.on") });
  }
  for (const x of after.texts) {
    const old = before.texts.find((y) => y.text_id === x.text_id);
    const at = `${mmss(x.start)}–${mmss(x.start + x.duration)}`;
    if (!old) out.push({ key: `text-${x.text_id}`, label: t("chat.timeline.text"), after: `+ "${x.text}" · ${at}` });
    else if (JSON.stringify(old) !== JSON.stringify(x)) out.push({ key: `text-${x.text_id}`, label: t("chat.timeline.text"), before: `"${old.text}"`, after: `"${x.text}" · ${at}` });
  }
  for (const y of before.texts) if (!after.texts.some((x) => x.text_id === y.text_id)) out.push({ key: `text-${y.text_id}`, label: t("chat.timeline.text"), before: `"${y.text}"` });
  const ids = (tl: StoredTimeline) => tl.clips.map((c) => c.asset_id).join(",");
  if (ids(before) !== ids(after)) {
    out.push({ key: "clips", label: t("chat.timeline.clips"), before: t("chat.timeline.clipCount", { n: before.clips.length }), after: t("chat.timeline.clipCount", { n: after.clips.length }) });
  }
  return out;
}

/** The timeline of an episode (mockup screen 7): its preview, its clips and words, what the proposal changes. */
export function TimelineResult({ productionId, episodeId, timeline, proposal }: {
  productionId: string; episodeId: string; timeline: StoredTimeline; proposal?: StoredTimeline | null | undefined;
}) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const shown = proposal ?? timeline;
  const laid = layoutTimeline(shown);
  const { data: preview } = useQuery({
    queryKey: ["preview", productionId, episodeId],
    queryFn: async () => {
      const jobs = await client.listEditorJobs(productionId, episodeId, "render_preview");
      const last = jobs[0];
      return last ? client.getEditorJob(productionId, episodeId, last.id) : null;
    },
    refetchInterval: (q) => (q.state.data && (q.state.data.status === "queued" || q.state.data.status === "running") ? 3000 : false),
  });
  const changes = proposal ? timelineChanges(timeline, proposal, t) : [];
  const cut = isTimelineV4(shown) && shown.edit_style === "cut";
  return (
    <div className="chat-timeline">
      {preview?.status === "completed" && preview.url ? (
        <video className="chat-timeline__video" src={preview.url} controls preload="metadata" />
      ) : preview && (preview.status === "queued" || preview.status === "running") ? (
        <p className="chat-doc__note">{t("chat.timeline.previewRendering", { p: preview.progress ?? 0 })}</p>
      ) : (
        <p className="chat-doc__note">{t("chat.timeline.noPreview")}</p>
      )}
      <p className="chat-doc__note">{t("chat.timeline.summary", { clips: shown.clips.length, duration: mmss(laid.duration) })}</p>
      {proposal ? (
        <section className="chat-timeline__changes">
          <h3>{t("chat.timeline.changes")}</h3>
          <ul>
            {changes.map((c) => (
              <li key={c.key}><span>{c.label}</span>{c.before ? <del className="chat-doc__old">{c.before}</del> : null}{c.after ? <ins className="chat-doc__new">{c.after}</ins> : null}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <ol className="chat-timeline__clips">
        {laid.clips.map((c) => (
          <li key={c.clip_id}>
            <span className="chat-timeline__time">{mmss(c.start)}</span>
            <span>{shown.assets[c.asset_id]?.title ?? c.asset_id}</span>
            {cut ? <span className="chat-timeline__range">{secs(c.in)}–{secs(c.source_out)}</span> : null}
            {c.section_title ? <span className="chat-timeline__section">{c.section_title}</span> : null}
          </li>
        ))}
      </ol>
      {shown.texts.length ? (
        <ul className="chat-doc__list">
          {shown.texts.map((x) => <li key={x.text_id}>{mmss(x.start)}–{mmss(x.start + x.duration)} · “{x.text}”</li>)}
        </ul>
      ) : null}
      {shown.music ? <p className="chat-doc__note">{t("chat.timeline.musicLine", { gain: shown.music.gain_db })}</p> : null}
    </div>
  );
}
