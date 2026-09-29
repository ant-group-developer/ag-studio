/**
 * The web editor (plan 4.2, M1). Pure UI: all state comes from `useEditor`, all timeline math comes from
 * `@studio/timeline`. `productionId`/`client`/`media` are injected so the dev playground
 * (`apps/web/playground.html`) can render this with an in-memory fake client and no Auth0.
 */
import { useMemo, useState } from "react";
import { Alert, Modal, Spin } from "antd";
import { layoutTimeline, timelineIssues } from "@studio/timeline";
import { useEditor } from "./useEditor";
import { Toolbar } from "./Toolbar";
import { Player } from "./Player";
import { TimelineView } from "./TimelineView";
import { PropertiesPanel } from "./PropertiesPanel";
import { FootagePanel } from "./FootagePanel";
import type { EditorClient, MediaLookup } from "./types";

export interface EditorViewProps {
  productionId: string;
  client: EditorClient;
  media: MediaLookup;
  /** Called after "Hoàn tất" successfully submits the `edit` gate. */
  onDone?: () => void;
}

export function EditorView({ productionId, client, media, onDone }: EditorViewProps) {
  const editor = useEditor(productionId, client);
  const [seek, setSeek] = useState({ time: 0, token: 0 });
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  const layout = useMemo(() => (editor.state ? layoutTimeline(editor.state.timeline) : null), [editor.state]);
  const issues = useMemo(() => (editor.state ? timelineIssues(editor.state.timeline) : []), [editor.state]);

  if (editor.loading || !editor.state || !layout) {
    if (editor.loadError) {
      return <Alert type="error" showIcon message="Không tải được timeline" description={editor.loadError} />;
    }
    return <Spin style={{ margin: 48 }} />;
  }

  const { state, dispatch } = editor;

  return (
    <div>
      <Toolbar
        productionId={productionId}
        client={client}
        state={state}
        dispatch={dispatch}
        issues={issues}
        autosaveStatus={editor.autosaveStatus}
        saveError={editor.saveError}
        flush={editor.flush}
        onDone={() => onDone?.()}
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ width: 280, flexShrink: 0 }}>
          <FootagePanel productionId={productionId} client={client} media={media} state={state} dispatch={dispatch} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Player
            productionId={productionId}
            client={client}
            media={media}
            timeline={state.timeline}
            layout={layout}
            playing={playing}
            onPlayingChange={setPlaying}
            time={seek.time}
            seekToken={seek.token}
            onTimeUpdate={setPlayhead}
          />
          <TimelineView
            layout={layout}
            selection={state.selection}
            dispatch={dispatch}
            playhead={playhead}
            onSeek={(t) => {
              setPlayhead(t);
              setSeek((s) => ({ time: t, token: s.token + 1 }));
            }}
          />
        </div>

        <div style={{ width: 320, flexShrink: 0 }}>
          <PropertiesPanel productionId={productionId} client={client} state={state} layout={layout} dispatch={dispatch} />
        </div>
      </div>

      <Modal
        open={!!editor.conflict}
        title="Có người vừa lưu revision mới"
        closable={false}
        maskClosable={false}
        onOk={() => void editor.loadLatest()}
        onCancel={() => void editor.keepMine()}
        okText="Tải bản mới nhất"
        cancelText="Giữ bản của tôi"
      >
        <p>
          Ai đó vừa lưu revision {editor.conflict?.currentRevision} trong khi bạn đang chỉnh sửa. Bạn có thể tải bản mới
          nhất (bỏ thay đổi của bạn) hoặc giữ bản của bạn (ghi đè lên bản mới nhất).
        </p>
      </Modal>
    </div>
  );
}
