import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Spin, Tooltip } from "antd";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, Image as ImageIcon, Lock, RefreshCw, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkspaceClient } from "../../api/workspace-client";
import { ancestors, buildTree, type TreeNode } from "./file-tree";
import { FileView } from "./FileView";
import { NewFileModal, useFileActions } from "./use-file-actions";

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const DEFAULT_OPEN = new Set(["context", "research", "channel", "memory"]);
/** Below this width the tree beside an open file lays over it instead of squeezing it. */
const SPLIT_MIN = 440;
const TREE_KEY = "studio.files.tree";

/** Whether the element is narrower than `min` (wide when the browser cannot tell). */
function useNarrow(ref: RefObject<HTMLElement>, min: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setNarrow((e?.contentRect.width ?? min) < min));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min]);
  return narrow;
}

/** The tree beside an open file: shown unless hidden once (kept in this browser). */
function useTreeShown(): [boolean, (v: boolean) => void] {
  const [shown, setShown] = useState(() => { try { return localStorage.getItem(TREE_KEY) !== "hidden"; } catch { return true; } });
  return [shown, (v) => { setShown(v); try { localStorage.setItem(TREE_KEY, v ? "shown" : "hidden"); } catch { /* this visit only */ } }];
}

function TreeRows({ nodes, open, toggle, selected, onPick }: {
  nodes: TreeNode[];
  open: Set<string>;
  toggle: (path: string) => void;
  selected: string | null;
  onPick: (node: TreeNode) => void;
}) {
  return (
    <>
      {nodes.map((n) => (
        <li key={n.path}>
          <button
            type="button" className="ws-tree__row" aria-current={selected === n.path}
            aria-expanded={n.kind === "dir" ? open.has(n.path) : undefined}
            onClick={() => (n.kind === "dir" ? toggle(n.path) : onPick(n))}
          >
            {n.kind === "dir" ? (open.has(n.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span style={{ width: 14 }} />}
            {n.kind === "dir" ? <Folder size={15} /> : IMAGE.test(n.name) ? <ImageIcon size={15} /> : <FileText size={15} />}
            <span className="ws-tree__name" title={n.path}>{n.name}</span>
            {n.access === "read" ? <Lock size={12} aria-hidden /> : null}
          </button>
          {n.kind === "dir" && open.has(n.path) && n.children.length ? (
            <ul><TreeRows nodes={n.children} open={open} toggle={toggle} selected={selected} onPick={onPick} /></ul>
          ) : null}
        </li>
      ))}
    </>
  );
}

/**
 * The project's files (spec 2026-10-10 agent-workspace §3.1): the tree, a new file, uploads, and the open file with the
 * tree beside it (laid over it when the panel is narrow). `openPath`/`onOpen` let the page and the chat open a file here.
 */
export function FilesPanel({ projectId, canEdit, openPath, onOpen, onAttach }: {
  projectId: string;
  canEdit: boolean;
  openPath: string | null;
  onOpen: (path: string | null) => void;
  /** Adds a file to the message being written in the chat (absent: no chat to add to). */
  onAttach?: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const client = useWorkspaceClient();
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ["files", projectId], queryFn: () => client.listFiles(projectId) });
  const tree = useMemo(() => buildTree(data?.entries ?? []), [data]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(DEFAULT_OPEN));
  const [folder, setFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(box, SPLIT_MIN);
  const [treeShown, setTreeShown] = useTreeShown();
  const [overlay, setOverlay] = useState(false);
  const besideShown = narrow ? overlay : treeShown;

  const writableFolder = (path: string) => (data?.entries.find((e) => e.path === path)?.access ?? "none") === "write";

  const toggle = (path: string) => {
    setFolder(path);
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };
  const pick = (n: TreeNode) => {
    setOpen((o) => new Set([...o, ...ancestors(n.path)]));
    setOverlay(false);
    onOpen(n.path);
  };
  useEffect(() => { if (openPath) setOpen((o) => new Set([...o, ...ancestors(openPath)])); }, [openPath]);

  const { create, upload, uploading } = useFileActions(projectId, (path) => { setCreating(null); onOpen(path); });
  const openEntry = data?.entries.find((e) => e.path === openPath);

  const treeList = isLoading ? <div className="ws-center"><Spin /></div> : (
    <ul className="ws-tree" aria-label={t("ws.files.tree")}>
      <TreeRows nodes={tree} open={open} toggle={toggle} selected={openPath} onPick={pick} />
    </ul>
  );

  if (openPath) {
    return (
      <div ref={box} className={`ws-files ws-files--split${narrow ? " ws-files--narrow" : ""}`}>
        {besideShown ? (
          <>
            {narrow ? <div className="ws-files__scrim" aria-hidden onClick={() => setOverlay(false)} /> : null}
            <div className="ws-files__side" onKeyDown={(e) => { if (e.key === "Escape") setOverlay(false); }}>{treeList}</div>
          </>
        ) : null}
        <FileView
          projectId={projectId} path={openPath} access={openEntry?.access ?? "write"} canEdit={canEdit}
          onBack={() => onOpen(null)} onDeleted={() => onOpen(null)} onAttach={onAttach}
          tree={{ shown: besideShown, toggle: () => (narrow ? setOverlay(!overlay) : setTreeShown(!treeShown)) }}
        />
      </div>
    );
  }

  return (
    <div ref={box} className="ws-files">
      <div className="ws-files__bar">
        <span className="ws-files__bar-title">{folder ?? t("ws.files.root")}</span>
        {canEdit ? (
          <>
            <Tooltip title={t("ws.files.newFile")}>
              <button type="button" className="ws-icon-button" aria-label={t("ws.files.newFile")} onClick={() => {
                const base = folder && writableFolder(folder) ? folder : "context";
                setCreating(`${base}/ghi-chu.md`);
              }}><FilePlus size={16} /></button>
            </Tooltip>
            <Tooltip title={t("ws.files.upload")}>
              <button type="button" className="ws-icon-button" aria-label={t("ws.files.upload")} disabled={upload.isPending} onClick={() => uploadInput.current?.click()}>
                {upload.isPending ? (uploading.percent !== null ? <span className="ws-upload-pct" title={t("common.uploading", { pct: uploading.percent })}>{uploading.percent}%</span> : <Spin size="small" />) : <Upload size={16} />}
              </button>
            </Tooltip>
            <input
              ref={uploadInput} type="file" multiple hidden
              onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) upload.mutate({ files, folder: folder && writableFolder(folder) ? folder : undefined }); }}
            />
          </>
        ) : null}
        <Tooltip title={t("common.refresh")}>
          <button type="button" className="ws-icon-button" aria-label={t("common.refresh")} onClick={() => void refetch()} disabled={isFetching}><RefreshCw size={15} /></button>
        </Tooltip>
      </div>
      {treeList}
      <NewFileModal open={creating !== null} initial={creating ?? ""} busy={create.isPending} onCreate={(path) => create.mutate({ path })} onClose={() => setCreating(null)} />
    </div>
  );
}
