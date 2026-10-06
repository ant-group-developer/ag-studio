import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { CutSources, StudioSurvey } from "@harness/contracts";
import { useStudioClient } from "../../../api/studio-client";

type Row = StudioSurvey["shots"][number];
export type ShotFilter = "usable" | "rejected" | "all";

const secs = (s: number) => `${Math.round(s * 10) / 10}s`;
const same = (a: Row | undefined, b: Row) => !!a && a.usable === b.usable && a.score === b.score && a.note === b.note;

/** The shots a filter keeps, in the selection's order. */
export function filterShots(rows: readonly Row[], filter: ShotFilter): Row[] {
  return rows.filter((r) => (filter === "all" ? true : filter === "usable" ? r.usable : !r.usable));
}

/** The 720p proxy of the shot's video, played from its in to its out (`#t=in,out`), with what Claude saw in it. */
function ShotPlayer({ productionId, row, source }: { productionId: string; row: Row; source: CutSources["sources"][number] | undefined }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data: media, isError } = useQuery({
    queryKey: ["asset-media", productionId, source?.asset_id], queryFn: () => client.getAssetMedia(productionId, source!.asset_id),
    enabled: !!source, retry: false, staleTime: 5 * 60_000,
  });
  return (
    <section className="chat-shots__player" aria-label={t("chat.survey.player", { shot: row.shot_id })}>
      {media?.previewUrl ? (
        <video key={`${row.shot_id}-${media.previewUrl}`} src={`${media.previewUrl}#t=${row.in},${row.out}`} controls autoPlay muted preload="metadata" />
      ) : <p className="chat-doc__note">{isError || (media && !media.previewUrl) ? t("chat.survey.noVideo") : t("chat.survey.loadingVideo")}</p>}
      <p><strong>{row.shot_id}</strong> · {source?.title ?? row.source_id} · {secs(row.in)}–{secs(row.out)}</p>
      <p className="chat-doc__note">{row.note}</p>
      {row.tags.length ? <ul className="chat-doc__chips">{row.tags.map((x) => <li key={x}>{x}</li>)}</ul> : null}
    </section>
  );
}

/**
 * "Chọn cảnh" of a shot-cut episode (mockup screen 8): every shot with its frame, short note and length, its score
 * when kept or why it was rejected; filtered by kept / rejected / all; a shot changed since the version before is
 * marked. Pressing a shot plays its piece of the 720p proxy.
 */
export function SurveyResult({ productionId, episodeId, survey, previous }: {
  productionId: string; episodeId: string; survey: StudioSurvey; previous?: StudioSurvey | undefined;
}) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const [filter, setFilter] = useState<ShotFilter>("all");
  const [open, setOpen] = useState<string | null>(null);
  // frames show footage: none without the footage scope (403), the grid still lists the shots
  const { data: frames } = useQuery({
    queryKey: ["episode-shots", productionId, episodeId], queryFn: () => client.getEpisodeShots(productionId, episodeId), retry: false,
  });
  const { data: sources } = useQuery({
    queryKey: ["episode-doc", productionId, episodeId, "episode-intake", "sources.json"],
    queryFn: () => client.getEpisodeDocument<CutSources>(productionId, episodeId, "episode-intake", "sources.json"), retry: false, staleTime: Infinity,
  });
  const frameOf = new Map((frames?.shots ?? []).map((x) => [x.shotId, x.frameUrl]));
  const before = new Map((previous?.shots ?? []).map((r) => [r.shot_id, r]));
  const sourceOf = new Map((sources?.sources ?? []).map((s) => [s.source_id, s]));
  const rows = filterShots(survey.shots, filter);
  const count = (f: ShotFilter) => filterShots(survey.shots, f).length;
  const shown = open ? survey.shots.find((r) => r.shot_id === open) : undefined;

  return (
    <div className="chat-shots">
      <div className="chat-shots__filters" role="group" aria-label={t("chat.survey.filter")}>
        {(["usable", "rejected", "all"] as const).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} className={filter === f ? "chat-chip chat-chip--on" : "chat-chip"} onClick={() => setFilter(f)}>
            {t(`chat.survey.filters.${f}`, { n: count(f) })}
          </button>
        ))}
      </div>
      {shown ? <ShotPlayer productionId={productionId} row={shown} source={sourceOf.get(shown.source_id)} /> : null}
      <ul className="chat-shots__grid">
        {rows.map((r) => {
          const changed = previous !== undefined && !same(before.get(r.shot_id), r);
          const frame = frameOf.get(r.shot_id);
          return (
            <li key={r.shot_id} className={["chat-shot", r.usable ? "" : "chat-shot--rejected", changed ? "chat-shot--changed" : "", open === r.shot_id ? "chat-shot--open" : ""].filter(Boolean).join(" ")}>
              <button type="button" onClick={() => setOpen(open === r.shot_id ? null : r.shot_id)} aria-label={t("chat.survey.play", { shot: r.shot_id })}>
                {frame ? <img src={frame} alt="" loading="lazy" /> : <span className="chat-shot__noframe" />}
              </button>
              <span className="chat-shot__id">{r.shot_id}</span>
              <span className="chat-shot__desc">{[r.tags.slice(0, 2).join(", "), secs(r.out - r.in)].filter(Boolean).join(" · ")}</span>
              <span className="chat-shot__verdict">{r.usable ? t("chat.survey.kept", { score: r.score }) : r.note}</span>
            </li>
          );
        })}
      </ul>
      {rows.length === 0 ? <p className="chat-doc__note">{t("chat.survey.empty")}</p> : null}
    </div>
  );
}
