/**
 * Right-hand properties panel (GĐ3; shot-cut fields in phase 5): editing surface for the selected clip or text, plus
 * global settings (music, source audio). Every change goes through dispatch.
 */
import { useMemo, useState, type Dispatch } from "react";
import { Button, Card, Divider, Input, InputNumber, Select, Slider, Space, Switch, Typography, Tooltip } from "antd";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CAPTION_MODES, TEXT_KINDS, TEXT_POSITIONS_V2, TIMELINE_TRANSITIONS, type StoredTimeline, type StudioMusic, type TimelineV4 } from "@harness/contracts";
import { isTimelineV4, type TimelineLayout } from "@studio/timeline";
import type { MusicTrackView } from "../../api/studio-client";
import type { EditorAction, EditorState } from "./state/editor-reducer";

const { Text, Title } = Typography;

/** A shot-cut episode's timeline: clips have an in/out, a transition and a narration line. */
const cutTimeline = (t: StoredTimeline): t is TimelineV4 => isTimelineV4(t) && t.edit_style === "cut";
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface PropertiesPanelProps {
  state: EditorState;
  layout: TimelineLayout;
  dispatch: Dispatch<EditorAction>;
  /** The team's music library (active tracks); empty: the music is typed as a `library:` path. */
  musicLibrary?: MusicTrackView[];
}

export function PropertiesPanel({ state, layout: _layout, dispatch, musicLibrary = [] }: PropertiesPanelProps) {
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
        <GlobalProperties timeline={timeline} dispatch={dispatch} library={musicLibrary} />
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
      {cutTimeline(timeline) ? <CutClipProperties timeline={timeline} clipId={clip.clip_id} dispatch={dispatch} /> : null}
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

function CutClipProperties({ timeline, clipId, dispatch }: { timeline: TimelineV4; clipId: string; dispatch: Dispatch<EditorAction> }) {
  const { t } = useTranslation();
  const clip = timeline.clips.find((c) => c.clip_id === clipId)!;
  const length = timeline.assets[clip.asset_id]?.duration_s ?? 0;
  const out = clip.out ?? length;
  // clamped inside the video, at least 0.1 s long; the shared op refuses anything else
  const trim = (inS: number, outS: number) => {
    const i = r1(Math.min(Math.max(0, inS), length - 0.1));
    const o = r1(Math.min(Math.max(i + 0.1, outS), length));
    dispatch({ type: "trimClip", clipId, in: i, out: o });
  };
  return (
    <div style={{ marginBottom: 8 }}>
      <Space wrap>
        <span>
          <Text type="secondary">{t("properties.inSeconds")}</Text>
          <InputNumber size="small" aria-label={t("properties.inSeconds")} min={0} max={length} step={0.1} value={clip.in}
            onChange={(n) => trim(n ?? 0, out)} />
        </span>
        <span>
          <Text type="secondary">{t("properties.outSeconds")}</Text>
          <InputNumber size="small" aria-label={t("properties.outSeconds")} min={0} max={length} step={0.1} value={out}
            onChange={(n) => trim(clip.in, n ?? length)} />
        </span>
      </Space>
      <div style={{ marginTop: 8 }}>
        <Text type="secondary">{t("properties.transition")}</Text>
        <Space wrap>
          <Select size="small" aria-label={t("properties.transition")} value={clip.transition_out.kind} style={{ width: 140 }}
            options={TIMELINE_TRANSITIONS.map((k) => ({ value: k, label: t(`properties.transitions.${k}`) }))}
            onChange={(kind) => dispatch({ type: "setTransition", clipId, kind, seconds: kind === "cut" ? 0 : clip.transition_out.seconds || 0.5 })} />
          {clip.transition_out.kind !== "cut" ? (
            <InputNumber size="small" aria-label={t("properties.transitionSeconds")} min={0.1} max={1} step={0.1} value={clip.transition_out.seconds}
              onChange={(n) => dispatch({ type: "setTransition", clipId, kind: clip.transition_out.kind, seconds: r1(n ?? 0.5) })} />
          ) : null}
        </Space>
      </div>
      <Space style={{ marginTop: 8 }}>
        <Text>{t("properties.clipSound")}</Text>
        <Switch size="small" aria-label={t("properties.clipSound")} disabled={timeline.source_audio.muted}
          checked={!timeline.source_audio.muted && !clip.muted}
          onChange={(on) => dispatch({ type: "setClipMuted", clipId, muted: !on })} />
      </Space>
      {timeline.source_audio.muted ? <Text type="secondary" style={{ display: "block" }}>{t("properties.clipSoundAllOff")}</Text> : null}
      <Text type="secondary" style={{ display: "block", marginTop: 8 }}>
        {clip.line_id ? t("properties.narrationLine", { id: clip.line_id }) : t("properties.noNarrationLine")}
      </Text>
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

/**
 * The music from the team's library, narrowed by a mood; a track the library does not list (typed before, or retired)
 * stays shown as its path.
 */
function MusicPicker({ music, library, dispatch }: { music: StudioMusic; library: MusicTrackView[]; dispatch: Dispatch<EditorAction> }) {
  const { t } = useTranslation();
  const [mood, setMood] = useState<string | null>(null);
  const moods = useMemo(() => [...new Set(library.flatMap((x) => x.moods))].sort((a, b) => a.localeCompare(b, "vi")), [library]);
  const shown = mood ? library.filter((x) => x.moods.includes(mood)) : library;
  const options = [
    ...(library.some((x) => x.track === music.track) ? [] : [{ value: music.track, label: music.track }]),
    ...shown.map((x) => ({ value: x.track, label: `${x.displayName} · ${x.moods.join(", ")}` })),
  ];
  return (
    <>
      <Select size="small" allowClear aria-label={t("properties.musicMood")} placeholder={t("properties.musicMoodAll")} value={mood}
        options={moods.map((m) => ({ value: m, label: m }))} onChange={(v) => setMood(v ?? null)} />
      <Select size="small" showSearch optionFilterProp="label" aria-label={t("properties.musicTrack")} value={music.track} options={options}
        onChange={(track: string) => dispatch({ type: "setMusic", music: { ...music, track } })} />
    </>
  );
}

function GlobalProperties({ timeline, dispatch, library }: { timeline: EditorState["timeline"]; dispatch: Dispatch<EditorAction>; library: MusicTrackView[] }) {
  const { t } = useTranslation();
  const music = timeline.music;
  return (
    <div>
      <Title level={5}>{t("properties.generalTitle")}</Title>
      <Space direction="vertical" style={{ width: "100%" }}>
        {cutTimeline(timeline) ? (
          <Space>
            <Text>{t("properties.captions")}</Text>
            <Select size="small" aria-label={t("properties.captions")} value={timeline.captions.mode} style={{ width: 140 }}
              options={CAPTION_MODES.map((m) => ({ value: m, label: t(`properties.captionModes.${m}`) }))}
              onChange={(mode) => dispatch({ type: "setCaptions", mode })} />
          </Space>
        ) : null}
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
            {library.length ? <MusicPicker music={music} library={library} dispatch={dispatch} /> : (
              <Input
                size="small"
                value={music.track}
                placeholder="library:music/..."
                onChange={(e) => dispatch({ type: "setMusic", music: { ...music, track: e.target.value } })}
              />
            )}
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
            onClick={() => dispatch({ type: "setMusic", music: { track: library[0]?.track ?? "library:music/calm.mp3", gain_db: -18, ducking: true } })}
          >
            {t("properties.addMusic")}
          </Button>
        )}
      </Space>
    </div>
  );
}
