import { useEffect, useState } from "react";
import { App as AntApp, Button, Modal, Spin, Tooltip } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Download, Eye, History, Lock, PanelLeftClose, PanelLeftOpen, Paperclip, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { STUDIO_API_URL, StudioHttpError } from "../../api/http";
import { useWorkspaceClient, type FileAccess, type WorkspaceFile } from "../../api/workspace-client";
import { fileSize, relativeTime } from "../workspace/time";
import { isJson, isJsonLines, isMarkdown } from "./file-tree";
import { FileHistory } from "./FileHistory";
import { JsonView } from "./JsonView";
import { frontmatterOf, Markdown } from "./Markdown";

const isImage = (mime: string) => mime.startsWith("image/");
const isAudio = (mime: string) => mime.startsWith("audio/");
const isVideo = (mime: string) => mime.startsWith("video/");
const isPdf = (mime: string) => mime === "application/pdf";

/**
 * A file that is not text, played, shown or saved straight from its short link (`streamUrl`, with ranges): a video
 * starts at once and seeks without being downloaded first. The first link is kept while the file is the same (a newer
 * one would reload the player); an element that fails on it (the link ran out) is handed a fresh one, once.
 */
function useStreamUrl(file: WorkspaceFile | undefined, refetch: () => Promise<{ data?: WorkspaceFile | undefined }>) {
  const version = file ? `${file.path}|${file.mtime}|${file.size}` : "";
  const [kept, setKept] = useState<{ version: string; url: string; renewed: boolean } | null>(null);
  const current = kept?.version === version ? kept : null;
  useEffect(() => {
    if (file?.streamUrl && !current) setKept({ version, url: file.streamUrl, renewed: false });
  }, [file?.streamUrl, version, current]);
  const url = current?.url ?? file?.streamUrl ?? null;
  const renew = () => {
    if (!current || current.renewed) return;
    setKept({ ...current, renewed: true });
    void refetch().then((r) => { if (r.data?.streamUrl) setKept({ version, url: r.data.streamUrl, renewed: true }); });
  };
  return { url: url ? `${STUDIO_API_URL}${url}` : null, renew };
}

/**
 * One file of the workspace: read (markdown rendered), edit in place and save against the copy you opened (a newer
 * copy is never overwritten silently), its history, delete. Studio's own files are read-only. `tree`: the folder tree
 * beside it, shown or hidden from here.
 */
