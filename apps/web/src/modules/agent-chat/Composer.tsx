import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { useAiTranslation } from "../common/assistant-name";

/**
 * The message box: Enter sends, Shift+Enter makes a new line. While a turn runs the send button becomes Stop (a new
 * message still goes: it gets the next turn). Files pointed at from the files panel ride along as attachments.
 */
export function Composer({ onSend, onStop, running, disabled, attachments, onRemoveAttachment, draft, onDraftChange, placeholder }: {
  onSend: (text: string) => Promise<unknown> | void;
  onStop?: (() => void) | undefined;
  running: boolean;
  disabled?: boolean;
  attachments: string[];
  onRemoveAttachment: (path: string) => void;
  draft: string;
  onDraftChange: (text: string) => void;
  placeholder?: string;
}) {
  const { t } = useAiTranslation();
  const box = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft]);

  const send = async () => {
    const text = draft.trim();
    if (!text || disabled || sending) return;
    setSending(true);
    try {
      await onSend(text);
      onDraftChange("");
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="ws-composer">
      {attachments.length ? (
        <div className="ws-attachments">
          {attachments.map((a) => (
            <span key={a} className="ws-attachment">
              <Paperclip size={12} aria-hidden />{a}
              <button type="button" aria-label={t("ws.chat.removeAttachment", { path: a })} onClick={() => onRemoveAttachment(a)}><X size={12} /></button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="ws-composer__row">
        <textarea
          ref={box} rows={1} value={draft} disabled={disabled} placeholder={placeholder ?? t("ws.chat.placeholder")}
          aria-label={t("ws.chat.inputLabel")} onChange={(e) => onDraftChange(e.target.value)} onKeyDown={onKeyDown}
        />
        {running && onStop && !draft.trim() ? (
          <button type="button" className="ws-composer__button ws-composer__button--stop" onClick={onStop} aria-label={t("ws.chat.stop")} title={t("ws.chat.stop")}>
            <Square size={14} aria-hidden />
          </button>
        ) : (
          <button type="button" className="ws-composer__button" onClick={() => void send()} disabled={disabled || sending || !draft.trim()} aria-label={t("ws.chat.send")} title={t("ws.chat.send")}>
            <ArrowUp size={16} aria-hidden />
          </button>
        )}
      </div>
      <div className="ws-composer__hint">{running ? t("ws.chat.hintRunning") : t("ws.chat.hint")}</div>
    </div>
  );
}
