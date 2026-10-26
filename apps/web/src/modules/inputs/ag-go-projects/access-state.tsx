import { Tag, Tooltip } from "antd";
import { CircleCheck } from "lucide-react";
import type { AgGoAddability } from "../../../api/workspace-client";
import { useAiTranslation } from "../../common/assistant-name";

/** Antd tag colour of each state a picker card shows. */
const COLOR: Record<AgGoAddability, string | undefined> = { addable: "blue", view_only: "warning", no_videos: undefined, not_visible: undefined };

/**
 * Whether an ag-go project can be added, as the picker's list and detail show it: added already, or its state for the
 * person (`POST ag-go-access`), with why it cannot be added on hover. Nothing while the state is not known yet.
 */
export function AccessTag({ state, added }: { state: AgGoAddability | undefined; added: boolean }) {
  const { t } = useAiTranslation();
  if (added) return <Tag color="success" icon={<CircleCheck size={12} style={{ marginRight: 4, verticalAlign: -2 }} />}>{t("ws.agp.added")}</Tag>;
  if (!state) return null;
  const tag = <Tag color={COLOR[state]}>{t(`ws.agp.state.${state}`)}</Tag>;
  return state === "addable" ? tag : <Tooltip title={t(`ws.agp.stateHelp.${state}`)}>{tag}</Tooltip>;
}

/** The same on a grid card, as one of its round badges. */
export function AccessBadge({ state, added }: { state: AgGoAddability | undefined; added: boolean }) {
  const { t } = useAiTranslation();
  if (added) return <div className="agp-badge agp-badge--added"><CircleCheck size={14} /><span>{t("ws.agp.added")}</span></div>;
  if (!state) return null;
  const badge = <div className={`agp-badge${state === "addable" ? " agp-badge--addable" : " agp-badge--muted"}`}><span>{t(`ws.agp.state.${state}`)}</span></div>;
  return state === "addable" ? badge : <Tooltip title={t(`ws.agp.stateHelp.${state}`)}>{badge}</Tooltip>;
}

/** Why Studio refused to add an ag-go project, from the code it answered; null for another error. */
export function refusedState(code: string | undefined): Exclude<AgGoAddability, "addable"> | null {
  if (code === "ag_go_view_only") return "view_only";
  if (code === "ag_go_no_videos") return "no_videos";
  if (code === "ag_go_not_visible") return "not_visible";
  return null;
}
