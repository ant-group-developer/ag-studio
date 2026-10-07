import { useEffect, useState } from "react";
import { App as AntApp, Input } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStudioClient } from "../../api/studio-client";
import { DEFAULT_ASSISTANT_NAME, useAiTranslation, useAssistantName } from "../common/assistant-name";

/** The name the web shows for the AI (Queue, right column): a Studio admin changes it; display only. */
export function AssistantNameForm() {
  const { t } = useAiTranslation();
  const { message } = AntApp.useApp();
  const client = useStudioClient();
  const qc = useQueryClient();
  const current = useAssistantName();
  const [value, setValue] = useState(current);
  useEffect(() => { setValue(current); }, [current]);
  const save = useMutation({
    mutationFn: (name: string) => client.setAssistantName(name),
    onSuccess: (u) => {
      qc.setQueryData(["claude-usage"], u);
      void message.success(t("chat.assistant.saved"));
    },
    onError: () => void message.error(t("chat.assistant.saveFailed")),
  });
  const next = value.trim() || DEFAULT_ASSISTANT_NAME;
  return (
    <form className="chat-claude chat-claude__form" onSubmit={(e) => { e.preventDefault(); save.mutate(value.trim()); }}>
      <label htmlFor="assistant-name">{t("chat.assistant.label")}</label>
      <Input id="assistant-name" value={value} maxLength={40} placeholder={DEFAULT_ASSISTANT_NAME} onChange={(e) => setValue(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
      <button type="submit" className="chat-card__button" disabled={save.isPending || next === current}>{t("chat.assistant.save")}</button>
      <p className="chat-doc__note">{t("chat.assistant.hint", { name: DEFAULT_ASSISTANT_NAME })}</p>
    </form>
  );
}
