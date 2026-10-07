import { useEffect, useState } from "react";
import { App as AntApp, InputNumber } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStudioClient, type ClaudeUsage } from "../../api/studio-client";

/** Claude calls at once (mockup 12, right column): what runs and waits; a Studio admin sets the cap. */
export function ClaudeSettingsForm({ usage, isAdmin }: { usage: ClaudeUsage; isAdmin: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useStudioClient();
  const qc = useQueryClient();
  const [value, setValue] = useState<number | null>(usage.max);
  useEffect(() => { setValue(usage.max); }, [usage.max]);
  const save = useMutation({
    mutationFn: (n: number) => client.setClaudeMaxConcurrent(n),
    onSuccess: (u) => {
      qc.setQueryData(["claude-usage"], u);
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void message.success(t("chat.claude.saved"));
    },
    onError: () => void message.error(t("chat.claude.saveFailed")),
  });
  return (
    <div className="chat-claude">
      <p>{t("chat.claude.now", { running: usage.running, max: usage.max })}</p>
      <p>{usage.waiting ? t("chat.claude.waiting", { n: usage.waiting }) : t("chat.claude.noneWaiting")}</p>
      <p className="chat-doc__note">{t("chat.claude.priority")}</p>
      {isAdmin ? (
        <form className="chat-claude__form" onSubmit={(e) => { e.preventDefault(); if (value) save.mutate(value); }}>
          <label htmlFor="claude-max">{t("chat.claude.max")}</label>
          <InputNumber id="claude-max" min={1} max={100} precision={0} value={value} onChange={(v) => setValue(v)} />
          <button type="submit" className="chat-card__button" disabled={!value || save.isPending || value === usage.max}>{t("chat.claude.save")}</button>
          <p className="chat-doc__note">{t("chat.claude.quotaNote")}</p>
        </form>
      ) : (
        <p className="chat-doc__note">{t(usage.source === "settings" ? "chat.claude.fromSettings" : "chat.claude.fromEnv")}</p>
      )}
    </div>
  );
}
