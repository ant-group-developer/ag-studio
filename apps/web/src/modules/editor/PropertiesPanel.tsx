/**
 * Right-hand properties panel (GĐ3, v3): editing surface for the selected clip or text, plus
 * global settings (music, source audio). Every change goes through dispatch.
 */
import { type Dispatch } from "react";
import { Button, Card, Divider, Input, InputNumber, Select, Slider, Space, Switch, Typography, Tooltip } from "antd";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TEXT_KINDS, TEXT_POSITIONS_V2 } from "@harness/contracts";
import type { TimelineLayout } from "@studio/timeline";
import type { EditorAction, EditorState } from "./state/editor-reducer";

const { Text, Title } = Typography;

export interface PropertiesPanelProps {
  state: EditorState;
  layout: TimelineLayout;
  dispatch: Dispatch<EditorAction>;
}

export function PropertiesPanel({ state, layout: _layout, dispatch }: PropertiesPanelProps) {
  const { t } = useTranslation();
  const { timeline, selection } = state;

  return (
    <Card size="small" title={t("properties.title")} style={{ height: "100%" }}>
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        {selection?.kind === "clip" && (
          <ClipProperties timeline={timeline} clipId={selection.id} dispatch={dispatch} />
        )}
        {selection?.kind === "text" && (
          <TextProperties timeline={timeline} textId={selection.id} dispatch={dispatch} />
        )}
        {!selection && <Text type="secondary">{t("properties.emptySelection")}</Text>}

        <Divider style={{ margin: 0 }} />

        <Button
          size="small"
          onClick={() =>
            dispatch({
              type: "addText",
              text: {
                kind: "title",
                text: t("properties.newText"),
                start: 0,
                duration: 2,
                position: "bottom_center",
              },
            })
          }
        >
          {t("properties.addText")}
        </Button>

        <Divider style={{ margin: 0 }} />
        <GlobalProperties timeline={timeline} dispatch={dispatch} />
      </Space>
    </Card>
  );
}

function ClipProperties({
  timeline,
  clipId,
  dispatch,
}: {
  timeline: EditorState["timeline"];
  clipId: string;
  dispatch: Dispatch<EditorAction>;
}) {
  const { t } = useTranslation();
  const clip = timeline.clips.find((c) => c.clip_id === clipId);
  if (!clip) return null;
  const asset = timeline.assets[clip.asset_id];

  return (
    <div>
      <Title level={5}>{t("properties.clipTitle", { id: clip.clip_id })}</Title>
      {asset && (
        <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>
          {asset.title} · {asset.duration_s.toFixed(1)}s
        </Text>
      )}
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary">{t("properties.sectionTitle")}</Text>
        <Input
          size="small"
          placeholder={t("properties.sectionTitlePlaceholder")}
          value={clip.section_title ?? ""}
          onChange={(e) => dispatch({ type: "setSectionTitle", clipId: clip.clip_id, title: e.target.value || null })}
        />
      </div>
      <Tooltip title={t("properties.removeClip")}>
        <Button
          danger
          size="small"
          icon={<Trash2 size={14} />}
          aria-label={t("properties.removeClip")}
          onClick={() => dispatch({ type: "removeClip", clipId: clip.clip_id })}
        >
          {t("properties.removeClip")}
        </Button>
      </Tooltip>
    </div>
  );
}

function TextProperties({
  timeline,
  textId,
  dispatch,
}: {
  timeline: EditorState["timeline"];
  textId: string;
  dispatch: Dispatch<EditorAction>;
}) {
  const { t } = useTranslation();
  const text = timeline.texts.find((x) => x.text_id === textId);
  if (!text) return null;
  return (
    <div>
      <Title level={5}>{t("properties.textTitle", { id: text.text_id })}</Title>
      <Input
        value={text.text}
        maxLength={64}
        onChange={(e) => dispatch({ type: "updateText", textId, patch: { text: e.target.value } })}
      />
      <Space style={{ marginTop: 8 }} wrap>
        <Select
          size="small"
          value={text.kind}
          style={{ width: 120 }}
          options={TEXT_KINDS.map((k) => ({ value: k, label: k }))}
          onChange={(kind) => dispatch({ type: "updateText", textId, patch: { kind } })}
        />
        <Select
          size="small"
          value={text.position}
          style={{ width: 140 }}
          options={TEXT_POSITIONS_V2.map((p) => ({ value: p, label: p }))}
          onChange={(position) => dispatch({ type: "updateText", textId, patch: { position } })}
        />
      </Space>
      <Space style={{ marginTop: 8 }}>
        <span>
          <Text type="secondary">{t("properties.startSeconds")}</Text>
          <InputNumber
            size="small"
            min={0}
            value={text.start}
            onChange={(n) => dispatch({ type: "updateText", textId, patch: { start: n ?? 0 } })}
          />
        </span>
        <span>
          <Text type="secondary">{t("properties.durationSeconds")}</Text>
          <InputNumber
            size="small"
            min={0.5}
            max={20}
            value={text.duration}
            onChange={(n) => dispatch({ type: "updateText", textId, patch: { duration: n ?? 0.5 } })}
          />
        </span>
      </Space>
      <div style={{ marginTop: 8 }}>
        <Tooltip title={t("properties.removeText")}>
          <Button
            danger
            size="small"
            icon={<Trash2 size={14} />}
            aria-label={t("properties.removeText")}
            onClick={() => dispatch({ type: "removeText", textId })}
          >
            {t("properties.removeText")}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

function GlobalProperties({ timeline, dispatch }: { timeline: EditorState["timeline"]; dispatch: Dispatch<EditorAction> }) {
  const { t } = useTranslation();
  const music = timeline.music;
  return (
    <div>
      <Title level={5}>{t("properties.generalTitle")}</Title>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space>
          <Text>{t("properties.sourceAudio")}</Text>
          <Switch
            checked={!timeline.source_audio.muted}
            onChange={(checked) => dispatch({ type: "setSourceMuted", muted: !checked })}
          />
        </Space>
        <Divider style={{ margin: "8px 0" }} />
        <Text strong>{t("properties.music")}</Text>
        {music ? (
          <>
            <Input
              size="small"
              value={music.track}
              placeholder="library:music/..."
              onChange={(e) => dispatch({ type: "setMusic", music: { ...music, track: e.target.value } })}
            />
            <Text type="secondary">{t("properties.musicVolume")}</Text>
            <Slider
              min={-40}
              max={0}
              value={music.gain_db}
              onChange={(v) => dispatch({ type: "setMusic", music: { ...music, gain_db: v } })}
            />
            <Space>
              <Text>{t("properties.musicDucking")}</Text>
              <Switch checked={music.ducking} onChange={(checked) => dispatch({ type: "setMusic", music: { ...music, ducking: checked } })} />
            </Space>
            <Button size="small" danger onClick={() => dispatch({ type: "setMusic", music: null })}>
              {t("properties.removeMusic")}
            </Button>
          </>
        ) : (
          <Button
            size="small"
            onClick={() => dispatch({ type: "setMusic", music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true } })}
          >
            {t("properties.addMusic")}
          </Button>
        )}
      </Space>
    </div>
  );
}
