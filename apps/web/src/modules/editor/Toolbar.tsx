/**
 * Editor toolbar (plan 4.2, M1): undo/redo, autosave status, the issues popover (`timelineIssues`), and the
 * two actions that need the latest edits saved first -- "Render preview" and "Hoàn tất" (submits the `edit`
 * gate) both call `flush()` before talking to the server.
 */
import { useEffect, useState, type Dispatch } from "react";
import { Alert, Badge, Button, Modal, Popover, Space, Tag, Typography } from "antd";
import { RedoOutlined, UndoOutlined, PlayCircleOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import type { TimelineIssue } from "@studio/timeline";
import type { AutosaveStatus } from "./state/autosave";
import type { EditorAction, EditorState } from "./state/editor-reducer";
import type { EditorClient } from "./types";
import { GateRejectionAlert } from "../production/GateRejectionAlert";

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

export interface ToolbarProps {
  productionId: string;
  client: EditorClient;
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  issues: TimelineIssue[];
  autosaveStatus: AutosaveStatus;
  saveError: string | null;
  flush: () => Promise<void>;
  onDone: () => void;
}

export function Toolbar({ productionId, client, state, dispatch, issues, autosaveStatus, saveError, flush, onDone }: ToolbarProps) {
  const { t } = useTranslation();
  const errorCount = issues.filter((i) => i.severity === "error").length;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
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
    try {
      await flush();
      const job = await client.renderPreview(productionId, state.revision);
      let done = job;
      while (done.status !== "completed" && done.status !== "failed") {
        await new Promise((r) => setTimeout(r, 1500));
        done = await client.getEditorJob(productionId, done.id);
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

  const [doneBusy, setDoneBusy] = useState(false);
  const [doneError, setDoneError] = useState<unknown>(null);

  const finish = async () => {
    setDoneBusy(true);
    setDoneError(null);
    try {
      await flush();
      await client.submitGate(productionId, "edit");
      onDone();
    } catch (e) {
      setDoneError(e);
    } finally {
      setDoneBusy(false);
    }
  };

  return (
    <Space wrap style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}>
      <Space>
        <Button icon={<UndoOutlined />} disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })}>
          {t("toolbar.undo")}
        </Button>
        <Button icon={<RedoOutlined />} disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })}>
          {t("toolbar.redo")}
        </Button>
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
        <Button icon={<PlayCircleOutlined />} loading={previewBusy} onClick={() => void renderPreview()}>
          {t("toolbar.renderPreview")}
        </Button>
        <Button type="primary" icon={<CheckCircleOutlined />} loading={doneBusy} disabled={errorCount > 0} onClick={() => void finish()}>
          {t("toolbar.finish")}
        </Button>
      </Space>

      <Modal open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} title={t("toolbar.previewTitle")}>
        {previewBusy && <Text>{t("toolbar.rendering")}</Text>}
        {previewError && <Alert type="error" message={previewError} />}
        {previewHidden && <Alert type="warning" message={t("toolbar.noFootageAccess")} />}
        {previewUrl && <video src={previewUrl} controls style={{ width: "100%" }} />}
      </Modal>

      {doneError !== null && (
        <div style={{ width: "100%" }}>
          <GateRejectionAlert error={doneError} />
        </div>
      )}
    </Space>
  );
}
