import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Button, Checkbox, Col, Empty, Row, Skeleton, Tooltip, Typography, theme } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Camera, Check, Clapperboard, Clock, Eye, Folder, Image as ImageIcon, MapPin, Plus } from "lucide-react";
import { useAgGoClient, type AgGoProject } from "../../../api/ag-go-client";
import type { AgGoAddability } from "../../../api/workspace-client";
import { useAiTranslation } from "../../common/assistant-name";
import { AccessBadge } from "./access-state";
import { formatDate } from "./text-match";
import "./project-grid.css";

/** Column span by the grid's own width (not the viewport), so the filter sidebar is accounted for (as ag-go). */
const GRID_BREAKPOINTS = [
  { minWidth: 2600, span: 3 }, { minWidth: 1900, span: 4 }, { minWidth: 1200, span: 6 }, { minWidth: 1024, span: 8 }, { minWidth: 768, span: 12 }, { minWidth: 0, span: 24 },
];
export const PROJECT_GRID_GUTTER = 24;
const spanFor = (width: number) => GRID_BREAKPOINTS.find((b) => width >= b.minWidth)?.span ?? 24;

export function useResponsiveColSpan<T extends HTMLElement = HTMLDivElement>() {
  const [colSpan, setColSpan] = useState(6);
  const observer = useRef<ResizeObserver | null>(null);
  const containerRef = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    setColSpan(spanFor(node.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => { if (e) setColSpan(spanFor(e.contentRect.width)); });
    ro.observe(node);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return { containerRef, colSpan };
}

// Presigned URLs live 15 minutes by default; fetched again well before.
const PREVIEW_STALE_MS = 5 * 60 * 1000;

/** The presigned URL of a project's thumbnail, or undefined while loading / when there is none. */
export function useThumbnailUrl(assetId: string | null | undefined): string | undefined {
  const agGo = useAgGoClient();
  const q = useQuery({
    queryKey: ["agGo", "preview-url", assetId ?? "", "thumbnail"], queryFn: () => agGo.getAssetPreviewUrl(assetId!),
    enabled: Boolean(assetId), staleTime: PREVIEW_STALE_MS, gcTime: PREVIEW_STALE_MS * 2, retry: false,
  });
  return assetId ? q.data : undefined;
}

function Cover({ project }: { project: AgGoProject }) {
  const url = useThumbnailUrl(project.thumbnailAssetId);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) return <div className="agp-placeholder"><Camera style={{ width: 48, height: 48 }} strokeWidth={1.2} /></div>;
  return <img alt={project.name} src={url} className="agp-image" onError={() => setFailed(true)} />;
}

/** Placeholder cards laid out with the same columns as the loaded grid; two rows. */
export function ProjectGridSkeleton({ rows = 2 }: { rows?: number }) {
  const { token } = theme.useToken();
  const { containerRef, colSpan } = useResponsiveColSpan<HTMLDivElement>();
  return (
    <div ref={containerRef} aria-busy>
      <Row gutter={[PROJECT_GRID_GUTTER, PROJECT_GRID_GUTTER]}>
        {Array.from({ length: (24 / colSpan) * rows }).map((_, i) => (
          <Col span={colSpan} key={i}>
            <div className="agp-card" style={{ border: `1px solid ${token.colorBorderSecondary}`, cursor: "default" }}>
              <div className="agp-skeleton" style={{ position: "absolute", inset: 0, borderRadius: 0 }} />
              <div style={{ position: "absolute", top: 12, left: 12 }}><Skeleton.Button active size="small" style={{ width: 80, borderRadius: 100 }} /></div>
              <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 8 }}><Skeleton.Button active size="small" style={{ width: 50, borderRadius: 100 }} /></div>
              <div className="agp-title"><Skeleton.Input active size="small" style={{ width: "90%", height: 24, borderRadius: 4 }} /></div>
            </div>
          </Col>
        ))}
      </Row>
    </div>
  );
}

/**
 * ag-go's project cards: the thumbnail filling a square, category and image/video counts on top with whether it can be
 * added, the name at the bottom; on hover, where it is, who made it, its folder and when it changed, See details and
 * Pick. A card picks itself when clicked; projects already added, or that the person may not add, cannot be picked.
 */
