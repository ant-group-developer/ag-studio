/**
 * Right-hand properties panel (plan 4.2, M1): editing surface for whatever is selected on the timeline, plus
 * the always-visible global settings (music, source audio, captions). Every change goes through
 * `editorReducer` via `dispatch` -- this component holds no timeline state of its own.
 */
import { useEffect, useRef, useState, type Dispatch } from "react";
import { Alert, Button, Card, Divider, Input, InputNumber, Select, Slider, Space, Switch, Typography } from "antd";
import { DeleteOutlined, SoundOutlined } from "@ant-design/icons";
import { TEXT_KINDS, TEXT_POSITIONS_V2 } from "@harness/contracts";
import { MIN_CLIP_SECONDS, segmentSeconds, type TimelineLayout } from "@studio/timeline";
import type { EditorAction, EditorState } from "./state/editor-reducer";
import type { EditorClient } from "./types";
import type { EditorJob } from "../../api/studio-client";

const { Text, Title, Paragraph } = Typography;

async function pollJob(client: EditorClient, productionId: string, jobId: string): Promise<EditorJob> {
  for (;;) {
    const job = await client.getEditorJob(productionId, jobId);
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export interface PropertiesPanelProps {
  productionId: string;
  client: EditorClient;
  state: EditorState;
  layout: TimelineLayout;
  dispatch: Dispatch<EditorAction>;
}

export function PropertiesPanel({ productionId, client, state, layout, dispatch }: PropertiesPanelProps) {
  const { timeline, selection } = state;

  const selectedBeatId: string | null = (() => {
    if (!selection) return null;
    if (selection.kind === "beat") return selection.id;
    if (selection.kind === "clip") return timeline.clips.find((c) => c.clip_id === selection.id)?.beat_id ?? null;
    if (selection.kind === "line") return timeline.narration.find((l) => l.line_id === selection.id)?.beat_id ?? null;
    if (selection.kind === "text") return timeline.texts.find((x) => x.text_id === selection.id)?.beat_id ?? null;
    return null;
  })();

  return (
    <Card size="small" title="Thuộc tính" style={{ height: "100%" }}>
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        {selection?.kind === "clip" && (
          <ClipProperties timeline={timeline} layout={layout} clipId={selection.id} dispatch={dispatch} />
        )}
        {selection?.kind === "line" && (
          <LineProperties
            productionId={productionId}
            client={client}
            timeline={timeline}
            lineId={selection.id}
            dispatch={dispatch}
          />
        )}
        {selection?.kind === "text" && (
          <TextProperties timeline={timeline} textId={selection.id} dispatch={dispatch} />
        )}
        {selection?.kind === "beat" && (
          <div>
            <Title level={5}>Beat {selection.id}</Title>
          </div>
        )}
        {!selection && <Text type="secondary">Chọn một clip, câu lời dẫn hoặc chữ trên timeline để chỉnh sửa.</Text>}

        <Divider style={{ margin: 0 }} />

        <Button
          size="small"
          disabled={!selectedBeatId && layout.beats.length === 0}
          onClick={() =>
            dispatch({
              type: "addText",
              text: {
                beat_id: selectedBeatId ?? layout.beats[0]!.beat_id,
                kind: "title",
                text: "Chữ mới",
                offset: 0,
                duration: 2,
                position: "bottom_center",
              },
            })
          }
        >
          Thêm chữ
        </Button>

        <Divider style={{ margin: 0 }} />
        <GlobalProperties timeline={timeline} dispatch={dispatch} />
      </Space>
    </Card>
  );
}

function ClipProperties({
  timeline,
  layout,
  clipId,
  dispatch,
}: {
  timeline: EditorState["timeline"];
  layout: TimelineLayout;
  clipId: string;
  dispatch: Dispatch<EditorAction>;
}) {
  const clip = timeline.clips.find((c) => c.clip_id === clipId);
  const laid = layout.clips.find((c) => c.clip_id === clipId);
  if (!clip) return null;
  const seg = timeline.segments[clip.segment_id];
  const segSeconds = segmentSeconds(timeline, clip.segment_id) ?? clip.src_out;

  return (
    <div>
      <Title level={5}>Clip {clip.clip_id}</Title>
      <Paragraph type="secondary" style={{ marginBottom: 4 }}>
        {seg?.caption ?? "(không có mô tả)"}
      </Paragraph>
      <Text>Cắt trong đoạn (0–{segSeconds.toFixed(2)}s)</Text>
      <Slider
        range
        min={0}
        max={segSeconds}
        step={0.05}
        value={[clip.src_in, clip.src_out]}
        onChange={(v) => {
          const [a, b] = v as [number, number];
          dispatch({ type: "trimClip", clipId: clip.clip_id, srcIn: a, srcOut: b });
        }}
      />
      <Space>
        <InputNumber
          size="small"
          min={0}
          max={segSeconds}
          step={0.05}
          value={clip.src_in}
          onChange={(n) => dispatch({ type: "trimClip", clipId: clip.clip_id, srcIn: n ?? 0, srcOut: clip.src_out })}
        />
        <InputNumber
          size="small"
          min={MIN_CLIP_SECONDS}
          max={segSeconds}
          step={0.05}
          value={clip.src_out}
          onChange={(n) => dispatch({ type: "trimClip", clipId: clip.clip_id, srcIn: clip.src_in, srcOut: n ?? segSeconds })}
        />
      </Space>
      <Paragraph style={{ marginTop: 4 }}>Độ dài: {(laid?.duration ?? clip.src_out - clip.src_in).toFixed(2)}s</Paragraph>
      <Button danger size="small" icon={<DeleteOutlined />} onClick={() => dispatch({ type: "removeClip", clipId: clip.clip_id })}>
        Xoá clip
      </Button>
    </div>
  );
}

function LineProperties({
  productionId,
  client,
  timeline,
  lineId,
  dispatch,
}: {
  productionId: string;
  client: EditorClient;
  timeline: EditorState["timeline"];
  lineId: string;
  dispatch: Dispatch<EditorAction>;
}) {
  const line = timeline.narration.find((l) => l.line_id === lineId);
  const [text, setText] = useState(line?.text ?? "");
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Set on (re)mount too: StrictMode runs mount -> cleanup -> mount, and a flag only ever cleared would stay
  // false and drop every TTS result.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => setText(line?.text ?? ""), [line?.text, lineId]);

  if (!line) return null;

  const requestTts = async () => {
    setTtsBusy(true);
    setTtsError(null);
    try {
      const job = await client.ttsLine(productionId, lineId, line.text);
      const done = await pollJob(client, productionId, job.id);
      if (!mounted.current) return;
      if (done.status === "failed") {
        setTtsError(done.error ?? "TTS thất bại");
      } else {
        const result = done.result as { line_id: string; text: string; key: string; duration: number } | null;
        if (result) {
          dispatch({ type: "setLineAudio", lineId, forText: result.text, audio: { key: result.key, duration: result.duration } });
        }
      }
    } catch (e) {
      if (mounted.current) setTtsError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setTtsBusy(false);
    }
  };

  return (
    <div>
      <Title level={5}>Câu {line.line_id}</Title>
      <Input.TextArea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() && text !== line.text) dispatch({ type: "setLineText", lineId, text });
        }}
      />
      {line.audio ? (
        <Text type="secondary">Đã đọc — {line.audio.duration.toFixed(1)}s</Text>
      ) : (
        <Button size="small" icon={<SoundOutlined />} loading={ttsBusy} onClick={() => void requestTts()} style={{ marginTop: 8 }}>
          Đọc lại câu này (TTS)
        </Button>
      )}
      {ttsError && <Alert style={{ marginTop: 8 }} type="error" message={ttsError} />}
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
  const text = timeline.texts.find((x) => x.text_id === textId);
  if (!text) return null;
  return (
    <div>
      <Title level={5}>Chữ {text.text_id}</Title>
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
          <Text type="secondary">Bắt đầu (s)</Text>
          <InputNumber
            size="small"
            min={0}
            value={text.offset}
            onChange={(n) => dispatch({ type: "updateText", textId, patch: { offset: n ?? 0 } })}
          />
        </span>
        <span>
          <Text type="secondary">Thời lượng (s)</Text>
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
        <Button danger size="small" icon={<DeleteOutlined />} onClick={() => dispatch({ type: "removeText", textId })}>
          Xoá chữ
        </Button>
      </div>
    </div>
  );
}

