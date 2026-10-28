import { useEffect, useState } from "react";
import { App as AntApp, Input, Modal } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StudioHttpError } from "../../api/http";
import { useWorkspaceClient } from "../../api/workspace-client";
import { useUploadProgress } from "../common/upload-progress";

/**
 * Making an empty file and uploading files into the project, shared by the Documents tab and the folder tree: each
 * opens what it made (one upload opens it, several do not), and the list reloads.
 */
export function useFileActions(projectId: string, onOpen: (path: string) => void) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const client = useWorkspaceClient();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (path: string) => client.writeFile(projectId, { path, content: "", baseSha256: null }),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["files", projectId] });
      onOpen(saved.path);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError && e.code === "file_conflict" ? t("ws.files.exists") : e instanceof StudioHttpError ? e.message : t("ws.files.saveFailed")),
  });
  const uploading = useUploadProgress();
  const upload = useMutation({
    mutationFn: ({ files, folder }: { files: File[]; folder?: string | undefined }) => {
      const progress = uploading.start(files);
      return Promise.all(files.map((f, i) => client.uploadFile(projectId, f, folder, progress[i])));
    },
    onSettled: uploading.done,
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["files", projectId] });
      void message.success(t("ws.files.uploaded", { count: saved.length }));
      if (saved.length === 1) onOpen(saved[0]!.path);
    },
    onError: (e) => void message.error(e instanceof StudioHttpError ? e.message : t("ws.files.uploadFailed")),
  });
  return { create, upload, uploading };
}

/** Asks where the new file goes (a path in the project, filled in with `initial`), then makes it. */
export function NewFileModal({ open, initial, busy, onCreate, onClose }: {
  open: boolean; initial: string; busy: boolean; onCreate: (path: string) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState(initial);
  useEffect(() => { if (open) setPath(initial); }, [open, initial]);
  return (
    <Modal
      open={open} title={t("ws.files.newFile")} okText={t("common.create")} cancelText={t("common.cancel")}
      onCancel={onClose} onOk={() => onCreate(path.trim())} confirmLoading={busy} destroyOnHidden
    >
      <p style={{ marginTop: 0 }}>{t("ws.files.newFileHint")}</p>
      <Input value={path} onChange={(e) => setPath(e.target.value)} onPressEnter={() => onCreate(path.trim())} autoFocus aria-label={t("ws.files.newFile")} />
    </Modal>
  );
}
