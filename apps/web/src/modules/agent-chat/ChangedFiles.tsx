import { useState } from "react";
import { FileDiff, FilePen, FilePlus, FileX, SquareArrowOutUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChangedFile } from "../../api/workspace-client";
import { DiffDrawer } from "../files/DiffView";

const ICONS = { added: FilePlus, modified: FilePen, deleted: FileX } as const;

/**
 * The files a turn changed, under its answer (as Claude's desktop app shows them): path, new / edited / deleted,
 * lines added and removed; open it in the files panel, or see what changed in a drawer.
 */
export function ChangedFiles({ projectId, files, onOpenFile }: {
  projectId: string;
  files: ChangedFile[];
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const [diff, setDiff] = useState<{ path: string; versionId: string; base: string | null } | null>(null);
  if (!files.length) return null;
  return (
    <section className="ws-changes" aria-label={t("ws.changes.title", { count: files.length })}>
      <div className="ws-changes__head">{t("ws.changes.title", { count: files.length })}</div>
      <ul className="ws-changes__list">
        {files.map((f) => {
          const Icon = ICONS[f.change];
          return (
            <li key={f.path} className="ws-changes__row">
              <Icon size={14} className={`ws-changes__icon ws-changes__icon--${f.change}`} aria-hidden />
              <span className="ws-changes__path" title={f.path}>{f.path}</span>
              <span className={`ws-changes__badge ws-changes__badge--${f.change}`}>{t(`ws.changes.${f.change}`)}</span>
              {f.added !== undefined && f.removed !== undefined ? (
                <span className="ws-changes__lines">
                  <span className="ws-diff__add">+{f.added}</span> <span className="ws-diff__del">−{f.removed}</span>
                </span>
              ) : null}
              <span className="ws-changes__actions">
                {f.change !== "deleted" && onOpenFile ? (
                  <button type="button" className="ws-tool__open" aria-label={t("ws.chat.openNamed", { file: f.path })} onClick={() => onOpenFile(f.path)}>
                    <SquareArrowOutUpRight size={12} aria-hidden /> {t("ws.chat.open")}
                  </button>
                ) : null}
                <button type="button" className="ws-tool__open" aria-label={t("ws.changes.diffNamed", { file: f.path })}
                  onClick={() => setDiff({ path: f.path, versionId: f.version_id, base: f.before_version_id ?? "none" })}>
                  <FileDiff size={12} aria-hidden /> {t("ws.changes.diff")}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <DiffDrawer projectId={projectId} file={diff} onClose={() => setDiff(null)} />
    </section>
  );
}
