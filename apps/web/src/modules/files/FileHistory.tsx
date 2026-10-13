import { useState } from "react";
import { App as AntApp, Button, Spin } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type FileVersion } from "../../api/workspace-client";
import { relativeTime } from "../workspace/time";
import { VersionDiffPanel } from "./DiffView";
import { isMarkdown } from "./file-tree";
import { Markdown } from "./Markdown";

const AUTHOR_KEYS: Record<FileVersion["author_kind"], string> = { user: "ws.files.byUser", agent: "ws.files.byAgent", studio: "ws.files.byStudio" };

/**
 * Every saved version of a file (who wrote it, when); open one to read it, compare it with the version before it, or
 * restore it as the current file.
 */
export function FileHistory({ projectId, path, currentSha, canRestore, onRestored }: {
  projectId: string;
  path: string;
  currentSha: string;
  canRestore: boolean;
  onRestored: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<"content" | "diff">("content");
  const { data, isLoading } = useQuery({ queryKey: ["file-versions", projectId, path], queryFn: () => client.listFileVersions(projectId, path) });
  const { data: version } = useQuery({
    queryKey: ["file-version", projectId, open],
    queryFn: () => client.getFileVersion(projectId, open!),
    enabled: !!open,
  });
  const restore = useMutation({
    mutationFn: (id: string) => client.restoreFileVersion(projectId, id, currentSha),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["file", projectId, path] });
      void qc.invalidateQueries({ queryKey: ["file-versions", projectId, path] });
      void message.success(t("ws.files.restored"));
      onRestored();
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.files.restoreFailed")),
  });

  if (isLoading) return <div className="ws-center"><Spin /></div>;
  const versions = data?.versions ?? [];
  if (!versions.length) return <p>{t("ws.files.noVersions")}</p>;
  return (
    <div>
      <ul className="ws-versions">
        {versions.map((v) => (
          <li key={v.id}>
            <button type="button" aria-current={open === v.id} onClick={() => setOpen(open === v.id ? null : v.id)}>
              <span>{v.sha256 === "" ? t("ws.files.deletedVersion") : t(AUTHOR_KEYS[v.author_kind])}{v.sha256 === currentSha ? ` · ${t("ws.files.current")}` : ""}</span>
              <small>{relativeTime(v.created_at, i18n.language)}</small>
            </button>
          </li>
        ))}
      </ul>
      {open && version ? (
        <div style={{ marginTop: 12 }}>
          <div className="ws-version-actions">
            <Button size="small" aria-pressed={view === "diff"} onClick={() => setView(view === "diff" ? "content" : "diff")}>
              {t(view === "diff" ? "ws.changes.showContent" : "ws.changes.compare")}
            </Button>
            {canRestore && version.content !== null && version.sha256 !== currentSha ? (
              <Button size="small" type="primary" onClick={() => restore.mutate(version.id)} loading={restore.isPending}>
                {t("ws.files.restore")}
              </Button>
            ) : null}
          </div>
          {view === "diff" ? <VersionDiffPanel projectId={projectId} versionId={version.id} />
            : version.content === null ? <p>{t("ws.files.noContent")}</p>
            : isMarkdown(path) ? <Markdown text={version.content} /> : <pre className="ws-file__pre">{version.content}</pre>}
        </div>
      ) : null}
    </div>
  );
}
