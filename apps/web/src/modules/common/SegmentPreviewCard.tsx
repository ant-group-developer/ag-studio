import { useEffect, useRef, useState } from "react";
import type { SegmentMedia } from "../../api/ag-go-client";
import type { MediaLookup } from "./media";

type LoadState = { status: "idle" } | { status: "loading" } | { status: "loaded"; media: SegmentMedia | null };

/**
 * One footage segment as a small card: a watermarked preview plays (looping `startMs`-`endMs`) on hover or
 * click; falls back to a keyframe, then to the caption text on black when there is no media (out of the
 * viewer's footage scope, or the asset has none) -- never an error.
 */
export function SegmentPreviewCard({
  segmentId,
  caption,
  media,
  eager = false,
  selected = false,
  onClick,
  width = 160,
}: {
  segmentId: string;
  caption: string;
  media: MediaLookup;
  eager?: boolean;
  selected?: boolean;
  onClick?: () => void;
  width?: number;
}) {
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [hovering, setHovering] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const loadedRef = useRef(false);

  const load = () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setState({ status: "loading" });
    media(segmentId)
      .then((m) => setState({ status: "loaded", media: m }))
      .catch(() => setState({ status: "loaded", media: null }));
  };

  useEffect(() => {
    if (eager) load();
    // load() is idempotent (guarded by loadedRef); only segmentId/eager should trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eager, segmentId]);

  const segMedia = state.status === "loaded" ? state.media : null;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !segMedia?.previewUrl) return;
    if (hovering) {
      el.currentTime = segMedia.startMs / 1000;
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [hovering, segMedia]);

  const onTimeUpdate = () => {
    const el = videoRef.current;
    if (!el || !segMedia) return;
    if (el.currentTime * 1000 >= segMedia.endMs) el.currentTime = segMedia.startMs / 1000;
  };

  const height = Math.round((width * 9) / 16);

  return (
    <div
      onMouseEnter={() => {
        setHovering(true);
        load();
      }}
      onMouseLeave={() => setHovering(false)}
      onClick={() => {
        load();
        setHovering(true);
        onClick?.();
      }}
      title={caption}
      style={{
        width,
        height,
        position: "relative",
        background: "#000",
        borderRadius: 4,
        overflow: "hidden",
        cursor: onClick ? "pointer" : undefined,
        border: selected ? "2px solid #1677ff" : "2px solid transparent",
        flexShrink: 0,
      }}
    >
      {segMedia?.previewUrl ? (
        <video
          ref={videoRef}
          src={segMedia.previewUrl}
          muted
          playsInline
          onTimeUpdate={onTimeUpdate}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : segMedia?.keyframeUrls[0] ? (
        <img
          src={segMedia.keyframeUrls[0]}
          alt={caption}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 4,
          }}
        >
          <span style={{ color: "#fff", fontSize: 11, textAlign: "center" }}>{caption}</span>
        </div>
      )}
    </div>
  );
}
