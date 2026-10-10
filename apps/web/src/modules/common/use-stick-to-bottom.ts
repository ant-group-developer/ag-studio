import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How close to the end (px) still counts as "reading the newest message". */
const NEAR = 80;

/**
 * The chat column scrolls on its own: it opens at the newest message and follows new ones while the person is
 * at the end; once they scroll up to read, it stays put and offers a way back down.
 * `page` changes when another thread opens; `signal` changes when the thread gets or updates a message.
 */
export function useStickToBottom(page: string, signal: string) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    stuck.current = true;
    setAtBottom(true);
  }, [page]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [page, signal]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
    stuck.current = near;
    setAtBottom(near);
  };

  /** Back to the newest message, and follow again. */
  const toBottom = () => {
    const el = ref.current;
    stuck.current = true;
    setAtBottom(true);
    if (!el) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  };

  return { ref, onScroll, atBottom, toBottom };
}
