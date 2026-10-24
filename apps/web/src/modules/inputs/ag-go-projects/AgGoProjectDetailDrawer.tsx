import { useState } from "react";
import { Alert, Avatar, Button, Descriptions, Drawer, Empty, Flex, Image, Modal, Skeleton, Space, Tag, Typography, theme } from "antd";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Camera, Clapperboard, Image as ImageIcon, Play, Plus } from "lucide-react";
import { useAgGoClient, type AgGoProject, type AgGoProjectMedia } from "../../../api/ag-go-client";
import type { AgGoProjectAccess } from "../../../api/workspace-client";
import { useAiTranslation } from "../../common/assistant-name";
import { clock } from "../../workspace/time";
import { AccessTag } from "./access-state";
import { useThumbnailUrl } from "./ProjectGridView";
import { formatDate } from "./text-match";

const MEDIA_PAGE = 48;
/** ag-go's presigned URLs live 15 minutes: the media are asked again well before. */
const MEDIA_STALE_MS = 5 * 60 * 1000;

/** One image or video of the project: its thumbnail, and its length; a video plays when clicked. */
function MediaTile({ m, onPlay }: { m: AgGoProjectMedia; onPlay: (m: AgGoProjectMedia) => void }) {
  const { t } = useAiTranslation();
  const name = m.caption || m.asset.originalFilename || "";
  const video = m.asset.assetType === "video";
  const thumb = m.thumbnailUrl
    ? <img src={m.thumbnailUrl} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    : <Flex align="center" justify="center" style={{ height: "100%", color: "#a1a1aa" }}>{video ? <Clapperboard size={24} /> : <ImageIcon size={24} />}</Flex>;
  return (
    <div className="agp-media">
      {video ? (
        <button type="button" className="agp-media__box" disabled={!m.previewUrl} aria-label={t("ws.agp.detail.play", { name })} onClick={() => onPlay(m)}>
          {thumb}
          {m.previewUrl ? <span className="agp-media__play" aria-hidden><Play size={18} /></span> : null}
          {m.durationSeconds ? <span className="agp-media__len">{clock(m.durationSeconds)}</span> : null}
        </button>
      ) : (
        <div className="agp-media__box">{m.thumbnailUrl ? <Image src={m.previewUrl || m.thumbnailUrl} alt={name} preview={{ src: m.previewUrl || m.thumbnailUrl }} rootClassName="agp-media__image" /> : thumb}</div>
      )}
      <Typography.Text ellipsis={{ tooltip: name }} className="agp-media__name">{name}</Typography.Text>
    </div>
  );
}

/**
 * An ag-go project seen from Studio's picker (plan 2026-10-24 P3): what ag-go says of it (folder path, author, category,
 * place, tags, description, counts), whether the person may add it, and its images and videos as they may see them
 * (`GET /projects/:id/media` with their own token: watermarked unless they may see the originals), a video playing in
 * place. Add puts it in the project at once.
 */
