/**
 * Left panel (plan 4.2, M1): "Footage nguồn" browses the production's catalog (`catalog.json`) and can swap
 * the selected clip's footage or append a new clip to the selected beat; "Phương án thay thế" shows the
 * alternates the shot-board stage (or a previous swap) left for the selected clip's beat.
 */
import { useState, type Dispatch } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Empty, Input, Space, Spin, Tabs, Typography } from "antd";
import { useTranslation } from "react-i18next";
import type { StudioCatalog } from "@harness/contracts";
import { SegmentPreviewCard } from "../common/SegmentPreviewCard";
import type { EditorAction, EditorState } from "./state/editor-reducer";
import type { EditorClient, MediaLookup } from "./types";

const { Text } = Typography;

export interface FootagePanelProps {
  productionId: string;
  client: EditorClient;
  media: MediaLookup;
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
}

function selectedClipId(state: EditorState): string | null {
  return state.selection?.kind === "clip" ? state.selection.id : null;
}

function selectedBeatId(state: EditorState): string | null {
  const { selection, timeline } = state;
  if (!selection) return null;
  if (selection.kind === "beat") return selection.id;
  if (selection.kind === "clip") return timeline.clips.find((c) => c.clip_id === selection.id)?.beat_id ?? null;
  if (selection.kind === "line") return timeline.narration.find((l) => l.line_id === selection.id)?.beat_id ?? null;
  if (selection.kind === "text") return timeline.texts.find((x) => x.text_id === selection.id)?.beat_id ?? null;
  return null;
}

export function FootagePanel({ productionId, client, media, state, dispatch }: FootagePanelProps) {
  const { t } = useTranslation();
  return (
    <Card size="small" title={t("footage.title")} style={{ height: "100%" }}>
      <Tabs
        size="small"
        items={[
          {
            key: "catalog",
            label: t("footage.tabCatalog"),
            children: <CatalogTab productionId={productionId} client={client} media={media} state={state} dispatch={dispatch} />,
          },
          {
            key: "alternates",
            label: t("footage.tabAlternates"),
            children: <AlternatesTab media={media} state={state} dispatch={dispatch} />,
          },
        ]}
      />
    </Card>
  );
}

function CatalogTab({ productionId, client, media, state, dispatch }: FootagePanelProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["stage-document", productionId, "catalog"],
    queryFn: () => client.getStageDocument<StudioCatalog>(productionId, "catalog", "catalog.json"),
  });
  const [filter, setFilter] = useState("");

  if (isLoading) return <Spin />;
  if (isError || !data) return <Alert type="error" message={t("footage.loadFailed")} />;

  const q = filter.trim().toLowerCase();
  const segments = q
    ? data.segments.filter((s) => s.caption_vi.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)))
    : data.segments;

  const clipId = selectedClipId(state);
  const beatId = selectedBeatId(state);

  return (
    <div>
      <Input.Search placeholder={t("footage.searchPlaceholder")} allowClear onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8 }} />
      <Space direction="vertical" style={{ width: "100%", maxHeight: 520, overflowY: "auto" }}>
        {segments.slice(0, 200).map((s) => (
          <div key={s.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <SegmentPreviewCard segmentId={s.id} caption={s.caption_vi} media={media} width={96} />
            <Space direction="vertical" size={2} style={{ flex: 1 }}>
              <Text style={{ fontSize: 12 }}>{s.caption_vi}</Text>
              <Space>
                <Button
                  size="small"
                  disabled={!clipId}
                  onClick={() =>
                    clipId &&
                    dispatch({
                      type: "swapClip",
                      clipId,
                      segmentId: s.id,
                      segment: { asset_id: s.asset_id, start_ms: s.start_ms, end_ms: s.end_ms, caption: s.caption_vi, orientation: s.orientation },
                    })
                  }
                >
                  {t("footage.swapClip")}
                </Button>
                <Button
                  size="small"
                  disabled={!beatId}
                  onClick={() =>
                    beatId &&
                    dispatch({
                      type: "addClip",
                      beatId,
                      segmentId: s.id,
                      segment: { asset_id: s.asset_id, start_ms: s.start_ms, end_ms: s.end_ms, caption: s.caption_vi, orientation: s.orientation },
                    })
                  }
                >
                  {t("footage.addToBeat")}
                </Button>
              </Space>
            </Space>
          </div>
        ))}
        {segments.length === 0 && <Empty description={t("footage.noResults")} />}
      </Space>
    </div>
  );
}

function AlternatesTab({ media, state, dispatch }: Pick<FootagePanelProps, "media" | "state" | "dispatch">) {
  const { t } = useTranslation();
  const clipId = selectedClipId(state);
  const beatId = selectedBeatId(state);
  if (!clipId || !beatId) {
    return <Empty description={t("footage.selectClipHint")} />;
  }
  const alternates = state.timeline.alternates[beatId] ?? [];
  if (!alternates.length) return <Empty description={t("footage.noAlternates")} />;

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {alternates.map((alt) => {
        const seg = state.timeline.segments[alt.segment_id];
        return (
          <div key={alt.segment_id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <SegmentPreviewCard
              segmentId={alt.segment_id}
              caption={seg?.caption ?? alt.segment_id}
              media={media}
              width={96}
              onClick={() => dispatch({ type: "swapClip", clipId, segmentId: alt.segment_id })}
            />
            <Space direction="vertical" size={2}>
              <Text style={{ fontSize: 12 }}>{seg?.caption ?? alt.segment_id}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>{alt.reason}</Text>
            </Space>
          </div>
        );
      })}
    </Space>
  );
}
