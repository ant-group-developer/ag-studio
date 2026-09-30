/**
 * Left panel (GĐ3, v3): "Footage nguồn" browses the production's catalog (StudioCatalog) and can
 * swap the selected clip's asset or append a new clip; "Phương án thay thế" shows per-episode alternates.
 */
import { useState, type Dispatch } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Empty, Input, Space, Spin, Tabs, Typography, Tooltip } from "antd";
import { Plus, ArrowLeftRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EditorAction, EditorState } from "./state/editor-reducer";
import type { EditorClient } from "./types";

const { Text } = Typography;

export interface FootagePanelProps {
  productionId: string;
  client: EditorClient;
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
}

function selectedClipId(state: EditorState): string | null {
  return state.selection?.kind === "clip" ? state.selection.id : null;
}

export function FootagePanel({ productionId, client, state, dispatch }: FootagePanelProps) {
  const { t } = useTranslation();
  return (
    <Card size="small" title={t("footage.title")} style={{ height: "100%" }}>
      <Tabs
        size="small"
        items={[
          {
            key: "catalog",
            label: t("footage.tabCatalog"),
            children: <CatalogTab productionId={productionId} client={client} state={state} dispatch={dispatch} />,
          },
          {
            key: "alternates",
            label: t("footage.tabAlternates"),
            children: <AlternatesTab state={state} dispatch={dispatch} />,
          },
        ]}
      />
    </Card>
  );
}

function CatalogTab({ productionId, client, state, dispatch }: FootagePanelProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["catalog", productionId],
    queryFn: () => client.getProductionCatalog(productionId),
  });
  const [filter, setFilter] = useState("");

  if (isLoading) return <Spin />;
  if (isError || !data) return <Alert type="error" message={t("footage.loadFailed")} />;

  const q = filter.trim().toLowerCase();
  const assets = q
    ? data.assets.filter((a) =>
        a.title_vi.toLowerCase().includes(q) ||
        a.summary_vi.toLowerCase().includes(q) ||
        a.tags.some((tag) => tag.toLowerCase().includes(q))
      )
    : data.assets;

  const clipId = selectedClipId(state);

  return (
    <div>
      <Input.Search
        placeholder={t("footage.searchPlaceholder")}
        allowClear
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <Space direction="vertical" style={{ width: "100%", maxHeight: 520, overflowY: "auto" }}>
        {assets.slice(0, 200).map((asset) => {
          const alreadyInTimeline = state.timeline.clips.some((c) => c.asset_id === asset.asset_id);
          return (
            <div key={asset.asset_id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
              <Space direction="vertical" size={2} style={{ flex: 1 }}>
                <Text style={{ fontSize: 12 }} ellipsis={{ tooltip: asset.title_vi }}>{asset.title_vi}</Text>
                <Text type="secondary" style={{ fontSize: 11 }}>{asset.duration_s.toFixed(1)}s</Text>
                <Space size={4}>
                  <Tooltip title={clipId ? t("footage.swapClip") : t("footage.selectClipFirst")}>
                    <Button
                      size="small"
                      icon={<ArrowLeftRight size={12} />}
                      aria-label={t("footage.swapClip")}
                      disabled={!clipId}
                      onClick={() =>
                        clipId &&
                        dispatch({
                          type: "swapClip",
                          clipId,
                          newAssetId: asset.asset_id,
                          asset: { title: asset.title_vi, summary_vi: asset.summary_vi, duration_s: asset.duration_s, orientation: asset.orientation },
                        })
                      }
                    />
                  </Tooltip>
                  <Tooltip title={alreadyInTimeline ? t("footage.alreadyAdded") : t("footage.addToEnd")}>
                    <Button
                      size="small"
                      icon={<Plus size={12} />}
                      aria-label={t("footage.addToEnd")}
                      disabled={alreadyInTimeline}
                      onClick={() =>
                        dispatch({
                          type: "addClip",
                          assetId: asset.asset_id,
                          index: state.timeline.clips.length,
                          asset: { title: asset.title_vi, summary_vi: asset.summary_vi, duration_s: asset.duration_s, orientation: asset.orientation },
                        })
                      }
                    />
                  </Tooltip>
                </Space>
              </Space>
            </div>
          );
        })}
        {assets.length === 0 && <Empty description={t("footage.noResults")} />}
      </Space>
    </div>
  );
}

function AlternatesTab({ state, dispatch }: Pick<FootagePanelProps, "state" | "dispatch">) {
  const { t } = useTranslation();
  const clipId = selectedClipId(state);
  if (!clipId) return <Empty description={t("footage.selectClipHint")} />;
  const alternates = state.timeline.alternates;
  if (!alternates.length) return <Empty description={t("footage.noAlternates")} />;

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      {alternates.map((alt) => {
        const asset = state.timeline.assets[alt.asset_id];
        return (
          <div key={alt.asset_id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Space direction="vertical" size={2} style={{ flex: 1 }}>
              <Text style={{ fontSize: 12 }}>{asset?.title ?? alt.asset_id}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>{alt.reason}</Text>
              <Button
                size="small"
                icon={<ArrowLeftRight size={12} />}
                onClick={() => dispatch({ type: "swapClip", clipId, newAssetId: alt.asset_id })}
              >
                {t("footage.swapClip")}
              </Button>
            </Space>
          </div>
        );
      })}
    </Space>
  );
}
