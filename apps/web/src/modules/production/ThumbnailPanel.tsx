/**
 * ThumbnailPanel — the episode's thumbnails: the picture in use, three tabs (suggestions, frames cut from the
 * video, pictures a person made), a word editor, upload, "cut frames" and Canva open/pull. Replaces the old
 * 3-thumbnail radio picker in EpisodeDrawer.
 */
import { useState } from "react";
import { Alert, App as AntApp, Button, Popconfirm, Space, Tabs, Typography, Upload } from "antd";
import { Download, ExternalLink, RotateCcw, Scissors, Trash2, Type, Upload as UploadIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { YoutubeKit } from "@harness/contracts";
import { StudioHttpError, useStudioClient, type ThumbnailList, type ThumbnailView } from "../../api/studio-client";
import { ThumbnailGrid } from "./ThumbnailGrid";
import { ThumbnailWordEditor } from "./ThumbnailWordEditor";
import { errorText, formatTs, thumbBox } from "./thumbnail-helpers";

const { Text } = Typography;

const UPLOAD_ACCEPT = "image/jpeg,image/png,image/webp";
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

type TabKey = "suggestion" | "frame" | "mine";

function bucketOf(tab: TabKey, items: ThumbnailView[]): ThumbnailView[] {
  if (tab === "suggestion") return items.filter((i) => i.kind === "suggestion");
  if (tab === "frame") return items.filter((i) => i.kind === "frame");
  return items.filter(
    (i) => i.kind === "composed" || i.kind === "upload" || i.kind === "canva" || (i.kind === "frame" && i.createdBy !== "system")
  );
}

interface Props {
  productionId: string;
  episodeId: string;
  youtubeKit: YoutubeKit | null;
  canEdit: boolean;
}

export function ThumbnailPanel({ productionId, episodeId, youtubeKit, canEdit }: Props) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();

  const thumbsKey = ["thumbnails", productionId, episodeId] as const;
  const { data, isLoading } = useQuery({
    queryKey: thumbsKey,
    queryFn: () => client.listThumbnails(productionId, episodeId),
    refetchInterval: (q) => (q.state.data?.framesPending ? 3_000 : false),
  });

  const { data: canva } = useQuery({
    queryKey: ["canva-connection"],
    queryFn: () => client.getCanvaConnection(),
  });

  const { data: brandingDoc } = useQuery({
    queryKey: ["production-branding", productionId],
    queryFn: () => client.getProductionBranding(productionId),
  });

  const [activeTab, setActiveTab] = useState<TabKey>("suggestion");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editorBase, setEditorBase] = useState<ThumbnailView | null>(null);

  const items = data?.items ?? [];
  const selectedId = data?.selectedId ?? null;
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const active = items.find((i) => i.id === activeId) ?? null;

  const refreshFromList = (list: ThumbnailList) => qc.setQueryData(thumbsKey, list);

  const selectMutation = useMutation({
    mutationFn: (thumbnailId: string) => client.selectThumbnail(productionId, episodeId, thumbnailId),
    onSuccess: (list) => { refreshFromList(list); void message.success(t("thumbnails.useDone")); },
    onError: (err) => void message.error(errorText(err, t)),
  });

  const deleteMutation = useMutation({
    mutationFn: (thumbnailId: string) => client.deleteThumbnail(productionId, episodeId, thumbnailId),
    onSuccess: (list) => {
      refreshFromList(list);
      void message.success(t("thumbnails.deleteDone"));
      setActiveId((id) => (id && !list.items.some((i) => i.id === id) ? null : id));
    },
    onError: (err) => void message.error(errorText(err, t)),
  });

  const cutFramesMutation = useMutation({
    mutationFn: () => client.startCutFrames(productionId, episodeId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: thumbsKey });
      void message.success(t("thumbnails.cutFramesStarted"));
    },
    onError: (err) => void message.error(errorText(err, t)),
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => client.uploadThumbnail(productionId, episodeId, file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: thumbsKey });
      void message.success(t("thumbnails.uploadDone"));
    },
    onError: (err) => void message.error(errorText(err, t)),
  });

  async function startCanvaConnect() {
    const returnTo = window.location.pathname + window.location.search;
    const { authorizeUrl } = await client.authorizeCanva(returnTo);
    window.location.href = authorizeUrl;
  }

  const openCanvaMutation = useMutation({
    mutationFn: async (thumbnailId: string) => {
      // Open the tab synchronously (before the awaited call) so popup blockers let it through.
      const w = window.open("", "_blank");
      try {
        const res = await client.openThumbnailInCanva(productionId, episodeId, thumbnailId);
        if (w) w.location.href = res.editUrl;
        return res;
      } catch (err) {
        w?.close();
        throw err;
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: thumbsKey }),
    onError: (err) => {
      const code = err instanceof StudioHttpError ? err.body?.code : null;
      if (code === "canva_not_connected" || code === "canva_reconnect") {
        if (code === "canva_reconnect") void message.info(t("canva.reconnectNotice"));
        void startCanvaConnect();
        return;
      }
      void message.error(errorText(err, t));
    },
  });

  const pullCanvaMutation = useMutation({
    mutationFn: (thumbnailId: string) => client.pullCanvaThumbnail(productionId, episodeId, thumbnailId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: thumbsKey });
      void message.success(t("thumbnails.canvaPullDone"));
    },
    onError: (err) => void message.error(errorText(err, t)),
  });

  if (isLoading || !data) return null;

  if (data.footageHidden) {
    return <Alert type="info" showIcon message={t("thumbnails.footageHidden")} />;
  }

  const canvaEnabled = canva?.enabled ?? false;
  const canDraw = data.canDraw;

  const beforeUpload = (file: File) => {
    if (file.size > UPLOAD_MAX_BYTES) {
      void message.error(t("thumbnails.uploadTooBig"));
      return Upload.LIST_IGNORE;
    }
    uploadMutation.mutate(file);
    return false;
  };

  const defaultTextFor = (base: ThumbnailView) => base.text ?? youtubeKit?.thumbnails?.[0]?.text ?? "";

  const tabs: { key: TabKey; label: string; emptyText: string; caption?: (i: ThumbnailView) => string | null }[] = [
    { key: "suggestion", label: t("thumbnails.tabSuggestion"), emptyText: t("thumbnails.emptySuggestion") },
    { key: "frame", label: t("thumbnails.tabFrame"), emptyText: t("thumbnails.emptyFrame"), caption: (i) => formatTs(i.tS) },
    { key: "mine", label: t("thumbnails.tabMine"), emptyText: t("thumbnails.emptyMine") },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {!canDraw && <Alert type="info" showIcon message={t("thumbnails.noFfmpeg")} />}

      {/* The picture in use */}
      <div>
        <Text strong style={{ display: "block", marginBottom: 8 }}>{t("thumbnails.inUse")}</Text>
        {selected ? (
          <Space direction="vertical" size={8}>
            <img src={selected.url} alt="" style={{ ...thumbBox(selected, 240), objectFit: "cover", borderRadius: 6 }} />
            <Space wrap>
              <Button size="small" icon={<Download size={12} />} href={selected.downloadUrl}>{t("common.download")}</Button>
              {canvaEnabled && canEdit && (
                <Button
                  size="small"
                  icon={<ExternalLink size={12} />}
                  loading={openCanvaMutation.isPending}
                  onClick={() => openCanvaMutation.mutate(selected.id)}
                >
                  {t("thumbnails.openCanva")}
                </Button>
              )}
              {canvaEnabled && canEdit && selected.inCanva && (
                <Button
                  size="small"
                  icon={<RotateCcw size={12} />}
                  loading={pullCanvaMutation.isPending}
                  onClick={() => pullCanvaMutation.mutate(selected.id)}
                >
                  {t("thumbnails.pullCanva")}
                </Button>
              )}
            </Space>
          </Space>
        ) : (
          <Text type="secondary">{t("thumbnails.noneSelected")}</Text>
        )}
      </div>

      {/* Tabs of pictures */}
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as TabKey)}
        items={tabs.map(({ key, label, emptyText, caption }) => ({
          key,
          label,
          children: (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              {key === "frame" && data.canCutFrames && canDraw && canEdit && (
                <Space direction="vertical" size={4} style={{ width: "100%" }}>
                  <Button
                    size="small"
                    icon={<Scissors size={12} />}
                    loading={cutFramesMutation.isPending}
                    disabled={data.framesPending}
                    onClick={() => cutFramesMutation.mutate()}
                  >
                    {data.framesPending ? t("thumbnails.cutFramesPending") : t("thumbnails.cutFrames")}
                  </Button>
                  {data.framesError && <Alert type="error" showIcon message={data.framesError} />}
                </Space>
              )}
              {key === "mine" && canDraw && canEdit && (
                <Upload accept={UPLOAD_ACCEPT} showUploadList={false} beforeUpload={beforeUpload}>
                  <Button size="small" icon={<UploadIcon size={12} />} loading={uploadMutation.isPending}>
                    {t("thumbnails.upload")}
                  </Button>
                </Upload>
              )}
              <ThumbnailGrid
                items={bucketOf(key, items)}
                selectedId={selectedId}
                activeId={activeId}
                onPick={(item) => setActiveId(item.id)}
                emptyText={emptyText}
                caption={caption}
              />
            </Space>
          ),
        }))}
      />

      {/* Actions for the clicked picture */}
      {active && (
        <Space wrap>
          {canEdit && (
            <Button
              size="small"
              type="primary"
              disabled={active.id === selectedId}
              loading={selectMutation.isPending}
              onClick={() => selectMutation.mutate(active.id)}
            >
              {t("thumbnails.use")}
            </Button>
          )}
          {canDraw && canEdit && active.drawable && (
            <Button size="small" icon={<Type size={12} />} onClick={() => setEditorBase(active)}>
              {t("thumbnails.addText")}
            </Button>
          )}
          <Button size="small" icon={<Download size={12} />} href={active.downloadUrl}>{t("common.download")}</Button>
          {canvaEnabled && canEdit && (
            <Button
              size="small"
              icon={<ExternalLink size={12} />}
              loading={openCanvaMutation.isPending}
              onClick={() => openCanvaMutation.mutate(active.id)}
            >
              {t("thumbnails.openCanva")}
            </Button>
          )}
          {canvaEnabled && canEdit && active.inCanva && active.id !== selectedId && (
            <Button
              size="small"
              icon={<RotateCcw size={12} />}
              loading={pullCanvaMutation.isPending}
              onClick={() => pullCanvaMutation.mutate(active.id)}
            >
              {t("thumbnails.pullCanva")}
            </Button>
          )}
          {active.deletable && canEdit && (
            <Popconfirm title={t("thumbnails.deleteConfirm")} onConfirm={() => deleteMutation.mutate(active.id)}>
              <Button size="small" danger icon={<Trash2 size={12} />} loading={deleteMutation.isPending}>
                {t("thumbnails.delete")}
              </Button>
            </Popconfirm>
          )}
        </Space>
      )}

      <ThumbnailWordEditor
        open={!!editorBase}
        base={editorBase}
        defaultText={editorBase ? defaultTextFor(editorBase) : ""}
        branding={brandingDoc?.document ?? null}
        productionId={productionId}
        episodeId={episodeId}
        onClose={() => setEditorBase(null)}
        onComposed={() => void qc.invalidateQueries({ queryKey: thumbsKey })}
        onUseAsThumbnail={(id) => {
          selectMutation.mutate(id);
          setEditorBase(null);
        }}
      />
    </Space>
  );
}
