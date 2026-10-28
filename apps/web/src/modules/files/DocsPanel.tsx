import { useMemo, useRef, useState } from "react";
import { Button, Modal, Segmented, Spin, Tooltip } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Braces, ChevronDown, ChevronRight, FilePlus, FileText, Film, Image as ImageIcon, Music, RefreshCw, TrendingUp, Upload } from "lucide-react";
import { useStudioClient } from "../../api/studio-client";
import { useWorkspaceClient } from "../../api/workspace-client";
import { useAiTranslation } from "../common/assistant-name";
import { ResearchPanel } from "../research/ResearchPanel";
import { relativeTime } from "../workspace/time";
import { docGroups, type DocGroup, type DocItem, type DocKind } from "./doc-groups";
import { FilesPanel } from "./FilesPanel";
import { FileView } from "./FileView";
import { NewFileModal, useFileActions } from "./use-file-actions";

const ICON: Record<DocKind, typeof FileText> = { doc: FileText, image: ImageIcon, audio: Music, video: Film, data: Braces };
/** An admin's choice of the documents or the whole folder, kept in this browser. */
const VIEW_KEY = "studio.docs.view";
type View = "docs" | "tree";

function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "docs"; } catch { return "docs"; }
}

/**
 * The Documents tab (plan 2026-10-28 P2): the channel's documents, each video's (the open one first), research and
 * the files people added, by name and without Studio's and the agent's own files; add a file, write a new one, run a
 * research crawl. A Studio admin may switch to the whole folder (`FilesPanel`). The open file shows in place.
 */
