import { Drawer, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useWorkspaceClient, type DiffHunk, type VersionDiff } from "../../api/workspace-client";

/** Lines with no change between `prev` and `next` (or before the first hunk), folded into one row. */
function skipped(prev: DiffHunk | null, next: DiffHunk): number {
  // a hunk with no old lines starts after line old_start (unified-diff convention)
  const firstOld = next.old_lines ? next.old_start : next.old_start + 1;
  const lastOld = !prev ? 0 : prev.old_lines ? prev.old_start + prev.old_lines - 1 : prev.old_start;
  return Math.max(0, firstOld - lastOld - 1);
}

/**
 * A unified diff as people read it: added lines green, removed red, old and new line numbers, the unchanged lines
 * between changes folded into "N dòng không đổi"; or why it cannot be shown.
 */
export function DiffView({ diff }: { diff: VersionDiff }) {
  const { t } = useTranslation();
  if (diff.unavailable) return <p className="ws-diff__note">{t(diff.unavailable === "binary" ? "ws.changes.binary" : "ws.changes.tooLarge")}</p>;
  if (!diff.hunks.length) return <p className="ws-diff__note">{t("ws.changes.none")}</p>;
  return (
    <div className="ws-diff">
      <div className="ws-diff__stats">
        <span className="ws-diff__add">+{diff.added}</span> <span className="ws-diff__del">−{diff.removed}</span>
      </div>
      <table className="ws-diff__table" aria-label={t("ws.changes.diffNamed", { file: diff.path })}>
        <tbody>
          {diff.hunks.map((h, hi) => {
            let o = h.old_start;
            let n = h.new_start;
            const gap = skipped(hi ? diff.hunks[hi - 1]! : null, h);
            return [
              gap > 0 ? (
                <tr key={`gap${hi}`} className="ws-diff__gap"><td colSpan={4}>{t("ws.changes.unchanged", { count: gap })}</td></tr>
              ) : null,
              ...h.lines.map((l, li) => {
                const oldNo = l.kind === "add" ? "" : o++;
                const newNo = l.kind === "del" ? "" : n++;
                return (
                  <tr key={`${hi}-${li}`} className={`ws-diff__row ws-diff__row--${l.kind}`}>
                    <td className="ws-diff__num">{oldNo}</td>
                    <td className="ws-diff__num">{newNo}</td>
                    <td className="ws-diff__sign" aria-hidden>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</td>
                    <td className="ws-diff__text">{l.text || " "}</td>
                  </tr>
                );
              }),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Loads what version `versionId` changed (against `base`, or the version before it) and shows it. */
export function VersionDiffPanel({ projectId, versionId, base }: { projectId: string; versionId: string; base?: string | null }) {
  const { t } = useTranslation();
  const client = useWorkspaceClient();
  const q = useQuery({
    queryKey: ["file-diff", projectId, versionId, base ?? null],
    queryFn: () => client.fileVersionDiff(projectId, versionId, base),
    staleTime: Infinity,
  });
  if (q.isLoading) return <div className="ws-center"><Spin /></div>;
  if (q.error || !q.data) return <p className="ws-diff__note">{t("ws.changes.loadFailed")}</p>;
  return <DiffView diff={q.data} />;
}

/** "Xem thay đổi" of a file a turn changed, in a drawer beside the chat. */
export function DiffDrawer({ projectId, file, onClose }: {
  projectId: string;
  file: { path: string; versionId: string; base: string | null } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Drawer open={!!file} onClose={onClose} width="min(820px, 100vw)" destroyOnHidden title={file ? t("ws.changes.drawerTitle", { file: file.path }) : ""}>
      {file ? <VersionDiffPanel projectId={projectId} versionId={file.versionId} base={file.base} /> : null}
    </Drawer>
  );
}