function GlobalProperties({ timeline, dispatch }: { timeline: EditorState["timeline"]; dispatch: Dispatch<EditorAction> }) {
  const music = timeline.music;
  return (
    <div>
      <Title level={5}>Chung</Title>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space>
          <Text>Tiếng gốc</Text>
          <Switch
            checked={!timeline.source_audio.muted}
            onChange={(checked) => dispatch({ type: "setSourceMuted", muted: !checked })}
          />
        </Space>
        <Space>
          <Text>Phụ đề</Text>
          <Switch checked={timeline.captions.enabled} onChange={(checked) => dispatch({ type: "setCaptions", enabled: checked })} />
        </Space>
        <Divider style={{ margin: "8px 0" }} />
        <Text strong>Nhạc nền</Text>
        {music ? (
          <>
            <Input
              size="small"
              value={music.track}
              placeholder="library:music/..."
              onChange={(e) => dispatch({ type: "setMusic", music: { ...music, track: e.target.value } })}
            />
            <Text type="secondary">Âm lượng (dB)</Text>
            <Slider
              min={-40}
              max={0}
              value={music.gain_db}
              onChange={(v) => dispatch({ type: "setMusic", music: { ...music, gain_db: v } })}
            />
            <Space>
              <Text>Ducking khi có lời</Text>
              <Switch checked={music.ducking} onChange={(checked) => dispatch({ type: "setMusic", music: { ...music, ducking: checked } })} />
            </Space>
            <Button size="small" danger onClick={() => dispatch({ type: "setMusic", music: null })}>
              Xoá nhạc
            </Button>
          </>
        ) : (
          <Button
            size="small"
            onClick={() => dispatch({ type: "setMusic", music: { track: "library:music/calm.mp3", gain_db: -18, ducking: true } })}
          >
            Thêm nhạc nền
          </Button>
        )}
      </Space>
    </div>
  );
}
