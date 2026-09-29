/**
 * Editor toolbar (plan 4.2, M1): undo/redo, autosave status, the issues popover (`timelineIssues`), and the
 * two actions that need the latest edits saved first -- "Render preview" and "Hoàn tất" (submits the `edit`
 * gate) both call `flush()` before talking to the server.
 */
import { useEffect, useState, type Dispatch } from "react";
import { Alert, Badge, Button, Modal, Popover, Space, Tag, Typography } from "antd";
import { RedoOutlined, UndoOutlined, PlayCircleOutlined, CheckCircleOutlined } from "@ant-design/icons";
import type { TimelineIssue } from "@studio/timeline";
import type { AutosaveStatus } from "./state/autosave";
import type { EditorAction, EditorState } from "./state/editor-reducer";
import type { EditorClient } from "./types";
import { GateRejectionAlert } from "../production/GateRejectionAlert";

const { Text } = Typography;

const STATUS_LABEL: Record<AutosaveStatus, string> = {
  idle: "Đã lưu",
  pending: "Đang lưu…",
  saving: "Đang lưu…",
  conflict: "Xung đột",
  error: "Lỗi lưu",
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
      if (done.status === "failed") setPreviewError(done.error ?? "Không dựng được bản xem trước");
      else if (done.urlHidden === "footage_scope") setPreviewHidden(true);
      else if (done.url) setPreviewUrl(done.url);
      else setPreviewError("Không có liên kết xem trước");
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
          Hoàn tác
        </Button>
        <Button icon={<RedoOutlined />} disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })}>
          Làm lại
        </Button>
        <Tag color={STATUS_COLOR[autosaveStatus]}>{STATUS_LABEL[autosaveStatus]}{state.revision ? ` · rev ${state.revision}` : ""}</Tag>
        {saveError && autosaveStatus === "error" && <Text type="danger">{saveError}</Text>}
        <Popover
          title="Vấn đề timeline"
          content={
            <div style={{ maxWidth: 360, maxHeight: 300, overflowY: "auto" }}>
              {issues.length === 0 && <Text type="secondary">Không có vấn đề</Text>}
              {issues.map((i, idx) => (
                <div key={idx}>
                  <Text type={i.severity === "error" ? "danger" : "warning"}>{i.message}</Text>
                </div>
              ))}
            </div>
          }
        >
          <Badge count={errorCount} showZero={false}>
            <Tag>{issues.length} vấn đề</Tag>
          </Badge>
        </Popover>
      </Space>

      <Space>
        <Button icon={<PlayCircleOutlined />} loading={previewBusy} onClick={() => void renderPreview()}>
          Render preview
        </Button>
        <Button type="primary" icon={<CheckCircleOutlined />} loading={doneBusy} disabled={errorCount > 0} onClick={() => void finish()}>
          Hoàn tất
        </Button>
      </Space>

      <Modal open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} title="Xem trước">
        {previewBusy && <Text>Đang dựng bản xem trước…</Text>}
        {previewError && <Alert type="error" message={previewError} />}
        {previewHidden && <Alert type="warning" message="Bạn không có quyền xem footage của production này" />}
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
