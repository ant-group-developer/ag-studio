import { useEffect, useRef, useState } from "react";

/** One server-sent event: its name (`event:`, default `message`) and its data lines joined. */
export interface SseEvent { event: string; data: string }

/** Reads `text/event-stream` from a response body, event by event (comments and `id:` lines are skipped). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length || event !== "message") yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});

/**
 * Keeps an event stream open while `key` stays the same, calling `onEvent` for each event; reconnects with a growing
 * pause (1 s → 30 s). `open` makes the request (fetch, so the bearer token is sent). Returns whether it is open now.
 */
export function useEventStream(key: string | null, open: (signal: AbortSignal) => Promise<Response>, onEvent: (e: SseEvent) => void): boolean {
  const [live, setLive] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const opener = useRef(open);
  opener.current = open;
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    void (async () => {
      let pause = 1000;
      while (!ctrl.signal.aborted) {
        try {
          const res = await opener.current(ctrl.signal);
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          setLive(true);
          pause = 1000;
          for await (const e of readSse(res.body)) handler.current(e);
        } catch { /* closed, refused, or no such route: wait, then try again */ }
        setLive(false);
        if (ctrl.signal.aborted) return;
        await sleep(pause, ctrl.signal);
        pause = Math.min(pause * 2, 30_000);
      }
    })();
    return () => { ctrl.abort(); setLive(false); };
  }, [key]);
  return live;
}

/** The time now, refreshed every `ms` while `active` (for live "0:12" counters). */
export function useNow(ms = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}