export function AgGoProjectDetailDrawer({ project, access, added, adding, onAdd, onClose }: {
  project: AgGoProject | null; access: AgGoProjectAccess | undefined; added: boolean; adding: boolean; onAdd: (p: AgGoProject) => void; onClose: () => void;
}) {
  const { t } = useAiTranslation();
  const { token } = theme.useToken();
  const agGo = useAgGoClient();
  const open = project !== null;
  const id = project?.id ?? "";
  const detail = useQuery({ queryKey: ["agGo", "project", id], queryFn: () => agGo.getProject(id), enabled: open, staleTime: MEDIA_STALE_MS, retry: false });
  const media = useInfiniteQuery({
    queryKey: ["agGo", "projectMedia", id],
    queryFn: ({ pageParam }) => agGo.getProjectMedia(id, { limit: MEDIA_PAGE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open, staleTime: MEDIA_STALE_MS, retry: false,
  });
  const cover = useThumbnailUrl(project?.thumbnailAssetId);
  const [playing, setPlaying] = useState<AgGoProjectMedia | null>(null);
  if (!project) return null;
  const p = { ...project, ...(detail.data ?? {}) };
  const items = media.data?.pages.flatMap((page) => page.items) ?? [];
  const place = [p.provinceName, p.countryName].filter(Boolean).join(", ");
  const canAdd = !added && access?.state === "addable";

  return (
    <Drawer
      open={open} onClose={onClose} width={760} placement="right" destroyOnHidden rootClassName="agp-drawer"
      title={<span className="agp-detail__title" title={p.name}>{p.name}</span>}
      extra={
        <Space>
          <AccessTag state={access?.state} added={added} />
          <Button type="primary" icon={<Plus size={16} />} disabled={!canAdd} loading={adding} onClick={() => onAdd(project)}>{t("ws.agp.detail.add")}</Button>
        </Space>
      }
    >
      <Flex gap={16} align="start" style={{ marginBottom: 16 }}>
        <div className="agp-detail__cover">
          {cover ? <img src={cover} alt="" /> : <Camera size={36} strokeWidth={1.2} />}
        </div>
        <Descriptions size="small" column={1} style={{ flex: 1, minWidth: 0 }}
          items={[
            { key: "folder", label: t("ws.agp.detail.path"), children: p.folderPath || p.folderName || "-" },
            {
              key: "author", label: t("ws.agp.authorLabel"),
              children: <Space size={6}><Avatar size={20} src={p.ownerUser?.avatar}>{p.ownerUser?.name?.charAt(0)?.toUpperCase()}</Avatar>{p.ownerUser?.name || p.ownerUser?.email || t("ws.agp.unknown")}</Space>,
            },
            { key: "category", label: t("ws.agp.category"), children: p.categoryName || "-" },
            { key: "place", label: t("ws.agp.locationLabel"), children: place || "-" },
            { key: "tags", label: t("ws.agp.tags"), children: p.tags?.length ? <Space size={[4, 4]} wrap>{p.tags.map((x) => <Tag key={x}>{x}</Tag>)}</Space> : "-" },
            {
              key: "counts", label: t("ws.agp.fileCounts"),
              children: (
                <Space direction="vertical" size={0}>
                  <span>{t("ws.agp.detail.counts", { images: p.imageCount, videos: p.videoCount })}</span>
                  {access && access.state !== "not_visible" ? <Typography.Text type="secondary">{t("ws.agp.detail.analyzed", { usable: access.usableVideos, analyzed: access.analyzedVideos })}</Typography.Text> : null}
                </Space>
              ),
            },
            { key: "updated", label: t("ws.agp.updatedAt"), children: formatDate(p.updatedAt || p.createdAt) },
          ]}
        />
      </Flex>
      {access && access.state !== "addable" && !added ? <Alert showIcon type="info" style={{ marginBottom: 16 }} message={t(`ws.agp.stateHelp.${access.state}`)} /> : null}
      <Typography.Title level={5}>{t("ws.agp.detail.description")}</Typography.Title>
      <Typography.Paragraph type={p.description ? undefined : "secondary"} style={{ whiteSpace: "pre-wrap" }}>{p.description || t("ws.agp.detail.noDescription")}</Typography.Paragraph>

      <Typography.Title level={5}>{t("ws.agp.detail.media")}</Typography.Title>
      {media.error ? <Alert showIcon type="error" message={t("ws.agp.detail.mediaFailed")} /> : media.isLoading ? <Skeleton active /> : items.length ? (
        <>
          <div className="agp-media-grid">{items.map((m) => <MediaTile key={m.id} m={m} onPlay={setPlaying} />)}</div>
          {media.hasNextPage ? (
            <Flex justify="center" style={{ marginTop: 12 }}>
              <Button loading={media.isFetchingNextPage} onClick={() => void media.fetchNextPage()}>{t("ws.agp.detail.loadMore")}</Button>
            </Flex>
          ) : null}
        </>
      ) : <Empty description={<Typography.Text type="secondary">{t("ws.agp.detail.noMedia")}</Typography.Text>} />}

      <Modal open={playing !== null} onCancel={() => setPlaying(null)} footer={null} width={880} destroyOnHidden
        title={playing ? <Space>{playing.caption || playing.asset.originalFilename}{playing.watermarkVariant ? <Tag>{t("ws.agp.detail.watermarked")}</Tag> : null}</Space> : null}>
        {playing?.previewUrl ? (
          <video src={playing.previewUrl} controls autoPlay style={{ width: "100%", maxHeight: "70vh", background: token.colorBgSpotlight }} aria-label={t("ws.agp.detail.play", { name: playing.caption || playing.asset.originalFilename || "" })} />
        ) : null}
      </Modal>
    </Drawer>
  );
}
