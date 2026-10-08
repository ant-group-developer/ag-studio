/**
 * Timeline player (GĐ3, v3). Two `<video>` elements are used alternately (current clip and preloaded next)
 * so a cut never waits on a network fetch. Clock driven by requestVideoFrameCallback (or rAF fallback).
 * Playhead in its own store, read with useSyncExternalStore so panels can memo-ise.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { StoredTimeline } from "@harness/contracts";
import type { LaidClip, LaidText, TimelineLayout } from "@studio/timeline";
import type { AssetMedia, EditorJob } from "../../api/studio-client";
import type { AssetMediaLookup, EditorClient } from "./types";
import { Play, Pause } from "lucide-react";
import { Tooltip } from "antd";

function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

const otherSlot = (s: 0 | 1): 0 | 1 => (s === 0 ? 1 : 0);

/** Where in its video a clip is at timeline time `t`: a shot-cut clip is a piece of it, from `in` (0 for a whole video). */
export function sourceTimeAt(clip: Pick<LaidClip, "start" | "in">, t: number): number {
  return Math.max(0, t - clip.start + clip.in);
}

const TEXT_POSITION_STYLE: Record<string, CSSProperties> = {
  top_left: { top: 12, left: 12 },
  top_center: { top: 12, left: "50%", transform: "translateX(-50%)" },
  top_right: { top: 12, right: 12 },
  center: { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
  bottom_left: { bottom: 12, left: 12 },
  bottom_center: { bottom: 12, left: "50%", transform: "translateX(-50%)" },
  bottom_right: { bottom: 12, right: 12 },
};

// Minimal external store for playhead time (so panels can subscribe without re-rendering Editor)
function createPlayheadStore(initial: number) {
  let time = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => time,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    set: (t: number) => { time = t; listeners.forEach((f) => f()); },
  };
}

export interface PlayerProps {
  productionId: string;
  episodeId: string;
  client: EditorClient;
  media: AssetMediaLookup;
  timeline: StoredTimeline;
  layout: TimelineLayout;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  time: number;
  /** Bumped whenever the parent wants the player to jump to `time`. */
  seekToken: number;
  onTimeUpdate: (t: number) => void;
  renderJob: EditorJob | null;
}

export function Player({
  productionId: _productionId,
  episodeId: _episodeId,
  client: _client,
  media,
  timeline,
  layout,
  playing,
  onPlayingChange,
  time,
  seekToken,
  onTimeUpdate,
  renderJob,
}: PlayerProps) {
  const { t } = useTranslation();
  const slotRefs = [useRef<HTMLVideoElement | null>(null), useRef<HTMLVideoElement | null>(null)] as const;
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const [hasPreview, setHasPreview] = useState(true);
  const slotClipId = useRef<[string | null, string | null]>([null, null]);
  const currentClipIdRef = useRef<string | null>(null);
  const mediaCache = useRef(new Map<string, Promise<AssetMedia | null>>());
  const clockRef = useRef(time);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const lastUiUpdateRef = useRef(0);
  const [uiTime, setUiTime] = useState(time);

  // Playhead store (for panels that want to subscribe without re-rendering Player)
  const playheadStoreRef = useRef(createPlayheadStore(time));
  const playhead = useSyncExternalStore(
    playheadStoreRef.current.subscribe,
    playheadStoreRef.current.getSnapshot,
  );

  const getMedia = (assetId: string): Promise<AssetMedia | null> => {
    let p = mediaCache.current.get(assetId);
    if (!p) {
      p = media(assetId).catch(() => null);
      mediaCache.current.set(assetId, p);
    }
    return p;
  };

  const findClip = (t: number): LaidClip | null =>
    layout.clips.find((c) => t >= c.start && t < c.end) ?? null;

  async function loadInto(slot: 0 | 1, clip: LaidClip): Promise<AssetMedia | null> {
    const m = await getMedia(clip.asset_id);
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

  async function applyClipAt(t: number, forceSeek: boolean) {
    const clip = findClip(t);
    if (!clip) {
      setActiveTitle(null);
      setHasPreview(true);
      return;
    }
    const changed = clip.clip_id !== currentClipIdRef.current;
    if (!changed && !forceSeek) return;
    currentClipIdRef.current = clip.clip_id;
    const asset = timeline.assets[clip.asset_id];
    setActiveTitle(asset?.title ?? null);

    const preloadedSlot: 0 | 1 | -1 =
      slotClipId.current[0] === clip.clip_id ? 0 : slotClipId.current[1] === clip.clip_id ? 1 : -1;
    const slot: 0 | 1 = changed ? (preloadedSlot >= 0 ? (preloadedSlot as 0 | 1) : activeSlot) : activeSlot;

    const m = preloadedSlot >= 0 ? await getMedia(clip.asset_id) : await loadInto(slot, clip);
    setHasPreview(!!m?.previewUrl);

    if (changed) {
      setActiveSlot(slot);
      slotRefs[otherSlot(slot)].current?.pause();
    }
    const el = slotRefs[slot].current;
    if (el && m?.previewUrl) {
      el.currentTime = sourceTimeAt(clip, t);
      if (playing) void el.play().catch(() => {});
    }
    if (changed) {
      const idx = layout.clips.findIndex((c) => c.clip_id === clip.clip_id);
      const next = layout.clips[idx + 1];
      if (next) void loadInto(otherSlot(slot), next);
    }
  }

  // Manual seeks
  useEffect(() => {
    clockRef.current = time;
    setUiTime(time);
    playheadStoreRef.current.set(time);
    currentClipIdRef.current = null;
    void applyClipAt(time, true);
    onTimeUpdate(time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToken]);

  // Layout changes (edit, load, conflict reload)
  useEffect(() => {
    slotClipId.current = [null, null];
    currentClipIdRef.current = null;
    void applyClipAt(clockRef.current, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  useEffect(() => {
    const el = slotRefs[activeSlot].current;
    if (playing) void el?.play().catch(() => {});
    else el?.pause();
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
          playheadStoreRef.current.set(next);
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
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        {([0, 1] as const).map((i) => (
          <video
            key={i}
            ref={slotRefs[i]}
            muted={timeline.source_audio.muted}
            playsInline
            preload="auto"
            style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              objectFit: "contain", opacity: activeSlot === i ? 1 : 0, zIndex: activeSlot === i ? 1 : 0,
            }}
          />
        ))}
        {!hasPreview && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2, padding: 16, textAlign: "center", color: "#fff" }}>
            {activeTitle ?? t("player.noPreview")}
          </div>
        )}
        {activeTexts.map((x) => (
          <div
            key={x.text_id}
            style={{
              position: "absolute", zIndex: 3, color: "#fff",
              textShadow: "0 1px 3px rgba(0,0,0,0.8)", fontWeight: 600, padding: 8,
              ...TEXT_POSITION_STYLE[x.position],
            }}
          >
            {x.text}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <Tooltip title={playing ? t("player.pause") : t("player.play")}>
          <button
            type="button"
            aria-label={playing ? t("player.pause") : t("player.play")}
            onClick={() => onPlayingChange(!playing)}
            style={{ background: "none", border: "none", cursor: "pointer", display: "flex", padding: 0, color: "inherit" }}
          >
            {playing ? <Pause size={24} /> : <Play size={24} />}
          </button>
        </Tooltip>
        <span>{fmt(playhead)} / {fmt(layout.duration)}</span>
        {renderJob && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "#888" }}>
            {renderJob.status === "queued" || renderJob.status === "running" ? t("player.rendering") : renderJob.status === "completed" ? t("player.renderDone") : t("player.renderFailed")}
          </span>
        )}
      </div>
    </div>
  );
}
