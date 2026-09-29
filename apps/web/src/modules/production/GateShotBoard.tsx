import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Space, Spin, Tag, Typography } from "antd";
import type { Selection, StudioCatalog } from "@harness/contracts";
import { useStudioClient } from "../../api/studio-client";
import { useSegmentMedia } from "../common/use-segment-media";
import { SegmentPreviewCard } from "../common/SegmentPreviewCard";
import { GateRejectionAlert } from "./GateRejectionAlert";

const { Text, Title } = Typography;

type SelectionBeat = Selection["beats"][number];

function swapPick(beat: SelectionBeat, pickIndex: number, altSegmentId: string): SelectionBeat {
  const oldPick = beat.picks[pickIndex];
  const alt = beat.alternates.find((a) => a.segment_id === altSegmentId);
  if (!alt || !oldPick) return beat;
  const picks = beat.picks.slice();
  picks[pickIndex] = alt;
  const alternates = beat.alternates.filter((a) => a.segment_id !== altSegmentId);
  alternates.unshift({ segment_id: oldPick.segment_id, reason: oldPick.reason });
  return { ...beat, picks, alternates };
}

export function GateShotBoard({ productionId }: { productionId: string }) {
  const client = useStudioClient();
  const queryClient = useQueryClient();
  const media = useSegmentMedia();

  const selectionQuery = useQuery({
    queryKey: ["stage-document", productionId, "select-shots"],
    queryFn: () => client.getStageDocument<Selection>(productionId, "select-shots", "selection.json"),
  });
  const catalogQuery = useQuery({
    queryKey: ["stage-document", productionId, "catalog"],
    queryFn: () => client.getStageDocument<StudioCatalog>(productionId, "catalog", "catalog.json"),
  });

  const [beats, setBeats] = useState<SelectionBeat[]>([]);
  const [selectedPick, setSelectedPick] = useState<Record<string, number>>({});
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (selectionQuery.data && loadedFor !== productionId) {
      setBeats(selectionQuery.data.beats);
      setLoadedFor(productionId);
    }
  }, [selectionQuery.data, loadedFor, productionId]);

  const captionOf = (segmentId: string): string =>
    catalogQuery.data?.segments.find((s) => s.id === segmentId)?.caption_vi ?? segmentId;

  const submitMutation = useMutation({
    mutationFn: () => {
      const document: Selection = { schema_version: "studio.selection/v1", beats };
      return client.submitGate(productionId, "shot-board", document);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["run", productionId] }),
  });

  if (selectionQuery.isLoading || catalogQuery.isLoading) {
    return (
      <Card title="Duyệt shot board">
        <Spin />
      </Card>
    );
  }
  if (selectionQuery.isError || catalogQuery.isError || !selectionQuery.data) {
    return (
      <Card title="Duyệt shot board">
        <Alert type="error" message="Không tải được shot board" />
      </Card>
    );
  }

  return (
    <Card title="Duyệt shot board">
      <Space direction="vertical" style={{ width: "100%" }} size={20}>
        {beats.map((beat) => {
          const active = selectedPick[beat.beat_id] ?? 0;
          return (
            <div key={beat.beat_id}>
              <Title level={5}>Beat {beat.beat_id}</Title>
              <Text type="secondary">Đang chọn</Text>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4, marginBottom: 12 }}>
                {beat.picks.map((pick, i) => (
                  <SegmentPreviewCard
                    key={pick.segment_id}
                    segmentId={pick.segment_id}
                    caption={captionOf(pick.segment_id)}
                    media={media}
                    eager
                    selected={i === active}
                    onClick={() => setSelectedPick((s) => ({ ...s, [beat.beat_id]: i }))}
                  />
                ))}
              </div>
              {beat.alternates.length > 0 && (
                <>
                  <Text type="secondary">Phương án thay thế — bấm để đổi vào ô đang chọn</Text>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                    {beat.alternates.map((alt) => (
                      <SegmentPreviewCard
                        key={alt.segment_id}
                        segmentId={alt.segment_id}
                        caption={captionOf(alt.segment_id)}
                        media={media}
                        width={120}
                        onClick={() =>
                          setBeats((bs) =>
                            bs.map((b) =>
                              b.beat_id === beat.beat_id ? swapPick(b, active, alt.segment_id) : b
                            )
                          )
                        }
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}

        {submitMutation.isError && <GateRejectionAlert error={submitMutation.error} />}

        <Space>
          <Button type="primary" loading={submitMutation.isPending} onClick={() => submitMutation.mutate()}>
            Duyệt shot board
          </Button>
          {catalogQuery.data?.truncated && <Tag color="orange">Danh mục đã bị cắt bớt</Tag>}
        </Space>
      </Space>
    </Card>
  );
}
