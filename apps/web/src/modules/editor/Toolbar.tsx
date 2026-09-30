/**
 * Editor toolbar (GĐ3, v3): undo/redo, autosave status, issues popover, "Render preview" and
 * "Render lại" (re-render). Ctrl/Cmd+Z is NOT captured while an input/textarea has focus.
 */
import { useEffect, useState, type Dispatch } from "react";
import { Alert, Badge, Button, Modal, Popover, Space, Tag, Typography, Tooltip } from "antd";
import { Undo2, Redo2, Play, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TimelineIssue } from "@studio/timeline";
import type { AutosaveStatus } from "./state/autosave";
import type { EditorAction, EditorState } from "./state/editor-reducer";
import type { EditorClient } from "./types";
import type { EditorJob } from "../../api/studio-client";

const { Text } = Typography;

const STATUS_LABEL_KEY: Record<AutosaveStatus, string> = {
  idle: "toolbar.statusIdle",
  pending: "toolbar.statusSaving",
  saving: "toolbar.statusSaving",
  conflict: "toolbar.statusConflict",
  error: "toolbar.statusError",
};
const STATUS_COLOR: Record<AutosaveStatus, string> = {
  idle: "success",
  pending: "processing",
  saving: "processing",
  conflict: "error",
  error: "error",
};

function isInputActive(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el as HTMLElement).tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable;
}

export interface ToolbarProps {
  productionId: string;
  episodeId: string;
  client: EditorClient;
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  issues: TimelineIssue[];
  autosaveStatus: AutosaveStatus;
  saveError: string | null;
  flush: () => Promise<void>;
  onRenderJob: (job: EditorJob | null) => void;
  onRerender?: () => void;
}

export function Toolbar({ productionId, episodeId, client, state, dispatch, issues, autosaveStatus, saveError, flush, onRenderJob, onRerender }: ToolbarProps) {
  const { t } = useTranslation();
  const errorCount = issues.filter((i) => i.severity === "error").length;

  // Ctrl/Cmd+Z — not while typing in an input or textarea
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isInputActive()) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "undo" });
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewHidden, setPreviewHidden] = useState(false);

  const renderPreview = async () => {
    setPreviewOpen(true);
    setPreviewBusy(true);
    setPreviewError(null);
    setPreviewUrl(null);
    setPreviewHidden(false);
    onRenderJob(null);
    try {
      await flush(); // save first
      const job = await client.renderPreview(productionId, episodeId, state.revision);
      onRenderJob(job);
      let done = job;
      while (done.status !== "completed" && done.status !== "failed") {
        await new Promise((r) => setTimeout(r, 2000));
        done = await client.getEditorJob(productionId, episodeId, done.id);
        onRenderJob(done);
      }
      if (done.status === "failed") setPreviewError(done.error ?? t("toolbar.renderFailed"));
      else if (done.urlHidden === "footage_scope") setPreviewHidden(true);
      else if (done.url) setPreviewUrl(done.url);
      else setPreviewError(t("toolbar.noPreviewLink"));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <Space wrap style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}>
      <Space>
        <Tooltip title={t("toolbar.undo")}>
          <Button
            icon={<Undo2 size={16} />}
            disabled={!state.past.length}
            onClick={() => dispatch({ type: "undo" })}
            aria-label={t("toolbar.undo")}
          />
        </Tooltip>
        <Tooltip title={t("toolbar.redo")}>
          <Button
            icon={<Redo2 size={16} />}
            disabled={!state.future.length}
            onClick={() => dispatch({ type: "redo" })}
            aria-label={t("toolbar.redo")}
          />
        </Tooltip>
        <Tag color={STATUS_COLOR[autosaveStatus]}>
          {t(STATUS_LABEL_KEY[autosaveStatus])}
          {state.revision ? t("toolbar.revisionSuffix", { revision: state.revision }) : ""}
        </Tag>
        {saveError && autosaveStatus === "error" && <Text type="danger">{saveError}</Text>}
        <Popover
          title={t("toolbar.issuesTitle")}
          content={
            <div style={{ maxWidth: 360, maxHeight: 300, overflowY: "auto" }}>
              {issues.length === 0 && <Text type="secondary">{t("toolbar.noIssues")}</Text>}
              {issues.map((i, idx) => (
                <div key={idx}>
                  <Text type={i.severity === "error" ? "danger" : "warning"}>{i.message}</Text>
                </div>
              ))}
            </div>
          }
        >
          <Badge count={errorCount} showZero={false}>
            <Tag>{t("toolbar.issuesCount", { count: issues.length })}</Tag>
          </Badge>
        </Popover>
      </Space>

      <Space>
        <Button icon={<Play size={16} />} loading={previewBusy} onClick={() => void renderPreview()}>
          {t("toolbar.renderPreview")}
        </Button>
        {onRerender && (
          <Tooltip title={t("toolbar.rerender")}>
            <Button icon={<RefreshCw size={16} />} onClick={onRerender} aria-label={t("toolbar.rerender")} />
          </Tooltip>
        )}
      </Space>

      <Modal open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} title={t("toolbar.previewTitle")}>
        {previewBusy && <Text>{t("toolbar.rendering")}</Text>}
        {previewError && <Alert type="error" message={previewError} />}
        {previewHidden && <Alert type="warning" message={t("toolbar.noFootageAccess")} />}
        {previewUrl && <video src={previewUrl} controls style={{ width: "100%" }} />}
      </Modal>
    </Space>
  );
}
