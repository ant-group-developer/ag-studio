import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { StudioStyle } from "@harness/contracts";
import { useStudioClient } from "../../../api/studio-client";

/**
 * Beside the style (series plan 3.2.0): the frames of the reference videos it cites as evidence, each with what it
 * shows, and the videos it was learned from. A skipped style says why instead.
 */
export function StyleEvidence({ productionId, style }: { productionId: string; style: StudioStyle | null | undefined }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const evidence = style?.skipped ? [] : (style?.evidence ?? []);
  const { data, isError } = useQuery({
    queryKey: ["style-frames", productionId, evidence.map((e) => `${e.video_id}@${e.t}`).join(",")],
    queryFn: () => client.getStyleFrames(productionId, evidence.map((e) => ({ video_id: e.video_id, t: e.t }))),
    enabled: evidence.length > 0,
    staleTime: 5 * 60_000,
  });
  if (!style) return null;
  if (style.skipped) return <p className="chat-doc__note">{t("chat.style.skipped", { reason: style.skipped_reason ?? "" })}</p>;
  const url = (videoId: string, at: number) => data?.frames.find((f) => f.video_id === videoId && f.t === at)?.url;
  return (
    <section className="chat-style" aria-label={t("chat.style.evidence")}>
      <h4 className="chat-doc__label">{t("chat.style.evidence")}</h4>
      {isError ? <p className="chat-doc__note">{t("chat.style.noFrames")}</p> : null}
      <ul className="chat-style__frames">
        {evidence.map((e) => {
          const src = url(e.video_id, e.t);
          return (
            <li key={`${e.video_id}@${e.t}`} className="chat-style__frame">
              {src ? <img src={src} alt={t("chat.style.frameAlt", { param: e.param, t: e.t })} loading="lazy" /> : <div className="chat-style__placeholder" aria-hidden />}
              <span><strong>{e.param}</strong> · {e.t}s{e.note ? ` — ${e.note}` : ""}</span>
            </li>
          );
        })}
      </ul>
      <h4 className="chat-doc__label">{t("chat.style.learnedFrom")}</h4>
      <ul className="chat-doc__list">
        {style.references.map((r) => (
          <li key={r.video_id}><a href={r.url} target="_blank" rel="noreferrer noopener">{r.title}</a> — {r.channel_title}</li>
        ))}
      </ul>
      <p className="chat-doc__note">{t("chat.style.internalOnly")}</p>
    </section>
  );
}
