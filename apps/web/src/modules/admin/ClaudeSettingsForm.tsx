import { useEffect, useState } from "react";
import { App as AntApp, InputNumber } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStudioClient, type ClaudeUsage } from "../../api/studio-client";
import { useAiTranslation } from "../common/assistant-name";

/** Claude calls at once (Queue, right column): what runs and waits; a Studio admin sets the cap. */
export function ClaudeSettingsForm({ usage, isAdmin }: { usage: ClaudeUsage; isAdmin: boolean }) {
  const { t } = useAiTranslation();
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
      void message.success(t("ws.admin.claude.saved"));
    },
    onError: () => void message.error(t("ws.admin.claude.saveFailed")),
  });
  return (
    <div>
      <p>{t("ws.admin.claude.now", { running: usage.running, max: usage.max })}</p>
      <p>{usage.waiting ? t("ws.admin.claude.waiting", { n: usage.waiting }) : t("ws.admin.claude.noneWaiting")}</p>
      <p className="ws-admin__note">{t("ws.admin.claude.priority")}</p>
      {isAdmin ? (
        <form className="ws-admin__form" onSubmit={(e) => { e.preventDefault(); if (value) save.mutate(value); }}>
          <label htmlFor="claude-max">{t("ws.admin.claude.max")}</label>
          <InputNumber id="claude-max" min={1} max={100} precision={0} value={value} onChange={(v) => setValue(v)} />
          <button type="submit" className="ws-admin__button" disabled={!value || save.isPending || value === usage.max}>{t("ws.admin.claude.save")}</button>
          <p className="ws-admin__note">{t("ws.admin.claude.quotaNote")}</p>
        </form>
      ) : (
        <p className="ws-admin__note">{t(usage.source === "settings" ? "ws.admin.claude.fromSettings" : "ws.admin.claude.fromEnv")}</p>
      )}
    </div>
  );
}
