/**
 * Timeline player (plan 4.2, M1). Two `<video>` elements are used alternately (the current clip and a
 * preloaded next one) so a cut never has to wait on a network fetch; a shared clock (`requestAnimationFrame`)
 * drives the overall timeline time so play position never depends on any one element's own clock. Narration
 * plays from a separate `<audio>` element, started at each line's beat-relative start. When a segment has no
 * watermarked preview (out of footage scope, or no media yet) the clip shows as a black frame with its
 * caption -- never an error.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { PauseCircleOutlined, PlayCircleOutlined } from "@ant-design/icons";
import type { TimelineV2 } from "@harness/contracts";
import type { LaidClip, LaidLine, LaidText, TimelineLayout } from "@studio/timeline";
import type { EditorClient, MediaLookup } from "./types";
import type { SegmentMedia } from "../../api/ag-go-client";

function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

const otherSlot = (s: 0 | 1): 0 | 1 => (s === 0 ? 1 : 0);

const TEXT_POSITION_STYLE: Record<string, CSSProperties> = {
  top_left: { top: 12, left: 12 },
  top_center: { top: 12, left: "50%", transform: "translateX(-50%)" },
  top_right: { top: 12, right: 12 },
  center: { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
  bottom_left: { bottom: 12, left: 12 },
  bottom_center: { bottom: 12, left: "50%", transform: "translateX(-50%)" },
  bottom_right: { bottom: 12, right: 12 },
};

export interface PlayerProps {
  productionId: string;
  client: EditorClient;
  media: MediaLookup;
  timeline: TimelineV2;
  layout: TimelineLayout;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  time: number;
  /** Bumped whenever the parent wants the player to jump to `time` (e.g. a click on the timeline ruler). */
  seekToken: number;
  onTimeUpdate: (t: number) => void;
}

