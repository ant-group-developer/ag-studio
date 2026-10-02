/**
 * Series plan editor: view + edit the SeriesPlan, then submit the approve-plan gate.
 * Uses @dnd-kit/sortable for reordering items within an episode.
 */
import { useState, useCallback } from "react";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Dropdown,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2, ArrowLeftRight, CheckCircle, AlertTriangle, PlusCircle, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { useStudioClient } from "../../api/studio-client";
import { useDebouncedValue } from "../../helpers/use-debounced-value";
import { gateProblems } from "./gate-problems";
import type { SeriesPlan, PlannedEpisode, StudioCatalog, CatalogAsset } from "@harness/contracts";
import { EPISODE_DURATION_TOLERANCE, SeriesPlanSchema } from "@harness/contracts";
import { App as AntApp } from "antd";

const { Text, Title } = Typography;

// ---------------------------------------------------------------------------
// CatalogPickerModal — "Thêm video" per episode
// ---------------------------------------------------------------------------
interface AssetRowProps {
  asset: CatalogAsset;
  productionId: string;
  disabled: boolean;
  onSelect: (assetId: string) => void;
}

function AssetRow({ asset, productionId, disabled, onSelect }: AssetRowProps) {
  const client = useStudioClient();
  const { data: media, isLoading } = useQuery({
    queryKey: ["asset-media", productionId, asset.asset_id],
    queryFn: () => client.getAssetMedia(productionId, asset.asset_id),
    staleTime: 1000 * 60 * 5,
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 8px",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        background: "transparent",
      }}
      onClick={() => {
        if (!disabled) onSelect(asset.asset_id);
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLDivElement).style.background = "var(--ant-color-bg-text-hover, rgba(0,0,0,0.04))";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      <div
        style={{
          width: 60,
          height: 34,
          borderRadius: 4,
          overflow: "hidden",
          flexShrink: 0,
          background: "#f0f0f0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {isLoading ? (
          <Spin size="small" />
        ) : media?.posterUrl ? (
          <img
            src={media.posterUrl}
            alt={asset.title_vi}
            style={{ width: 60, height: 34, objectFit: "cover" }}
            loading="lazy"
          />
        ) : (
          <div style={{ width: 60, height: 34, background: "#d9d9d9" }} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text strong ellipsis style={{ display: "block", fontSize: 13 }}>
          {asset.title_vi}
        </Text>
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {Math.round(asset.duration_s)}s
          </Text>
          {asset.orientation && (
            <Tag style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>{asset.orientation}</Tag>
          )}
        </Space>
      </div>
    </div>
  );
}

interface CatalogPickerModalProps {
  open: boolean;
  onClose: () => void;
  productionId: string;
  catalog: StudioCatalog | null;
  ep: PlannedEpisode;
  onChange: (ep: PlannedEpisode) => void;
}

function CatalogPickerModal({ open, onClose, productionId, catalog, ep, onChange }: CatalogPickerModalProps) {
  const { t } = useTranslation();
  const [searchText, setSearchText] = useState("");
  const debouncedSearch = useDebouncedValue(searchText, 250);

  const existingIds = new Set(ep.items.map((i) => i.asset_id));

  const filtered = (catalog?.assets ?? []).filter((a) => {
    if (!debouncedSearch) return true;
    const q = debouncedSearch.toLowerCase();
    return (
      a.title_vi.toLowerCase().includes(q) ||
      a.summary_vi.toLowerCase().includes(q) ||
      a.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });

  const handleSelect = (assetId: string) => {
    onChange({
      ...ep,
      items: [...ep.items, { asset_id: assetId, reason: "added", section_title: null }],
    });
  };

  return (
    <Modal
      open={open}
      title={t("planEditor.catalogSearch")}
      onCancel={onClose}
      footer={null}
      width={560}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <Input.Search
          placeholder={t("planEditor.catalogSearchPlaceholder", { defaultValue: "Tìm kiếm..." })}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
        />
        <div style={{ maxHeight: 420, overflowY: "auto" }}>
          {filtered.length === 0 ? (
            <Text type="secondary" style={{ padding: "16px 0", display: "block", textAlign: "center" }}>
              {t("planEditor.catalogEmpty")}
            </Text>
          ) : (
            filtered.map((asset) => (
              <AssetRow
                key={asset.asset_id}
                asset={asset}
                productionId={productionId}
                disabled={existingIds.has(asset.asset_id)}
                onSelect={handleSelect}
              />
            ))
          )}
        </div>
      </Space>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sortable item row
// ---------------------------------------------------------------------------
interface SortableItemProps {
  id: string;
  asset?: CatalogAsset;
  item: PlannedEpisode["items"][number];
  alternates: PlannedEpisode["alternates"];
  assetMap: Map<string, CatalogAsset>;
  onRemove: () => void;
  onSectionTitleChange: (v: string | null) => void;
  onSwapAlternate: (altAssetId: string) => void;
}

function SortableItem({ id, asset, item, alternates, assetMap, onRemove, onSectionTitleChange, onSwapAlternate }: SortableItemProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={{ ...style, display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border-color, #f0f0f0)" }}>
      <span {...attributes} {...listeners} style={{ cursor: "grab", paddingTop: 4, color: "#999" }}>
        <GripVertical size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text strong ellipsis style={{ display: "block" }}>
          {asset?.title_vi || item.asset_id}
        </Text>
        {asset && (
          <Text type="secondary" style={{ fontSize: 12 }}>{Math.round(asset.duration_s)}s</Text>
        )}
        <Input
          size="small"
          placeholder={t("planEditor.sectionTitlePlaceholder")}
          value={item.section_title ?? ""}
          onChange={(e) => onSectionTitleChange(e.target.value || null)}
          style={{ marginTop: 4, fontSize: 12 }}
        />
      </div>
      {alternates.length > 0 && (
        <Dropdown
          trigger={["click"]}
          menu={{
            items: alternates.map((alt) => ({
              key: alt.asset_id,
              label: assetMap.get(alt.asset_id)?.title_vi ?? alt.asset_id,
              onClick: () => onSwapAlternate(alt.asset_id),
            })),
          }}
        >
          <Tooltip title={t("planEditor.swapAlternate")}>
            <Button
              size="small"
              icon={<ArrowLeftRight size={12} />}
            >
              ({alternates.length})
            </Button>
          </Tooltip>
        </Dropdown>
      )}
      <Tooltip title={t("planEditor.removeItem")}>
        <Button size="small" danger icon={<Trash2 size={12} />} onClick={onRemove} />
      </Tooltip>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Episode card
// ---------------------------------------------------------------------------
interface EpisodeCardProps {
  ep: PlannedEpisode;
  targetSeconds: number;
  catalog: StudioCatalog | null;
  productionId: string;
  onChange: (ep: PlannedEpisode) => void;
  onRemove: () => void;
  onMerge: () => void;
  isFirst: boolean;
}

function EpisodeCard({ ep, targetSeconds, catalog, productionId, onChange, onRemove, onMerge, isFirst }: EpisodeCardProps) {
  const { t } = useTranslation();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const assetMap = new Map<string, CatalogAsset>(catalog?.assets.map((a) => [a.asset_id, a]) ?? []);

  const actualSeconds = ep.items.reduce((sum, item) => {
    const a = assetMap.get(item.asset_id);
    return sum + (a?.duration_s ?? 0);
  }, 0);

  const deviation = targetSeconds > 0 ? Math.abs(actualSeconds - targetSeconds) / targetSeconds : 0;
  const durationWarning = deviation > EPISODE_DURATION_TOLERANCE;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIdx = ep.items.findIndex((item) => item.asset_id === active.id);
      const newIdx = ep.items.findIndex((item) => item.asset_id === over.id);
      if (oldIdx !== -1 && newIdx !== -1) {
        onChange({ ...ep, items: arrayMove(ep.items, oldIdx, newIdx) });
      }
    }
  };

  const removeItem = useCallback((assetId: string) => {
    onChange({ ...ep, items: ep.items.filter((i) => i.asset_id !== assetId) });
  }, [ep, onChange]);

  const updateSectionTitle = useCallback((assetId: string, v: string | null) => {
    onChange({ ...ep, items: ep.items.map((i) => i.asset_id === assetId ? { ...i, section_title: v } : i) });
  }, [ep, onChange]);

  const swapAlternate = useCallback((assetId: string, altId: string) => {
    onChange({
      ...ep,
      items: ep.items.map((i) => i.asset_id === assetId ? { ...i, asset_id: altId } : i),
      alternates: ep.alternates.filter((a) => a.asset_id !== altId),
    });
  }, [ep, onChange]);

  const completionPct = targetSeconds > 0 ? Math.min(100, (actualSeconds / targetSeconds) * 100) : 0;

  return (
    <>
      <Card
        size="small"
        title={
          <Space>
            <strong>{t("planEditor.episodeTitle", { idx: ep.idx })}</strong>
            <Text type="secondary" style={{ fontSize: 13 }}>{ep.title}</Text>
          </Space>
        }
        extra={
          <Space>
            {!isFirst && (
              <Tooltip title={t("planEditor.mergeEpisode")}>
                <Button size="small" icon={<ArrowLeftRight size={12} />} onClick={onMerge} />
              </Tooltip>
            )}
            <Popconfirm title={t("planEditor.removeEpisode")} onConfirm={onRemove}>
              <Button size="small" danger icon={<Trash2 size={12} />} />
            </Popconfirm>
          </Space>
        }
        style={{ marginBottom: 8 }}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>{ep.logline}</Text>
          <Space size={8}>
            <Text style={{ fontSize: 12 }}>{t("planEditor.targetDuration", { s: Math.round(targetSeconds) })}</Text>
            <Text style={{ fontSize: 12, color: durationWarning ? "#faad14" : undefined }}>
              {t("planEditor.actualDuration", { s: Math.round(actualSeconds) })}
              {durationWarning && <AlertTriangle size={12} style={{ marginLeft: 4, color: "#faad14" }} />}
            </Text>
          </Space>
          <Progress
            percent={Math.round(completionPct)}
            status={durationWarning ? "exception" : completionPct >= 100 ? "success" : "active"}
            size="small"
            showInfo={false}
          />
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={ep.items.map((i) => i.asset_id)}
              strategy={verticalListSortingStrategy}
            >
              {ep.items.map((item) => (
                <SortableItem
                  key={item.asset_id}
                  id={item.asset_id}
                  asset={assetMap.get(item.asset_id)}
                  item={item}
                  alternates={ep.alternates}
                  assetMap={assetMap}
                  onRemove={() => removeItem(item.asset_id)}
                  onSectionTitleChange={(v) => updateSectionTitle(item.asset_id, v)}
                  onSwapAlternate={(altId) => swapAlternate(item.asset_id, altId)}
                />
              ))}
            </SortableContext>
          </DndContext>
          <Button
            size="small"
            icon={<Plus size={12} />}
            style={{ marginTop: 4 }}
            onClick={() => setCatalogOpen(true)}
          >
            {t("planEditor.addVideo", { defaultValue: "Thêm video" })}
          </Button>
        </Space>
      </Card>
      <CatalogPickerModal
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        productionId={productionId}
        catalog={catalog}
        ep={ep}
        onChange={(updated) => {
          onChange(updated);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main PlanEditor
// ---------------------------------------------------------------------------
interface PlanEditorProps {
  productionId: string;
  plan: SeriesPlan;
  catalog: StudioCatalog | null;
  targetSeconds: number;
  readOnly?: boolean;
  onApproved?: () => void;
}

export function PlanEditor({ productionId, plan: initialPlan, catalog, targetSeconds, readOnly, onApproved }: PlanEditorProps) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [plan, setPlan] = useState<SeriesPlan>(initialPlan);
  const [checkerIssues, setCheckerIssues] = useState<string[]>([]);

  // Validate plan against schema
  const validate = useCallback((): boolean => {
    const result = SeriesPlanSchema.safeParse(plan);
    if (!result.success) {
      setCheckerIssues(result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`));
      return false;
    }
    setCheckerIssues([]);
    return true;
  }, [plan]);

  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!validate()) throw new Error("validation failed");
      return client.submitApprovePlan(productionId, plan);
    },
    onSuccess: () => {
      void message.success(t("planEditor.approveSuccess"));
      void qc.invalidateQueries({ queryKey: ["production", productionId] });
      onApproved?.();
    },
    onError: (err: unknown) => {
      setCheckerIssues(gateProblems(err));
      void message.error(t("planEditor.approveFailed"));
    },
  });

  const updateEpisode = (idx: number, ep: PlannedEpisode) => {
    setPlan((prev) => ({
      ...prev,
      episodes: prev.episodes.map((e, i) => (i === idx ? ep : e)),
    }));
  };

  const removeEpisode = (idx: number) => {
    setPlan((prev) => ({
      ...prev,
      episodes: prev.episodes.filter((_, i) => i !== idx).map((e, i) => ({ ...e, idx: i + 1 })),
    }));
  };

  const mergeEpisode = (idx: number) => {
    if (idx === 0) return;
    setPlan((prev) => {
      const merged = [...prev.episodes];
      const prev_ep = merged[idx - 1]!;
      const curr = merged[idx]!;
      merged[idx - 1] = {
        ...prev_ep,
        items: [...prev_ep.items, ...curr.items],
        alternates: [...prev_ep.alternates, ...curr.alternates],
      };
      return {
        ...prev,
        episodes: merged.filter((_, i) => i !== idx).map((e, i) => ({ ...e, idx: i + 1 })),
      };
    });
  };

  const addEpisode = () => {
    const newIdx = plan.episodes.length + 1;
    const newEp: PlannedEpisode = {
      idx: newIdx,
      title: `Tập ${newIdx}`,
      hook: "",
      logline: "",
      target_seconds: targetSeconds || 300,
      items: [],
      alternates: [],
      texts_suggested: [],
    };
    setPlan((prev) => ({ ...prev, episodes: [...prev.episodes, newEp] }));
  };

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small">
        <Text type="secondary">{plan.rationale}</Text>
        <br />
        <Text>{t("planEditor.episodeCount", { count: plan.episodes.length })}</Text>
      </Card>

      {checkerIssues.length > 0 && (
        <Alert
          type="error"
          message={t("planEditor.checkerTitle")}
          description={<ul>{checkerIssues.map((i, n) => <li key={n}>{i}</li>)}</ul>}
          showIcon
        />
      )}

      <Collapse
        size="small"
        items={plan.episodes.map((ep, idx) => ({
          key: String(ep.idx),
          label: (
            <Space>
              <strong>{t("planEditor.episodeTitle", { idx: ep.idx })}</strong>
              <Text type="secondary">{ep.title}</Text>
              <Tag>{ep.items.length} clips</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>~{Math.round(ep.target_seconds)}s</Text>
            </Space>
          ),
          children: (
            <EpisodeCard
              ep={ep}
              targetSeconds={targetSeconds || ep.target_seconds}
              catalog={catalog}
              productionId={productionId}
              onChange={(updated) => updateEpisode(idx, updated)}
              onRemove={() => removeEpisode(idx)}
              onMerge={() => mergeEpisode(idx)}
              isFirst={idx === 0}
            />
          ),
        }))}
      />

      {!readOnly && (
        <Space>
          <Button
            icon={<PlusCircle size={14} />}
            onClick={addEpisode}
          >
            {t("planEditor.addEpisode", { defaultValue: "Thêm tập" })}
          </Button>
          <Button
            icon={<CheckCircle size={14} />}
            onClick={() => validate()}
          >
            {t("planEditor.checkerTitle")}
          </Button>
          <Popconfirm
            title={t("planEditor.approveConfirm")}
            onConfirm={() => void approveMutation.mutate()}
          >
            <Button
              type="primary"
              loading={approveMutation.isPending}
              icon={<CheckCircle size={14} />}
            >
              {t("planEditor.approve")}
            </Button>
          </Popconfirm>
        </Space>
      )}
    </Space>
  );
}