export function DocsPanel({ projectId, videos, currentVideoId, canEdit, canRun, openPath, onOpen, onAttach }: {
  projectId: string;
  videos: { id: string; idx: number; title: string }[];
  currentVideoId?: string | undefined;
  canEdit: boolean;
  /** May start a research crawl (editor). */
  canRun: boolean;
  openPath: string | null;
  onOpen: (path: string | null) => void;
  onAttach?: ((path: string) => void) | undefined;
}) {
  const { t, i18n } = useAiTranslation();
  const client = useWorkspaceClient();
  const studio = useStudioClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => studio.getMe(), staleTime: 5 * 60_000 });
  const isAdmin = me?.isAdmin ?? false;
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* this visit only */ } };
  const files = useQuery({ queryKey: ["files", projectId], queryFn: () => client.listFiles(projectId) });
  const research = useQuery({ queryKey: ["research", projectId], queryFn: () => client.listResearch(projectId) });
  const groups = useMemo(() => docGroups(files.data?.entries ?? [], videos, {
    currentVideoId, researchTitles: new Map((research.data?.files ?? []).map((f) => [f.path, f.title])),
  }), [files.data, research.data, videos, currentVideoId]);
  // the other videos start folded when one is open; everything else open
  const [folded, setFolded] = useState<Set<string>>(() => new Set(currentVideoId ? videos.filter((v) => v.id !== currentVideoId).map((v) => `video:${v.id}`) : []));
  const toggle = (key: string) => setFolded((f) => { const next = new Set(f); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const [creating, setCreating] = useState(false);
  const [researching, setResearching] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const { create, upload, uploading } = useFileActions(projectId, (path) => { setCreating(false); onOpen(path); });

  const nameOf = (x: DocItem) => (x.nameKey ? t(`ws.docs.name.${x.nameKey}`, x.params ?? {}) : x.name);
  const titleOf = (g: DocGroup) => (g.video ? t("ws.docs.group.video", { idx: g.video.idx, title: g.video.title }) : t(`ws.docs.group.${g.key}`));
  const tree = isAdmin && view === "tree";
  const viewSwitch = isAdmin ? (
    <Segmented<View> size="small" value={view} onChange={setView} aria-label={t("ws.docs.view")}
      options={[{ value: "docs", label: t("ws.docs.viewDocs") }, { value: "tree", label: t("ws.docs.viewTree") }]} />
  ) : null;

  if (tree) {
    return (
      <div className="ws-docs ws-docs--tree">
        <div className="ws-docs__bar">{viewSwitch}</div>
        <FilesPanel projectId={projectId} canEdit={canEdit} openPath={openPath} onOpen={onOpen} onAttach={onAttach} />
      </div>
    );
  }
  if (openPath) {
    const entry = files.data?.entries.find((e) => e.path === openPath);
    // its name as the list says it (a video's documents with the video's number); a file outside the list by its path
    const group = groups.find((g) => g.items.some((x) => x.path === openPath));
    const item = group?.items.find((x) => x.path === openPath);
    const title = item ? (group?.video ? `#${group.video.idx} · ${nameOf(item)}` : nameOf(item)) : undefined;
    return (
      <div className="ws-files">
        <FileView projectId={projectId} path={openPath} title={title} access={entry?.access ?? "write"} canEdit={canEdit}
          onBack={() => onOpen(null)} onDeleted={() => onOpen(null)} onAttach={onAttach} />
      </div>
    );
  }

  return (
    <div className="ws-docs">
      <div className="ws-docs__bar">
        {viewSwitch}
        <span className="ws-spacer" />
        {canEdit ? (
          <>
            <Tooltip title={t("ws.docs.addHint")}>
              <Button size="small" icon={<Upload size={14} />} loading={upload.isPending} onClick={() => uploadInput.current?.click()}>
                {uploading.percent !== null ? t("common.uploading", { pct: uploading.percent }) : t("ws.docs.add")}
              </Button>
            </Tooltip>
            <input ref={uploadInput} type="file" multiple hidden aria-label={t("ws.docs.add")}
              onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ""; if (list.length) upload.mutate({ files: list, folder: "context" }); }} />
            <Button size="small" icon={<FilePlus size={14} />} onClick={() => setCreating(true)}>{t("ws.docs.newDoc")}</Button>
          </>
        ) : null}
        <Tooltip title={t("common.refresh")}>
          <button type="button" className="ws-icon-button" aria-label={t("common.refresh")} disabled={files.isFetching}
            onClick={() => { void files.refetch(); void research.refetch(); }}><RefreshCw size={15} /></button>
        </Tooltip>
      </div>
      {files.isLoading ? <div className="ws-center"><Spin /></div> : (
        <div className="ws-docs__groups" aria-label={t("ws.docs.list")}>
          {groups.map((g) => {
            const open = !folded.has(g.key);
            return (
              <section key={g.key} className="ws-docs__group" aria-label={titleOf(g)}>
                <div className="ws-docs__head">
                  <button type="button" className="ws-docs__toggle" aria-expanded={open} onClick={() => toggle(g.key)}>
                    {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                    <span className="ws-docs__title">{titleOf(g)}</span>
                    {g.items.length ? <span className="ws-hint">{g.items.length}</span> : null}
                  </button>
                  {g.key === "research" && canRun ? (
                    <Button size="small" type="text" icon={<TrendingUp size={14} />} onClick={() => setResearching(true)}>{t("ws.docs.runResearch")}</Button>
                  ) : null}
                </div>
                {open ? (g.items.length ? (
                  <ul className="ws-docs__list">
                    {g.items.map((x, _, all) => {
                      const Icon = ICON[x.kind];
                      // two documents of one name (renders of separate runs) tell apart by the hour they were made
                      const twin = all.some((y) => y !== x && nameOf(y) === nameOf(x));
                      const when = twin ? new Date(x.mtime).toLocaleString(i18n.language, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : relativeTime(x.mtime, i18n.language);
                      return (
                        <li key={x.path}>
                          <button type="button" className="ws-docs__item" title={isAdmin ? x.path : undefined} onClick={() => onOpen(x.path)}>
                            <Icon size={15} aria-hidden />
                            <span className="ws-docs__name">{nameOf(x)}</span>
                            <span className="ws-hint">{when}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="ws-hint ws-docs__empty">{t(g.video ? "ws.docs.empty.video" : "ws.docs.empty.research")}</p>) : null}
              </section>
            );
          })}
        </div>
      )}
      <NewFileModal open={creating} initial="context/ghi-chu.md" busy={create.isPending} onCreate={(path) => create.mutate(path)} onClose={() => setCreating(false)} />
      <Modal open={researching} title={t("ws.docs.runResearch")} footer={null} onCancel={() => setResearching(false)} width={640} destroyOnHidden>
        <ResearchPanel projectId={projectId} canRun={canRun} showFiles={false} onOpenFile={(path) => { setResearching(false); onOpen(path); }} />
      </Modal>
    </div>
  );
}