export function Player({
  productionId,
  client,
  media,
  timeline,
  layout,
  playing,
  onPlayingChange,
  time,
  seekToken,
  onTimeUpdate,
}: PlayerProps) {
  const slotRefs = [useRef<HTMLVideoElement | null>(null), useRef<HTMLVideoElement | null>(null)] as const;
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const [activeCaption, setActiveCaption] = useState<string | null>(null);
  const [hasPreview, setHasPreview] = useState(true);
  const slotClipId = useRef<[string | null, string | null]>([null, null]);
  const currentClipIdRef = useRef<string | null>(null);
  const mediaCache = useRef(new Map<string, Promise<SegmentMedia | null>>());
  const audioUrlCache = useRef(new Map<string, Promise<string>>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeLineIdRef = useRef<string | null>(null);
  const clockRef = useRef(time);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const lastUiUpdateRef = useRef(0);
  const [uiTime, setUiTime] = useState(time);

  const getMedia = (segmentId: string): Promise<SegmentMedia | null> => {
    let p = mediaCache.current.get(segmentId);
    if (!p) {
      p = media(segmentId).catch(() => null);
      mediaCache.current.set(segmentId, p);
    }
    return p;
  };

  const findClip = (t: number): LaidClip | null =>
    layout.clips.find((c) => t >= c.start && t < c.end) ?? null;

  async function loadInto(slot: 0 | 1, clip: LaidClip): Promise<SegmentMedia | null> {
    const seg = timeline.segments[clip.segment_id];
    const m = seg ? await getMedia(clip.segment_id) : null;
    const el = slotRefs[slot].current;
    if (el) {
      slotClipId.current[slot] = clip.clip_id;
      if (m?.previewUrl) {
        if (el.src !== m.previewUrl) el.src = m.previewUrl;
      } else {
        el.removeAttribute("src");
      }
    }
    return m;
  }

  async function applyNarrationAt(t: number, forceSeek: boolean) {
    const line = layout.lines.find((l: LaidLine) => t >= l.start && t < l.end) ?? null;
    const audioEl = audioRef.current;
    if (!audioEl) return;
    if (!line || !line.audio) {
      if (activeLineIdRef.current !== null) {
        audioEl.pause();
        activeLineIdRef.current = null;
      }
      return;
    }
    if (line.line_id !== activeLineIdRef.current || forceSeek) {
      activeLineIdRef.current = line.line_id;
      let urlP = audioUrlCache.current.get(line.audio.key);
      if (!urlP) {
        urlP = client.audioUrl(productionId, line.audio.key).then((r) => r.url);
        audioUrlCache.current.set(line.audio.key, urlP);
      }
      const url = await urlP.catch(() => null);
      if (!url || activeLineIdRef.current !== line.line_id) return;
      if (audioEl.src !== url) audioEl.src = url;
      audioEl.currentTime = Math.max(0, t - line.start);
      if (playing) void audioEl.play().catch(() => {});
    }
  }

  async function applyClipAt(t: number, forceSeek: boolean) {
    const clip = findClip(t);
    if (!clip) {
      setActiveCaption(null);
      setHasPreview(true);
      await applyNarrationAt(t, forceSeek);
      return;
    }
    const changed = clip.clip_id !== currentClipIdRef.current;
    if (!changed && !forceSeek) {
      await applyNarrationAt(t, forceSeek);
      return;
    }
    currentClipIdRef.current = clip.clip_id;
    const seg = timeline.segments[clip.segment_id];
    setActiveCaption(seg?.caption ?? null);

    const preloadedSlot: 0 | 1 | -1 =
      slotClipId.current[0] === clip.clip_id ? 0 : slotClipId.current[1] === clip.clip_id ? 1 : -1;
    const slot: 0 | 1 = changed ? (preloadedSlot >= 0 ? (preloadedSlot as 0 | 1) : activeSlot) : activeSlot;

    const m = preloadedSlot >= 0 ? await getMedia(clip.segment_id) : await loadInto(slot, clip);
    setHasPreview(!!m?.previewUrl);

    if (changed) {
      setActiveSlot(slot);
      slotRefs[otherSlot(slot)].current?.pause();
    }
    const el = slotRefs[slot].current;
    if (el && seg) {
      el.currentTime = seg.start_ms / 1000 + clip.src_in + (t - clip.start);
      if (playing) void el.play().catch(() => {});
    }
    if (changed) {
      const idx = layout.clips.findIndex((c) => c.clip_id === clip.clip_id);
      const next = layout.clips[idx + 1];
      if (next) void loadInto(otherSlot(slot), next);
    }
    await applyNarrationAt(t, forceSeek);
  }

  // Manual seeks (ruler click, conflict reload, etc.).
  useEffect(() => {
    clockRef.current = time;
    setUiTime(time);
    currentClipIdRef.current = null; // force a re-apply even if the clip id is unchanged
    activeLineIdRef.current = null;
    void applyClipAt(time, true);
    onTimeUpdate(time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToken]);

  // The layout changed (an edit, a load, a conflict reload). Segment media stays cached: it belongs to the
  // segment, not to the layout, so a trim never costs another round trip to ag-go.
  useEffect(() => {
    slotClipId.current = [null, null];
    currentClipIdRef.current = null;
    activeLineIdRef.current = null;
    void applyClipAt(clockRef.current, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  useEffect(() => {
    const el = slotRefs[activeSlot].current;
    const audioEl = audioRef.current;
    if (playing) {
      void el?.play().catch(() => {});
      void audioEl?.play().catch(() => {});
    } else {
      el?.pause();
      audioEl?.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  useEffect(() => {
    if (!playing) {
      lastTsRef.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = (ts: number) => {
      if (lastTsRef.current !== null) {
        const dt = (ts - lastTsRef.current) / 1000;
        const next = Math.min(clockRef.current + dt, layout.duration);
        clockRef.current = next;
        void applyClipAt(next, false);
        if (ts - lastUiUpdateRef.current > 80) {
          setUiTime(next);
          onTimeUpdate(next);
          lastUiUpdateRef.current = ts;
        }
        if (next >= layout.duration) {
          onPlayingChange(false);
          lastTsRef.current = null;
          return;
        }
      }
      lastTsRef.current = ts;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, layout]);

  const activeTexts = useMemo(
    () => layout.texts.filter((x: LaidText) => uiTime >= x.start && uiTime < x.end),
    [layout.texts, uiTime]
  );
  const activeCaptionLine = useMemo(
    () =>
      timeline.captions.enabled ? (layout.lines.find((l: LaidLine) => uiTime >= l.start && uiTime < l.end) ?? null) : null,
    [layout.lines, uiTime, timeline.captions.enabled]
  );

  return (
    <div>
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: `${timeline.canvas.width} / ${timeline.canvas.height}`,
          background: "#000",
          overflow: "hidden",
          borderRadius: 4,
          // The render burns text and subtitles in Arial (render worker, `studioOverlayAss`): preview in the same font.
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        {([0, 1] as const).map((i) => (
          <video
            key={i}
            ref={slotRefs[i]}
            muted={timeline.source_audio.muted}
            playsInline
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              opacity: activeSlot === i ? 1 : 0,
              zIndex: activeSlot === i ? 1 : 0,
            }}
          />
        ))}
        {!hasPreview && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2,
              padding: 16,
              textAlign: "center",
              color: "#fff",
            }}
          >
            {activeCaption ?? "Không có hình"}
          </div>
        )}
        {activeTexts.map((x) => (
          <div
            key={x.text_id}
            style={{
              position: "absolute",
              zIndex: 3,
              color: "#fff",
              textShadow: "0 1px 3px rgba(0,0,0,0.8)",
              fontWeight: 600,
              padding: 8,
              ...TEXT_POSITION_STYLE[x.position],
            }}
          >
            {x.text}
          </div>
        ))}
        {activeCaptionLine && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 8,
              zIndex: 3,
              textAlign: "center",
              color: "#fff",
              textShadow: "0 1px 3px rgba(0,0,0,0.8)",
              padding: "0 16px",
            }}
          >
            {activeCaptionLine.text}
          </div>
        )}
        <audio ref={audioRef} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <a onClick={() => onPlayingChange(!playing)}>
          {playing ? <PauseCircleOutlined style={{ fontSize: 24 }} /> : <PlayCircleOutlined style={{ fontSize: 24 }} />}
        </a>
        <span>
          {fmt(uiTime)} / {fmt(layout.duration)}
        </span>
      </div>
    </div>
  );
}