export function FileView({ projectId, path, access, canEdit, onBack, onDeleted, onAttach, tree }: {
  projectId: string;
  path: string;
  /** What the workspace lets a person do with this path (Studio's own files are read-only). */
  access: FileAccess;
  canEdit: boolean;
  onBack: () => void;
  onDeleted: () => void;
  onAttach?: ((path: string) => void) | undefined;
  tree?: { shown: boolean; toggle: () => void } | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const { data: file, isLoading, error, refetch } = useQuery({ queryKey: ["file", projectId, path], queryFn: () => client.readFile(projectId, path) });
  const [mode, setMode] = useState<"view" | "edit" | "history">("view");
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState<string | null>(null);
  /** A save refused because the file moved on: the checksum of the copy now on disk (null = it is gone). */
  const [conflict, setConflict] = useState<{ theirs: string | null } | null>(null);
  const stream = useStreamUrl(file, refetch);
  const writable = canEdit && access === "write";

  useEffect(() => { setMode("view"); setConflict(null); }, [path]);

  const startEdit = () => {
    if (!file?.text && file?.text !== "") return;
    setDraft(file.text ?? "");
    setBase(file.sha256);
    setConflict(null);
    setMode("edit");
  };

  const save = useMutation({
    mutationFn: (overwrite: boolean) => client.writeFile(projectId, { path, content: draft, baseSha256: overwrite && conflict ? conflict.theirs : base }),
    onSuccess: (saved) => {
      setBase(saved.sha256);
      setConflict(null);
      setMode("view");
      void qc.invalidateQueries({ queryKey: ["file", projectId, path] });
      void qc.invalidateQueries({ queryKey: ["files", projectId] });
      void qc.invalidateQueries({ queryKey: ["file-versions", projectId, path] });
      void qc.invalidateQueries({ queryKey: ["playbook", projectId] });
      if (saved.issues?.some((i) => i.level === "error")) void message.warning(t("ws.files.savedWithErrors"));
      else void message.success(t("ws.files.saved"));
    },
    onError: (e) => {
      if (e instanceof StudioHttpError && e.code === "file_conflict") {
        setConflict({ theirs: typeof e.body?.currentSha256 === "string" ? e.body.currentSha256 : null });
        return;
      }
      void message.error(e instanceof StudioHttpError ? e.message : t("ws.files.saveFailed"));
    },
  });

  const remove = useMutation({
    mutationFn: () => client.deleteFile(projectId, path, file?.sha256 ?? undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["files", projectId] });
      onDeleted();
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.files.deleteFailed")),
  });

  const reloadTheirs = async () => {
    await qc.invalidateQueries({ queryKey: ["file", projectId, path] });
    const fresh = await client.readFile(projectId, path);
    setDraft(fresh.text ?? "");
    setBase(fresh.sha256);
    setConflict(null);
  };

  const dirty = mode === "edit" && draft !== (file?.text ?? "");
  const front = file?.text && isMarkdown(path) ? frontmatterOf(file.text) : null;

  return (
    <div className="ws-file">
      <div className="ws-file__head">
        {tree ? (
          <Tooltip title={tree.shown ? t("ws.files.hideTree") : t("ws.files.showTree")}>
            <button type="button" className="ws-icon-button" aria-pressed={tree.shown} aria-label={tree.shown ? t("ws.files.hideTree") : t("ws.files.showTree")} onClick={tree.toggle}>
              {tree.shown ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
          </Tooltip>
        ) : null}
        <Tooltip title={t("ws.files.back")}><button type="button" className="ws-icon-button" onClick={onBack} aria-label={t("ws.files.back")}><ArrowLeft size={16} /></button></Tooltip>
        <span className="ws-file__path" title={path}>{path}</span>
        {file && !file.binary && mode !== "edit" && writable ? (
          <Tooltip title={t("ws.files.edit")}><button type="button" className="ws-icon-button" onClick={startEdit} aria-label={t("ws.files.edit")}><Pencil size={16} /></button></Tooltip>
        ) : null}
        {mode === "edit" ? (
          <Tooltip title={t("ws.files.preview")}><button type="button" className="ws-icon-button" onClick={() => setMode("view")} aria-label={t("ws.files.preview")} disabled={dirty}><Eye size={16} /></button></Tooltip>
        ) : null}
        {onAttach ? (
          <Tooltip title={t("ws.files.attach")}>
            <button type="button" className="ws-icon-button" aria-label={t("ws.files.attach")} onClick={() => { onAttach(path); void message.success(t("ws.files.attached")); }}><Paperclip size={16} /></button>
          </Tooltip>
        ) : null}
        <Tooltip title={t("ws.files.history")}>
          <button type="button" className="ws-icon-button" aria-pressed={mode === "history"} onClick={() => setMode(mode === "history" ? "view" : "history")} aria-label={t("ws.files.history")} disabled={dirty}><History size={16} /></button>
        </Tooltip>
        {stream.url ? <Tooltip title={t("common.download")}><a className="ws-icon-button" href={`${stream.url}&download=1`} download={path.split("/").pop()} aria-label={t("common.download")}><Download size={16} /></a></Tooltip> : null}
        {writable && file ? (
          <Tooltip title={t("common.delete")}>
            <button type="button" className="ws-icon-button" aria-label={t("common.delete")} onClick={() => Modal.confirm({
              title: t("ws.files.deleteTitle", { path }), content: t("ws.files.deleteBody"), okText: t("common.delete"), okButtonProps: { danger: true },
              cancelText: t("common.cancel"), onOk: () => remove.mutateAsync(),
            })}><Trash2 size={16} /></button>
          </Tooltip>
        ) : null}
      </div>

      {conflict ? (
        <div className="ws-file__note" role="alert">
          {t("ws.files.conflict")}{" "}
          <Button size="small" onClick={() => void reloadTheirs()}>{t("ws.files.reloadTheirs")}</Button>{" "}
          <Button size="small" danger onClick={() => save.mutate(true)}>{t("ws.files.overwrite")}</Button>
        </div>
      ) : null}
      {file?.issues?.length && mode !== "history" ? (
        <ul className="ws-issues ws-issues--file" aria-label={t("ws.files.issues")}>
          {file.issues.map((i, n) => <li key={n} className={`ws-issue ws-issue--${i.level}`}><AlertTriangle size={12} aria-hidden />{i.message}</li>)}
        </ul>
      ) : null}
      {access === "read" && file ? <div className="ws-file__note"><Lock size={13} aria-hidden /> {t("ws.files.readOnly")}</div> : null}

      {isLoading ? <div className="ws-center"><Spin /></div> : error ? (
        <div className="ws-file__body"><p>{error instanceof StudioHttpError ? error.message : t("ws.files.loadFailed")}</p></div>
      ) : !file ? null : mode === "history" ? (
        <div className="ws-file__body"><FileHistory projectId={projectId} path={path} currentSha={file.sha256} canRestore={writable} onRestored={() => setMode("view")} /></div>
      ) : mode === "edit" ? (
        <textarea
          className="ws-file__editor" value={draft} spellCheck={false} aria-label={path} autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) save.mutate(false); }
            if (e.key === "Escape" && !dirty) setMode("view");
          }}
        />
      ) : (
        <div className="ws-file__body">
          {file.binary ? (
            isImage(file.mime) && stream.url ? <img className="ws-file__img" src={stream.url} alt={path} onError={stream.renew} />
              : isAudio(file.mime) && stream.url ? <audio controls preload="metadata" src={stream.url} aria-label={path} onError={stream.renew} style={{ width: "100%" }} />
                : isVideo(file.mime) && stream.url ? <video controls preload="metadata" src={stream.url} aria-label={path} onError={stream.renew} style={{ width: "100%" }} />
                  : isPdf(file.mime) && stream.url ? <iframe title={path} src={stream.url} style={{ width: "100%", height: "70vh", border: 0 }} />
                    : <p>{t("ws.files.binary", { size: fileSize(file.size) })}</p>
          ) : isMarkdown(path) ? (
            <>
              {front ? <pre className="ws-file__pre" style={{ marginBottom: 12, padding: 10, background: "var(--ws-chip)", borderRadius: 8 }}>{front}</pre> : null}
              {file.text ? <Markdown text={file.text} /> : <p style={{ color: "var(--ws-faint)" }}>{t("ws.files.empty")}</p>}
            </>
          ) : isJson(path) && file.text?.trim() ? (
            <JsonView text={file.text} lines={isJsonLines(path)} />
          ) : (
            <pre className="ws-file__pre">{file.text}</pre>
          )}
        </div>
      )}

      {file ? (
        <div className="ws-file__foot">
          <span>{fileSize(file.size)} · {relativeTime(file.mtime, i18n.language)}</span>
          <span className="ws-spacer" />
          {mode === "edit" ? (
            <>
              <Button size="small" onClick={() => setMode("view")} disabled={save.isPending}>{t("common.cancel")}</Button>
              <Button size="small" type="primary" onClick={() => save.mutate(false)} loading={save.isPending} disabled={!dirty}>{t("common.save")}</Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
