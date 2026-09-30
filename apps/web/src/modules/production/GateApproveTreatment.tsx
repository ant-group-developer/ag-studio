import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Input, InputNumber, Space, Spin, Table, Typography } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import type { Treatment } from "@harness/contracts";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../../api/studio-client";
import { GateRejectionAlert } from "./GateRejectionAlert";
import { PAGE_TABLE_STICKY } from "../../helpers/sticky-table-header";

const { Text, Paragraph } = Typography;

type Beat = Treatment["beats"][number];

function nextBeatId(beats: Beat[]): string {
  const max = beats.reduce((m, b) => Math.max(m, Number(b.beat_id.slice(1)) || 0), 0);
  return `B${String(max + 1).padStart(2, "0")}`;
}

export function GateApproveTreatment({
  productionId,
  targetSeconds,
}: {
  productionId: string;
  targetSeconds: number | null;
}) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["stage-document", productionId, "treatment"],
    queryFn: () => client.getStageDocument<Treatment>(productionId, "treatment", "treatment.json"),
  });

  const [title, setTitle] = useState("");
  const [logline, setLogline] = useState("");
  const [beats, setBeats] = useState<Beat[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (data && loadedFor !== productionId) {
      setTitle(data.title);
      setLogline(data.logline);
      setBeats(data.beats);
      setLoadedFor(productionId);
    }
  }, [data, loadedFor, productionId]);

  const submitMutation = useMutation({
    mutationFn: () => {
      const document: Treatment = { schema_version: "studio.treatment/v1", title, logline, beats };
      return client.submitGate(productionId, "approve-treatment", document);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["run", productionId] });
    },
  });

  if (isLoading) {
    return (
      <Card title={t("treatment.title")}>
        <Spin />
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card title={t("treatment.title")}>
        <Alert type="error" message={t("treatment.loadFailed")} />
      </Card>
    );
  }

  const totalSeconds = beats.reduce((s, b) => s + (b.seconds || 0), 0);
  const withinTarget =
    targetSeconds === null || (totalSeconds >= targetSeconds * 0.9 && totalSeconds <= targetSeconds * 1.1);

  const updateBeat = (beatId: string, patch: Partial<Beat>) => {
    setBeats((bs) => bs.map((b) => (b.beat_id === beatId ? { ...b, ...patch } : b)));
  };

  return (
    <Card title={t("treatment.title")}>
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text>{t("treatment.fieldTitle")}</Text>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          <Text>{t("treatment.fieldLogline")}</Text>
          <Input.TextArea rows={2} value={logline} onChange={(e) => setLogline(e.target.value)} />
        </Space>

        <Table<Beat>
          dataSource={beats}
          rowKey="beat_id"
          pagination={false}
          sticky={PAGE_TABLE_STICKY}
          columns={[
            { title: t("treatment.columnBeat"), dataIndex: "beat_id", width: 70 },
            {
              title: t("treatment.columnPurpose"),
              dataIndex: "purpose",
              render: (v: string, r) => (
                <Input value={v} onChange={(e) => updateBeat(r.beat_id, { purpose: e.target.value })} />
              ),
            },
            {
              title: t("treatment.columnSeconds"),
              dataIndex: "seconds",
              width: 100,
              render: (v: number, r) => (
                <InputNumber
                  min={2}
                  max={600}
                  value={v}
                  onChange={(n) => updateBeat(r.beat_id, { seconds: n ?? 0 })}
                />
              ),
            },
            {
              title: t("treatment.columnVisualIdea"),
              dataIndex: "visual_idea",
              render: (v: string, r) => (
                <Input.TextArea
                  autoSize
                  value={v}
                  onChange={(e) => updateBeat(r.beat_id, { visual_idea: e.target.value })}
                />
              ),
            },
            {
              title: t("treatment.columnNarrationIdea"),
              dataIndex: "narration_idea",
              render: (v: string, r) => (
                <Input.TextArea
                  autoSize
                  value={v}
                  onChange={(e) => updateBeat(r.beat_id, { narration_idea: e.target.value })}
                />
              ),
            },
            {
              title: "",
              key: "actions",
              width: 48,
              render: (_, r) => (
                <Button
                  danger
                  size="small"
                  icon={<DeleteOutlined />}
                  disabled={beats.length <= 1}
                  onClick={() => setBeats((bs) => bs.filter((b) => b.beat_id !== r.beat_id))}
                />
              ),
            },
          ]}
        />

        <Button
          icon={<PlusOutlined />}
          onClick={() =>
            setBeats((bs) => [
              ...bs,
              { beat_id: nextBeatId(bs), purpose: "", seconds: 5, visual_idea: "", narration_idea: "" },
            ])
          }
        >
          {t("treatment.addBeat")}
        </Button>

        <Paragraph>
          {t("treatment.totalDuration")} <Text strong>{totalSeconds}s</Text>
          {targetSeconds !== null && (
            <>
              {" "}
              {t("treatment.targetSuffix", { seconds: targetSeconds })}{" "}
              {!withinTarget && <Text type="warning">{t("treatment.outsideTarget")}</Text>}
            </>
          )}
        </Paragraph>

        {submitMutation.isError && <GateRejectionAlert error={submitMutation.error} />}

        <Button type="primary" loading={submitMutation.isPending} onClick={() => submitMutation.mutate()}>
          {t("treatment.approve")}
        </Button>
      </Space>
    </Card>
  );
}
