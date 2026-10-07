import { useQuery } from "@tanstack/react-query";
import { Clapperboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useStudioClient } from "../../api/studio-client";

/** Header chip: farm jobs not done of the videos one can see; opens the Queue screen. */
export function RenderChip() {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data } = useQuery({ queryKey: ["queue"], queryFn: () => client.getQueue(), refetchInterval: 5000 });
  if (!data) return null;
  return <Link to="/queue" className="chat-header__chip"><Clapperboard size={14} aria-hidden />{t("chat.queue.renderChip", { n: data.renders.length })}</Link>;
}
