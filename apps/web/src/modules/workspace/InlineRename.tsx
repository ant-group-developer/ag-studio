import { useRef, useState } from "react";
import { App as AntApp, Input } from "antd";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type Project, type ProjectListItem, type Thread, type ThreadDetail, type Video } from "../../api/workspace-client";

/** The thread every project starts with: the page opens on it, found by this title, so it keeps it. */
export const CHANNEL_THREAD_TITLE = "Kênh";

/**
 * A title edited in place: Enter or leaving the box saves, Esc puts it back. An empty or unchanged title is not saved.
 */
export function InlineRename({ value, label, maxLength, onSave, onDone }: {
  value: string;
  /** What the box names, for screen readers. */
  label: string;
  maxLength: number;
  onSave: (title: string) => void;
  onDone: () => void;
}) {
  const [text, setText] = useState(value);
  // Enter and Esc end the edit, then the box unmounts and blurs: save once
  const ended = useRef(false);
  const end = (save: boolean) => {
    if (ended.current) return;
    ended.current = true;
    const next = text.trim();
    if (save && next && next !== value) onSave(next);
    onDone();
  };
  return (
    <Input size="small" className="ws-rename" autoFocus value={text} maxLength={maxLength} aria-label={label}
      onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} onBlur={() => end(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); end(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(false); }
      }} />
  );
}

export type Rename = { kind: "project" | "thread" | "video"; id: string; title: string };

/**
 * Renames the project, one of its chats or one of its videos. The new name shows at once (the nav, the header, the
 * page's title); if the API refuses it, the old one comes back and a toast says why.
 */
export function useRename(project: { id: string; teamId: string }) {
  const { t } = useTranslation();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const mutation = useMutation({
    mutationFn: (r: Rename): Promise<unknown> => r.kind === "project" ? client.updateProject(r.id, { name: r.title })
      : r.kind === "thread" ? client.renameThread(r.id, r.title) : client.updateVideo(r.id, { title: r.title }),
    onMutate: async (r) => ({ undo: await rewrite(qc, project, r) }),
    onError: (e, _r, ctx) => {
      ctx?.undo();
      void message.error(e instanceof StudioHttpError ? e.message : t("ws.rename.failed"));
    },
    onSuccess: (_x, r) => { if (r.kind === "project") void qc.invalidateQueries({ queryKey: ["projects", project.teamId] }); },
  });
  return (r: Rename) => mutation.mutate(r);
}

/** Writes the new title into every cached copy of it; returns what puts the old copies back. */
async function rewrite(qc: QueryClient, project: { id: string; teamId: string }, r: Rename): Promise<() => void> {
  const saved: [readonly unknown[], unknown][] = [];
  const edit = async <T,>(key: readonly unknown[], fn: (x: T) => T) => {
    await qc.cancelQueries({ queryKey: key, exact: true });
    const old = qc.getQueryData<T>(key);
    if (old === undefined) return;
    saved.push([key, old]);
    qc.setQueryData<T>(key, fn(old));
  };
  type ProjectData = Project & { videos: Video[] };
  const projectId = project.id;
  if (r.kind === "project") {
    await edit<ProjectData>(["project", projectId], (p) => ({ ...p, name: r.title }));
    // the header's project switch names it from the team's list
    await edit<{ projects: ProjectListItem[] }>(["projects", project.teamId], (d) => ({ ...d, projects: d.projects.map((p) => p.id === projectId ? { ...p, name: r.title } : p) }));
  } else if (r.kind === "thread") {
    await edit<{ threads: Thread[] }>(["threads", projectId], (d) => ({ ...d, threads: d.threads.map((x) => x.id === r.id ? { ...x, title: r.title } : x) }));
    await edit<ThreadDetail>(["thread", r.id], (x) => ({ ...x, title: r.title }));
  } else {
    await edit<ProjectData>(["project", projectId], (p) => ({ ...p, videos: p.videos.map((v) => v.id === r.id ? { ...v, title: r.title } : v) }));
    await edit<Video>(["video", r.id], (v) => ({ ...v, title: r.title }));
  }
  return () => { for (const [key, old] of saved) qc.setQueryData(key, old); };
}
