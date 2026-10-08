import { useEffect, useRef, useState } from "react";
import { useStudioClient } from "../../api/studio-client";

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
 * Listens to the chat's event stream (`GET …/chat/events`) and calls `onChange` when the thread may have changed.
 * Reconnects with a growing pause (1 s → 30 s). Returns whether the stream is open: screens poll slower then, and as
 * before when it is not (an older API, a proxy that cuts streams).
 */
export function useChatEvents(productionId: string, episodeId: string | undefined, onChange: () => void): boolean {
  const client = useStudioClient();
  const [live, setLive] = useState(false);
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      let pause = 1000;
      while (!ctrl.signal.aborted) {
        try {
          const res = await client.openChatEvents(productionId, episodeId, ctrl.signal);
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          setLive(true);
          pause = 1000;
          for await (const e of readSse(res.body)) if (e.event === "changed") changed.current();
        } catch { /* closed, refused, or no such route: wait, then try again */ }
        setLive(false);
        if (ctrl.signal.aborted) return;
        await sleep(pause, ctrl.signal);
        pause = Math.min(pause * 2, 30_000);
      }
    })();
    return () => { ctrl.abort(); setLive(false); };
    // the client is made per render; the stream belongs to the chat it reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productionId, episodeId]);
  return live;
}
