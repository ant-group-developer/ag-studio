import { useQuery } from "@tanstack/react-query";
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
    <Link to="/queue" className="chat-link-button">
      {t("chat.claudeChip", { running: data.running, max: data.max })}
      {data.waiting > 0 ? ` · ${t("chat.claudeWaiting", { n: data.waiting })}` : ""}
    </Link>
  );
}
