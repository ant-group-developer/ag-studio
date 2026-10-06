import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, AtSign, Folder, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAgGoClient } from "../../api/ag-go-client";
import { encodeMentions, insertMention, mentionQuery, mentionsIn, type FolderMention } from "./mentions";

interface Props {
  onSend: (text: string) => unknown | Promise<unknown>;
  placeholder?: string | undefined;
  /** Nothing can be sent now (the step is running); the reason shows as the placeholder. */
  disabled?: boolean | undefined;
  rows?: number | undefined;
  /** Text to start with (a quick-answer chip fills it). */
  value?: string | undefined;
  onValueChange?: ((v: string) => void) | undefined;
}

/** The chat box (mockup): Enter sends, Shift+Enter a new line, `@` picks an ag-go folder. */
export function ChatComposer({ onSend, placeholder, disabled, rows = 2, value, onValueChange }: Props) {
  const { t } = useTranslation();
  const agGo = useAgGoClient();
  const [own, setOwn] = useState("");
  const text = value ?? own;
  const setText = (v: string) => (onValueChange ? onValueChange(v) : setOwn(v));
  const [picked, setPicked] = useState<FolderMention[]>([]);
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const q = mentionQuery(text, caret);
  const { data } = useQuery({ queryKey: ["ag-go-folders"], queryFn: () => agGo.getFolders(), enabled: q !== null, staleTime: 60_000 });
  const options = useMemo(() => {
    if (!q || !data) return [];
    const needle = q.query.toLowerCase();
    return data.folders.filter((f) => f.name.toLowerCase().includes(needle)).slice(0, 8);
  }, [q, data]);

  const pick = (f: { id: string; name: string }) => {
    if (!q) return;
    const next = insertMention(text, q.start, caret, f.name);
    setText(next.text);
    setPicked((p) => (p.some((x) => x.id === f.id) ? p : [...p, { id: f.id, name: f.name }]));
    setCaret(next.caret);
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(next.caret, next.caret); });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || disabled || sending) return;
    setSending(true);
    try {
      await onSend(encodeMentions(body, picked));
      setText("");
      setPicked([]);
    } catch {
      // the caller says what went wrong; the text stays so it can be sent again
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (options.length && q) pick(options[0]!);
      else void send();
    }
  };

  const attached = mentionsIn(text, picked);
  return (
    <div className="chat-composer">
      {options.length > 0 ? (
        <ul className="chat-composer__folders" role="listbox" aria-label={t("chat.composer.folders")}>
          {options.map((f) => (
            <li key={f.id} role="option" aria-selected={false}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(f); }}>
                <Folder size={16} aria-hidden /><span>{f.name}</span>
                <span className="chat-composer__count">{t("chat.composer.videos", { n: f.usableVideos })}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {attached.length > 0 ? (
        <div className="chat-composer__chips">
          {attached.map((f) => (
            <span key={f.id} className="chat-mention">
              @{f.name}
              <button type="button" aria-label={t("chat.composer.removeFolder", { name: f.name })}
                onClick={() => { setText(text.split(`@${f.name}`).join(f.name)); setPicked((p) => p.filter((x) => x.id !== f.id)); }}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <form className="chat-composer__form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="chat-sr-only" htmlFor="chat-box">{t("chat.composer.label")}</label>
        <textarea
          id="chat-box" ref={box} rows={rows} value={text} disabled={disabled}
          placeholder={placeholder ?? t("chat.composer.placeholder")}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
        />
        <button type="button" className="chat-icon-button" aria-label={t("chat.composer.attach")} disabled={disabled}
          onClick={() => {
            const at = box.current?.selectionStart ?? text.length;
            const prefix = at > 0 && !/\s$/.test(text.slice(0, at)) ? " @" : "@";
            const next = text.slice(0, at) + prefix + text.slice(at);
            setText(next);
            setCaret(at + prefix.length);
            requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(at + prefix.length, at + prefix.length); });
          }}>
          <AtSign size={18} />
        </button>
        <button type="submit" className="chat-icon-button chat-icon-button--primary" aria-label={t("chat.composer.send")} disabled={disabled || sending || !text.trim()}>
          <ArrowRight size={18} />
        </button>
      </form>
    </div>
  );
}
