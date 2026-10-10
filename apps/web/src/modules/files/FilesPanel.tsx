import { useMemo, useRef, useState } from "react";
import { App as AntApp, Input, Modal, Spin, Tooltip } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, Image as ImageIcon, Lock, RefreshCw, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient } from "../../api/workspace-client";
import { ancestors, buildTree, type TreeNode } from "./file-tree";
import { FileView } from "./FileView";

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const DEFAULT_OPEN = new Set(["context", "research", "channel", "memory"]);

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
            <span className="ws-tree__name">{n.name}</span>
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
 * The project's files (spec 2026-10-10 agent-workspace §3.1): the tree, a new file, uploads, and the open file.
 * `openPath`/`onOpen` let the page (and later the chat) open a file here.
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
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ["files", projectId], queryFn: () => client.listFiles(projectId) });
  const tree = useMemo(() => buildTree(data?.entries ?? []), [data]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(DEFAULT_OPEN));
  const [folder, setFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);

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
    onOpen(n.path);
  };

  const create = useMutation({
    mutationFn: (path: string) => client.writeFile(projectId, { path, content: "", baseSha256: null }),
    onSuccess: (saved) => {
      setCreating(false);
      void qc.invalidateQueries({ queryKey: ["files", projectId] });
      onOpen(saved.path);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError && e.code === "file_conflict" ? t("ws.files.exists") : e instanceof StudioHttpError ? e.message : t("ws.files.saveFailed")),
  });
  const upload = useMutation({
    mutationFn: (files: File[]) => Promise.all(files.map((f) => client.uploadFile(projectId, f, folder && writableFolder(folder) ? folder : undefined))),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["files", projectId] });
      void message.success(t("ws.files.uploaded", { count: saved.length }));
      if (saved.length === 1) onOpen(saved[0]!.path);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.files.uploadFailed")),
  });
  const openEntry = data?.entries.find((e) => e.path === openPath);

  if (openPath) {
    return (
      <FileView
        projectId={projectId} path={openPath} access={openEntry?.access ?? "write"} canEdit={canEdit}
        onBack={() => onOpen(null)} onDeleted={() => onOpen(null)} onAttach={onAttach}
      />
    );
  }

  return (
    <div className="ws-files">
      <div className="ws-files__bar">
        <span className="ws-files__bar-title">{folder ?? t("ws.files.root")}</span>
        {canEdit ? (
          <>
            <Tooltip title={t("ws.files.newFile")}>
              <button type="button" className="ws-icon-button" aria-label={t("ws.files.newFile")} onClick={() => {
                const base = folder && writableFolder(folder) ? folder : "context";
                setNewPath(`${base}/ghi-chu.md`);
                setCreating(true);
              }}><FilePlus size={16} /></button>
            </Tooltip>
            <Tooltip title={t("ws.files.upload")}>
              <button type="button" className="ws-icon-button" aria-label={t("ws.files.upload")} disabled={upload.isPending} onClick={() => uploadInput.current?.click()}>
                {upload.isPending ? <Spin size="small" /> : <Upload size={16} />}
              </button>
            </Tooltip>
            <input
              ref={uploadInput} type="file" multiple hidden
              onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) upload.mutate(files); }}
            />
          </>
        ) : null}
        <Tooltip title={t("common.refresh")}>
          <button type="button" className="ws-icon-button" aria-label={t("common.refresh")} onClick={() => void refetch()} disabled={isFetching}><RefreshCw size={15} /></button>
        </Tooltip>
      </div>
      {isLoading ? <div className="ws-center"><Spin /></div> : (
        <ul className="ws-tree" aria-label={t("ws.files.tree")}>
          <TreeRows nodes={tree} open={open} toggle={toggle} selected={openPath} onPick={pick} />
        </ul>
      )}
      <Modal
        open={creating} title={t("ws.files.newFile")} okText={t("common.create")} cancelText={t("common.cancel")}
        onCancel={() => setCreating(false)} onOk={() => create.mutate(newPath.trim())} confirmLoading={create.isPending} destroyOnHidden
      >
        <p style={{ marginTop: 0 }}>{t("ws.files.newFileHint")}</p>
        <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} onPressEnter={() => create.mutate(newPath.trim())} autoFocus />
      </Modal>
    </div>
  );
}
