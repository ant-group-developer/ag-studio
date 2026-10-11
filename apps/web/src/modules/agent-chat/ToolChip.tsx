import { useState } from "react";
import { Check, ChevronRight, FileText, Loader2, Wrench, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentPart } from "../../api/workspace-client";
import { useNow } from "../common/sse";
import { clock } from "../workspace/time";
import { toolKey, toolLabel, toolTarget } from "./labels";

type ToolPart = Extract<AgentPart, { kind: "tool" }>;

const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

/**
 * One tool call of the agent: what and on what, a spinner and a running clock while it runs, then how long it took;
 * open it to see the input and the (shortened) answer. A file it read or wrote opens in the files panel.
 */
export function ToolChip({ part, onOpenFile }: { part: ToolPart; onOpenFile?: ((path: string) => void) | undefined }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const running = !part.ended_at;
  const now = useNow(1000, running);
  const seconds = ((part.ended_at ? Date.parse(part.ended_at) : now) - Date.parse(part.started_at)) / 1000;
  const target = toolTarget(part, t);
  const icon = running ? <Loader2 size={13} className="ws-spin" aria-hidden /> : part.is_error ? <X size={13} aria-hidden /> : <Check size={13} aria-hidden />;
  const fileTarget = FILE_TOOLS.has(part.name) && target && !part.is_error ? target : null;
  return (
    <div className={`ws-tool${part.is_error ? " ws-tool--error" : ""}${running ? " ws-tool--running" : ""}`}>
      <button type="button" className="ws-tool__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="ws-tool__caret" aria-hidden />
        {icon}
        {FILE_TOOLS.has(part.name) ? <FileText size={13} aria-hidden /> : <Wrench size={13} aria-hidden />}
        <span className="ws-tool__name" title={toolKey(part.name)}>{toolLabel(t, part.name)}</span>
        {target ? <span className="ws-tool__target" title={target}>{target}</span> : null}
        <span className="ws-tool__time">{Number.isFinite(seconds) ? clock(seconds) : ""}</span>
      </button>
      {open ? (
        <div className="ws-tool__body">
          {fileTarget && onOpenFile ? (
            <button type="button" className="ws-link" onClick={() => onOpenFile(fileTarget)}>{t("ws.chat.openFile")}</button>
          ) : null}
          {part.input !== null && part.input !== undefined ? <pre>{JSON.stringify(part.input, null, 2)}</pre> : null}
          {part.result ? <pre className="ws-tool__result">{part.result}</pre> : running ? <p>{t("ws.chat.toolRunning")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
