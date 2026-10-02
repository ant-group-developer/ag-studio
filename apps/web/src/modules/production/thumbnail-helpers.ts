/**
 * Small helpers shared by ThumbnailPanel and ThumbnailWordEditor: readable API errors, mm:ss timestamps, and
 * the two starting points offered for a thumbnail's word style (the production's branding, or a neutral default).
 */
import type { StudioBranding, ThumbnailStyle } from "@harness/contracts";
import { StudioHttpError } from "../../api/studio-client";

/** Known error codes that answer without their own message: map to a localised one. */
const ERROR_KEYS: Record<string, string> = {
  footage_hidden: "thumbnails.errorFootageHidden",
  thumbnails_unavailable: "thumbnails.errorUnavailable",
  not_user_made: "thumbnails.errorNotUserMade",
  canva_disabled: "canva.errorDisabled",
  canva_failed: "canva.errorFailed",
  canva_busy: "canva.errorBusy",
  no_canva_design: "canva.errorNoDesign",
};

/** A message fit for `message.error`: the server's own message when it sent one (422s carry a Vietnamese
 *  message already), a localised text for the codes above, else the raw error. */
export function errorText(err: unknown, t: (key: string) => string): string {
  if (err instanceof StudioHttpError) {
    const code = err.body?.code;
    if (typeof code === "string" && ERROR_KEYS[code]) return t(ERROR_KEYS[code]!);
    if (typeof err.body?.message === "string" && err.body.message) return err.body.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** A frame's `tS` as `m:ss`. */
export function formatTs(tS: number | null): string {
  if (tS == null) return "";
  const m = Math.floor(tS / 60);
  const s = Math.floor(tS % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** White text, black outline, bottom, large, uppercase — the style preset when there is no branding to follow. */
export function neutralThumbnailStyle(): ThumbnailStyle {
  return { position: "bottom", size: "l", text_color: "#FFFFFF", outline_color: "#000000", box_color: null, uppercase: true };
}

export function brandingThumbnailStyle(branding: StudioBranding): ThumbnailStyle {
  return {
    position: branding.thumbnail.position,
    size: "l",
    text_color: branding.thumbnail.palette.text,
    outline_color: branding.thumbnail.palette.outline,
    box_color: null,
    uppercase: branding.thumbnail.text_case === "upper",
  };
}

/** A box `long` pixels on its long side with the picture's own shape (16:9, or 9:16 for a vertical series). */
export function thumbBox(pic: { width: number; height: number }, long: number): { width: number; height: number } {
  return pic.width >= pic.height
    ? { width: long, height: Math.round((long * pic.height) / pic.width) }
    : { width: Math.round((long * pic.width) / pic.height), height: long };
}
