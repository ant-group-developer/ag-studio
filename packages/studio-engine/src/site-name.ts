/**
 * The name of the footage library as people know it: ag-go's own setting (`siteName` from its public
 * `GET /settings/public`, edited by ag-go admins), not a name written into Studio. The web, API errors, job text and
 * the agent's prompt and tool descriptions all use it; tool names, source kinds and error codes keep `ag_go`.
 */

export const DEFAULT_SITE_NAME = "AG Go";
const SITE_NAME_MAX = 60;

function isSiteName(s: string): boolean {
  return s.length >= 1 && s.length <= SITE_NAME_MAX && !/[\u0000-\u001f\u007f]/.test(s);
}

/** `siteName` from ag-go's public settings (no auth). Throws on a failed answer or a name not fit to show. */
export async function fetchAgGoSiteName(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/settings/public`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`ag-go settings: HTTP ${res.status}`);
  let body = (await res.json()) as Record<string, unknown> | null;
  // ag-go's envelope `{ success, requestId, data, … }`
  if (body && typeof body.success === "boolean" && typeof body.requestId === "string" && "data" in body) body = body.data as Record<string, unknown> | null;
  const raw = body?.siteName;
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!isSiteName(name)) throw new Error("ag-go settings: no usable siteName");
  return name;
}

export interface SiteNameCache {
  /** The last name loaded (the default before the first); starts a reload in the background when stale. Never throws. */
  current(): string;
  /** Loads now (or joins the load in flight) and answers with the name it ends up with. Never rejects. */
  refresh(): Promise<string>;
}

/**
 * The name for a long-running process: read without waiting, reloaded every `ttlMs` (10 minutes). A failed load
 * keeps the name it had and is tried again after a minute, not on every read.
 */
export function createSiteNameCache(opts: { load: () => Promise<string>; ttlMs?: number; now?: () => number }): SiteNameCache {
  const ttl = opts.ttlMs ?? 600_000;
  const retry = Math.min(ttl, 60_000);
  const now = opts.now ?? Date.now;
  let name: string | undefined;
  let nextAt = 0;
  let inFlight: Promise<string> | undefined;

  const refresh = (): Promise<string> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        name = await opts.load();
        nextAt = now() + ttl;
      } catch {
        nextAt = now() + retry;
      } finally {
        inFlight = undefined;
      }
      return name ?? DEFAULT_SITE_NAME;
    })();
    return inFlight;
  };

  return {
    current() {
      if (!inFlight && now() >= nextAt) void refresh();
      return name ?? DEFAULT_SITE_NAME;
    },
    refresh,
  };
}

/** `{{site}}` in a text -> the name. */
export function withSiteName(text: string, siteName: string): string {
  return text.split("{{site}}").join(siteName);
}
