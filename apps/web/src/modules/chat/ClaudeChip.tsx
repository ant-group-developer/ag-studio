import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useStudioClient } from "../../api/studio-client";

/** Header chip: Claude calls running against the cap and replies waiting; opens the Queue screen. */
export function ClaudeChip() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data } = useQuery({ queryKey: ["claude-usage"], queryFn: () => client.getClaudeUsage(), refetchInterval: 5000 });
  if (!data) return null;
  return (
    <Link to="/queue" className={data.waiting > 0 ? "chat-header__chip chat-header__chip--busy" : "chat-header__chip"}>
      <Sparkles size={14} aria-hidden />
      {t("chat.claudeChip", { running: data.running, max: data.max })}
      {data.waiting > 0 ? ` · ${t("chat.claudeWaiting", { n: data.waiting })}` : ""}
    </Link>
  );
}