export function ProjectGridView({ items, isLoading, emptyText, selectedIds, addedIds, stateOf, canSelect, onToggle, onOpen, onFilterFolder, onFilterLocation }: {
  items: AgGoProject[]; isLoading: boolean; emptyText: string; selectedIds: ReadonlySet<string>; addedIds: ReadonlySet<string>;
  /** Whether the person may add each project (unknown while it is asked). */
  stateOf: (p: AgGoProject) => AgGoAddability | undefined;
  canSelect: (p: AgGoProject) => boolean; onToggle: (p: AgGoProject, selected: boolean) => void;
  /** Opens the project's detail drawer. */
  onOpen: (p: AgGoProject) => void;
  onFilterFolder: (folderId: string) => void; onFilterLocation: (l: { countryId: string; provinceId?: string | undefined }) => void;
}) {
  const { t } = useAiTranslation();
  const { token } = theme.useToken();
  const { containerRef, colSpan } = useResponsiveColSpan<HTMLDivElement>();
  if (isLoading) return <ProjectGridSkeleton />;
  if (!items.length) return <div style={{ padding: "40px 0" }}><Empty description={<Typography.Text type="secondary">{emptyText}</Typography.Text>} /></div>;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div ref={containerRef}>
      <Row gutter={[PROJECT_GRID_GUTTER, PROJECT_GRID_GUTTER]}>
        {items.map((p) => {
          const selected = selectedIds.has(p.id);
          const added = addedIds.has(p.id);
          const selectable = canSelect(p);
          const place = [p.provinceName, p.countryName].filter(Boolean).join(", ") || "-";
          return (
            <Col span={colSpan} key={p.id}>
              <div
                className={`agp-card${selectable ? "" : " agp-card--disabled"}`} data-testid={`agp-card-${p.id}`}
                style={selected ? { outline: `2px solid ${token.colorPrimary}`, outlineOffset: -2 } : undefined}
                onClick={() => { if (selectable) onToggle(p, !selected); }}
              >
                <Cover project={p} />
                <div className="agp-gradient" />
                <div className="agp-select" onClick={stop}>
                  <Checkbox aria-label={p.name} checked={selected || added} disabled={!selectable} onChange={(e) => onToggle(p, e.target.checked)} />
                </div>
                {p.categoryName ? (
                  <div className="agp-category" style={{ left: 44 }}>
                    <div className="agp-badge" title={p.categoryName}><span className="agp-category-name">{p.categoryName}</span></div>
                  </div>
                ) : null}
                <div className="agp-counts">
                  <AccessBadge state={stateOf(p)} added={added} />
                  {p.imageCount > 0 ? (
                    <Tooltip title={`${p.imageCount} ${t("ws.agp.image")}`}><div className="agp-badge"><ImageIcon size={14} /><span>{p.imageCount}</span></div></Tooltip>
                  ) : null}
                  {p.videoCount > 0 ? (
                    <Tooltip title={`${p.videoCount} ${t("ws.agp.video")}`}><div className="agp-badge"><Clapperboard size={14} /><span>{p.videoCount}</span></div></Tooltip>
                  ) : null}
                </div>
                <div className="agp-title">
                  <Typography.Paragraph ellipsis={{ rows: 2 }} title={p.name}
                    style={{ marginBottom: 0, fontWeight: 600, fontSize: 16, lineHeight: "22px", color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>
                    {p.name}
                  </Typography.Paragraph>
                </div>
                <div className="agp-hover">
                  <div className="agp-info" onClick={stop}>
                    <div className="agp-info-row">
                      <div className="agp-icon-box"><MapPin size={16} /></div>
                      <div className="agp-info-content">
                        <div className="agp-info-label">{t("ws.agp.locationLabel")}</div>
                        <div className="agp-info-value" title={place}>
                          {p.countryId && p.countryName ? (
                            <Tooltip title={t("ws.agp.clickToFilter")}>
                              <span>
                                {p.provinceId && p.provinceName ? (
                                  <><button type="button" className="agp-info-link agp-inline" onClick={() => onFilterLocation({ countryId: p.countryId!, provinceId: p.provinceId! })}>{p.provinceName}</button>{", "}</>
                                ) : null}
                                <button type="button" className="agp-info-link agp-inline" onClick={() => onFilterLocation({ countryId: p.countryId! })}>{p.countryName}</button>
                              </span>
                            </Tooltip>
                          ) : place}
                        </div>
                      </div>
                    </div>
                    <div className="agp-info-row">
                      <Avatar size={32} src={p.ownerUser?.avatar} style={{ flexShrink: 0, backgroundColor: "#1677ff" }}>{p.ownerUser?.name?.charAt(0)?.toUpperCase()}</Avatar>
                      <div className="agp-info-content">
                        <div className="agp-info-label">{t("ws.agp.authorLabel")}</div>
                        <div className="agp-info-value" title={p.ownerUser?.name || t("ws.agp.unknown")}>{p.ownerUser?.name || p.ownerUser?.email || t("ws.agp.unknown")}</div>
                      </div>
                    </div>
                    <div className="agp-info-row">
                      <div className="agp-icon-box"><Folder size={16} /></div>
                      <div className="agp-info-content">
                        <div className="agp-info-label">{t("ws.agp.folder")}</div>
                        {p.folderId && (p.folderName || p.folderPath) ? (
                          <Tooltip title={<><div>{p.folderPath || p.folderName}</div><div style={{ opacity: 0.7, fontSize: 12 }}>{t("ws.agp.clickToFilter")}</div></>}>
                            <button type="button" className="agp-info-value agp-info-link" onClick={() => onFilterFolder(p.folderId!)}>{p.folderName || p.folderPath}</button>
                          </Tooltip>
                        ) : <div className="agp-info-value">{p.folderName || p.folderPath || "-"}</div>}
                      </div>
                    </div>
                    <div className="agp-info-row">
                      <div className="agp-icon-box"><Clock size={16} /></div>
                      <div className="agp-info-content">
                        <div className="agp-info-label">{t("ws.agp.updatedAt")}</div>
                        <div className="agp-info-value">{formatDate(p.updatedAt || p.createdAt)}</div>
                      </div>
                    </div>
                  </div>
                  <div className="agp-actions" onClick={stop}>
                    <Tooltip title={t("ws.agp.details")}>
                      <Button shape="circle" size="large" className="agp-action" icon={<Eye size={20} />} aria-label={`${t("ws.agp.details")} ${p.name}`} onClick={() => onOpen(p)} />
                    </Tooltip>
                    <Tooltip title={added ? t("ws.agp.added") : selected ? t("ws.agp.unselect") : t("ws.agp.select")}>
                      <Button
                        type={selected ? "primary" : "default"} shape="circle" size="large" className="agp-action" disabled={!selectable}
                        icon={selected || added ? <Check size={20} /> : <Plus size={20} />}
                        aria-label={`${selected ? t("ws.agp.unselect") : t("ws.agp.select")} ${p.name}`}
                        onClick={() => onToggle(p, !selected)}
                      />
                    </Tooltip>
                  </div>
                </div>
              </div>
            </Col>
          );
        })}
      </Row>
    </div>
  );
}
