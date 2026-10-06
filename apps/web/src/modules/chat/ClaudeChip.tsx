import { useState } from "react";
import { App as AntApp, InputNumber, Popover } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStudioClient, type ClaudeUsage } from "../../api/studio-client";

function Settings({ usage, isAdmin }: { usage: ClaudeUsage; isAdmin: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useStudioClient();
  const qc = useQueryClient();
  const [value, setValue] = useState<number | null>(usage.max);
  const save = useMutation({
    mutationFn: (n: number) => client.setClaudeMaxConcurrent(n),
    onSuccess: (u) => {
      qc.setQueryData(["claude-usage"], u);
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

/** Header chip: Claude calls running against the cap and replies waiting; a Studio admin sets the cap from here. */
export function ClaudeChip() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data } = useQuery({ queryKey: ["claude-usage"], queryFn: () => client.getClaudeUsage(), refetchInterval: 5000 });
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  if (!data) return null;
  return (
    <Popover trigger="click" placement="bottomRight" title={t("chat.claude.title")} content={<Settings usage={data} isAdmin={me?.isAdmin ?? false} />}>
      <button type="button" className="chat-link-button">
        {t("chat.claudeChip", { running: data.running, max: data.max })}
        {data.waiting > 0 ? ` · ${t("chat.claudeWaiting", { n: data.waiting })}` : ""}
      </button>
    </Popover>
  );
}
