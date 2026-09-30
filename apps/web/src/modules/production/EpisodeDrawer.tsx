/**
 * Episode drawer: YouTube kit editor (3-title pick, description+chapters preview, tags counter,
 * hashtags, playlist, copy buttons), 3 thumbnail picks, final video player, download links,
 * cost_usd, role-based buttons.
 */
import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Image,
  Input,
  Progress,
  Radio,
  Space,
  Steps,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from "antd";
import { Copy, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStudioClient } from "../../api/studio-client";
import type { EpisodeDetail, EpisodePatch } from "../../api/studio-client";
import type { YoutubeKit } from "@harness/contracts";
import { YOUTUBE_TAGS_MAX_CHARS } from "@harness/contracts";
import { PremiereExports } from "./PremiereExports";

const { Text, Paragraph } = Typography;

function tagsCharCount(tags: string[]): number {
  return tags.join(",").length;
}

interface Props {
  productionId: string;
  episode: EpisodeDetail;
  open: boolean;
  onClose: () => void;
  canEdit: boolean;
}

export function EpisodeDrawer({ productionId, episode, open, onClose, canEdit }: Props) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();

  const [yt, setYt] = useState<YoutubeKit | null>(episode.youtube);
  const [selectedTitle, setSelectedTitle] = useState<0 | 1 | 2>(
    (episode.selectedTitle as 0 | 1 | 2) ?? 0
  );
  const [selectedThumbnail, setSelectedThumbnail] = useState<0 | 1 | 2>(
    (episode.selectedThumbnail as 0 | 1 | 2) ?? 0
  );

  const saveMutation = useMutation({
    mutationFn: (patch: EpisodePatch) =>
      client.patchEpisode(productionId, episode.id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["episode", productionId, episode.id] });
      void qc.invalidateQueries({ queryKey: ["episodes", productionId] });
      void message.success(t("episodes.saveMeta"));
    },
  });

  const handleSave = () => {
    if (!yt) return;
    saveMutation.mutate({ youtube: yt, selectedTitle, selectedThumbnail });
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    void message.success(t("common.copied"));
  };

  const tagsCount = yt ? tagsCharCount(yt.tags) : 0;
  const tagsExceeded = tagsCount > YOUTUBE_TAGS_MAX_CHARS;

  // Stage steps from run
  const runStages = episode.run?.stages ?? [];

  return (
    <Drawer
      title={episode.title}
      open={open}
      onClose={onClose}
      width={640}
      extra={
        canEdit && yt ? (
          <Button type="primary" onClick={handleSave} loading={saveMutation.isPending}>
            {t("episodes.saveMeta")}
          </Button>
        ) : null
      }
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        {/* Episode run steps */}
        {runStages.length > 0 && (
          <Card title={t("run.title")} size="small">
            <Steps
              size="small"
              direction="vertical"
              current={runStages.findIndex((s) => s.state === "RUNNING" || s.state === "WAITING_HUMAN")}
              items={runStages.map((s) => ({
                title: s.key,
                status:
                  s.state === "SUCCEEDED" ? "finish"
                  : s.state === "FAILED" ? "error"
                  : s.state === "RUNNING" || s.state === "WAITING_HUMAN" ? "process"
                  : "wait",
                description: s.error ?? undefined,
              }))}
            />
            {episode.run?.cost_usd != null && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t("episodes.drawerCost", { cost: episode.run.cost_usd.toFixed(4) })}
              </Text>
            )}
          </Card>
        )}

        {/* YouTube Kit */}
        {yt && (
          <Card title={t("episodes.drawerYoutubeKit")} size="small">
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              {/* Title picks */}
              <div>
                <Text strong>{t("episodes.titlePick", { n: "" }).trim()}</Text>
                <Radio.Group
                  value={selectedTitle}
                  onChange={(e) => setSelectedTitle(e.target.value as 0 | 1 | 2)}
                  style={{ display: "block", marginTop: 8 }}
                >
                  {yt.titles.map((title, i) => (
                    <div key={i} style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <Radio value={i as 0 | 1 | 2} style={{ flexShrink: 0, marginTop: 4 }} />
                      <div style={{ flex: 1 }}>
                        <Input
                          value={title}
                          readOnly={!canEdit}
                          onChange={(e) => {
                            const updated = [...yt.titles] as [string, string, string];
                            updated[i] = e.target.value;
                            setYt({ ...yt, titles: updated });
                          }}
                        />
                      </div>
                      <Tooltip title={t("episodes.copyTitle")}>
                        <Button
                          size="small"
                          icon={<Copy size={12} />}
                          onClick={() => void copyToClipboard(title)}
                        />
                      </Tooltip>
                    </div>
                  ))}
                </Radio.Group>
              </div>

              {/* Description */}
              <div>
                <Space style={{ width: "100%", justifyContent: "space-between" }}>
                  <Text strong>{t("episodes.descriptionLabel")}</Text>
                  <Tooltip title={t("episodes.copyDescription")}>
                    <Button
                      size="small"
                      icon={<Copy size={12} />}
                      onClick={() => void copyToClipboard(yt.description)}
                    />
                  </Tooltip>
                </Space>
                <Input.TextArea
                  rows={4}
                  value={yt.description}
                  readOnly={!canEdit}
                  onChange={(e) => canEdit && setYt({ ...yt, description: e.target.value })}
                />
              </div>

              {/* Tags */}
              <div>
                <Space style={{ justifyContent: "space-between", width: "100%" }}>
                  <Text strong>{t("episodes.tagsLabel")}</Text>
                  <Tag color={tagsExceeded ? "red" : "default"}>
                    {t("episodes.tagCounter", { count: tagsCount })}
                  </Tag>
                </Space>
                {tagsExceeded && (
                  <Alert type="error" message={t("episodes.tagsTooLong")} banner style={{ marginBottom: 4 }} />
                )}
                <Input.TextArea
                  rows={3}
                  value={yt.tags.join(", ")}
                  readOnly={!canEdit}
                  onChange={(e) => {
                    if (!canEdit) return;
                    const tags = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                    setYt({ ...yt, tags });
                  }}
                />
                <Progress
                  percent={Math.min(100, Math.round((tagsCount / YOUTUBE_TAGS_MAX_CHARS) * 100))}
                  status={tagsExceeded ? "exception" : "normal"}
                  size="small"
                  showInfo={false}
                />
              </div>

              {/* Hashtags */}
              <div>
                <Text strong>{t("episodes.hashtagsLabel")}</Text>
                <Input
                  value={yt.hashtags.join(" ")}
                  readOnly={!canEdit}
                  onChange={(e) => {
                    if (!canEdit) return;
                    const hashtags = e.target.value.split(/\s+/).filter((h) => h.startsWith("#"));
                    setYt({ ...yt, hashtags });
                  }}
                />
              </div>

              {/* Playlist */}
              <div>
                <Text strong>{t("episodes.playlistLabel")}</Text>
                <Input
                  value={yt.playlist}
                  readOnly={!canEdit}
                  onChange={(e) => canEdit && setYt({ ...yt, playlist: e.target.value })}
                />
              </div>
            </Space>
          </Card>
        )}

        {/* Thumbnails */}
        {episode.thumbnails.length > 0 && (
          <Card title={t("episodes.drawerThumbnails")} size="small">
            <Radio.Group
              value={selectedThumbnail}
              onChange={(e) => setSelectedThumbnail(e.target.value as 0 | 1 | 2)}
            >
              <Space size={8}>
                {episode.thumbnails.map((thumb) => (
                  <div key={thumb.index} style={{ position: "relative" }}>
                    <Radio value={thumb.index as 0 | 1 | 2} style={{ position: "absolute", top: 4, left: 4, zIndex: 1 }} />
                    <Image
                      src={thumb.url}
                      width={160}
                      height={90}
                      style={{ objectFit: "cover", borderRadius: 4 }}
                      fallback="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
                    />
                  </div>
                ))}
              </Space>
            </Radio.Group>
          </Card>
        )}

        {/* Final video */}
        {episode.finalVideoUrl && (
          <Card title={t("episodes.drawerVideo")} size="small">
            <video src={episode.finalVideoUrl} controls style={{ width: "100%", borderRadius: 4 }} />
          </Card>
        )}

        {/* Adobe Premiere exports */}
        <PremiereExports productionId={productionId} episodeId={episode.id} canEdit={canEdit} />

        {/* Downloads */}
        {episode.exportFiles.length > 0 && (
          <Card title={t("episodes.drawerDownloads")} size="small">
            <Space wrap>
              {episode.exportFiles.map((f, i) => (
                <Button key={i} size="small" icon={<Download size={12} />} href={f.url} download={f.name}>
                  {f.name}
                </Button>
              ))}
            </Space>
          </Card>
        )}
      </Space>
    </Drawer>
  );
}
