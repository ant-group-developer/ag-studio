/**
 * The web editor (GĐ3, v3). Pure UI: all state comes from `useEditor`, all timeline math from
 * `@studio/timeline`. `productionId`/`episodeId`/`client`/`media` are injected so the dev playground
 * can render this with an in-memory fake client and no Auth0.
 */
import { useMemo, useState } from "react";
import { Alert, Modal, Spin } from "antd";
import { useTranslation } from "react-i18next";
import { layoutTimeline, timelineIssues } from "@studio/timeline";
import { useEditor } from "./useEditor";
import { Toolbar } from "./Toolbar";
import { Player } from "./Player";
import { TimelineView } from "./TimelineView";
import { PropertiesPanel } from "./PropertiesPanel";
import { FootagePanel } from "./FootagePanel";
import type { AssetMediaLookup, EditorClient } from "./types";

export interface EditorViewProps {
  productionId: string;
  episodeId: string;
  client: EditorClient;
  media: AssetMediaLookup;
  onRerender?: () => void;
}

export function EditorView({ productionId, episodeId, client, media, onRerender }: EditorViewProps) {
  const { t } = useTranslation();
  const editor = useEditor(productionId, episodeId, client);
  const [seek, setSeek] = useState({ time: 0, token: 0 });
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [renderJob, setRenderJob] = useState<import("../../api/studio-client").EditorJob | null>(null);

  const layout = useMemo(() => (editor.state ? layoutTimeline(editor.state.timeline) : null), [editor.state]);
  const issues = useMemo(() => (editor.state ? timelineIssues(editor.state.timeline) : []), [editor.state]);

  if (editor.loading || !editor.state || !layout) {
    if (editor.loadError) {
      return <Alert type="error" showIcon message={t("editorView.loadFailed")} description={editor.loadError} />;
    }
    return <Spin style={{ margin: 48 }} />;
  }

  const { state, dispatch } = editor;

  return (
    <div>
      <Toolbar
        productionId={productionId}
        episodeId={episodeId}
        client={client}
        state={state}
        dispatch={dispatch}
        issues={issues}
        autosaveStatus={editor.autosaveStatus}
        saveError={editor.saveError}
        flush={editor.flush}
        onRenderJob={setRenderJob}
        onRerender={onRerender}
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ width: 280, flexShrink: 0 }}>
          <FootagePanel productionId={productionId} client={client} state={state} dispatch={dispatch} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Player
            productionId={productionId}
            episodeId={episodeId}
            client={client}
            media={media}
            timeline={state.timeline}
            layout={layout}
            playing={playing}
            onPlayingChange={setPlaying}
            time={seek.time}
            seekToken={seek.token}
            onTimeUpdate={setPlayhead}
            renderJob={renderJob}
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
          <PropertiesPanel state={state} layout={layout} dispatch={dispatch} />
        </div>
      </div>

      <Modal
        open={!!editor.conflict}
        title={t("editorView.conflictTitle")}
        closable={false}
        maskClosable={false}
        onOk={() => void editor.loadLatest()}
        onCancel={() => void editor.keepMine()}
        okText={t("editorView.loadLatest")}
        cancelText={t("editorView.keepMine")}
      >
        <p>{t("editorView.conflictBody", { revision: editor.conflict?.currentRevision })}</p>
      </Modal>
    </div>
  );
}
