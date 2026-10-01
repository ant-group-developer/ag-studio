/**
 * Call log of a production: every Claude call (prompt, answer, what the deterministic check said) and every human
 * edit of a model answer. Both pages come from the API's call log (migration 0013); while the plan or an episode
 * runs, the lists refresh on their own.
 */
import { useState } from "react";
import { Alert, App as AntApp, Button, Col, Drawer, Empty, Row, Spin, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { Copy, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  StudioHttpError, useStudioClient,
  type HumanEditView, type LlmCallOutcome, type LlmCallSummary,
} from "../../api/studio-client";
import { EnumText } from "../../helpers/enum-label";

const OUTCOME_COLOR: Record<LlmCallOutcome, string> = { accepted: "success", rejected: "warning", failed: "error", rate_limited: "gold" };
const PAGE_SIZE = 20;

const preStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, maxHeight: "65vh", overflow: "auto",
  background: "var(--ant-color-fill-quaternary, #fafafa)", padding: 12, borderRadius: 6, margin: 0,
};

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  return (
    <Tooltip title={t("llmLog.copy")}>
      <Button size="small" type="text" icon={<Copy size={14} />} aria-label={t("llmLog.copy")}
        onClick={() => void navigator.clipboard.writeText(text).then(() => message.success(t("common.copied")), () => {})} />
    </Tooltip>
  );
}

function Block({ text, empty }: { text: string; empty: string }) {
  if (!text) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return (
    <div>
      <div style={{ textAlign: "right" }}><CopyButton text={text} /></div>
      <pre style={preStyle}>{text}</pre>
    </div>
  );
}

function CallDrawer({ productionId, callId, onClose }: { productionId: string; callId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["llm-call", productionId, callId],
    queryFn: () => client.getLlmCall(productionId, callId!),
    enabled: !!callId,
  });
  const problems = [...(data?.problems ?? []), ...(data?.warnings ?? [])];
  return (
    <Drawer open={!!callId} onClose={onClose} width="min(960px, 100vw)" title={t("llmLog.callTitle")} destroyOnClose>
      {isLoading && <Spin />}
      {error && <Alert type="error" message={error instanceof Error ? error.message : String(error)} showIcon />}
      {data && (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            <EnumText group="stage" code={data.stageKey} /> · {data.model} · {t("llmLog.round")} {data.round + 1}
            {" · "}<Tag color={OUTCOME_COLOR[data.outcome]}><EnumText group="llmOutcome" code={data.outcome} /></Tag>
          </Typography.Paragraph>
          {!data.hasPayload && <Alert type="warning" message={t("llmLog.noPayload")} showIcon style={{ marginBottom: 12 }} />}
          <Tabs
            items={[
              { key: "prompt", label: t("llmLog.tabPrompt"), children: <Block text={data.prompt ?? ""} empty={t("llmLog.noPayload")} /> },
              { key: "answer", label: t("llmLog.tabAnswer"), children: <Block text={pretty(data.structuredOutput)} empty={t("llmLog.noPayload")} /> },
              {
                key: "problems", label: `${t("llmLog.tabProblems")} (${problems.length})`,
                children: problems.length === 0
                  ? <Typography.Text type="secondary">{t("llmLog.noProblems")}</Typography.Text>
                  : <ul style={{ paddingLeft: 18 }}>{problems.map((p, i) => <li key={i}><Typography.Text code>{p.code}</Typography.Text> {p.message}</li>)}</ul>,
              },
              { key: "raw", label: t("llmLog.tabRaw"), children: <Block text={data.response ?? ""} empty={t("llmLog.noPayload")} /> },
            ]}
          />
        </>
      )}
    </Drawer>
  );
}

function EditDrawer({ edit, onClose }: { edit: HumanEditView | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Drawer open={!!edit} onClose={onClose} width="min(1200px, 100vw)" title={edit ? <EnumText group="humanEdit" code={edit.kind} /> : null} destroyOnClose>
      {edit && (
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Typography.Title level={5}>{t("llmLog.before")}</Typography.Title>
            <Block text={pretty(edit.before)} empty="—" />
          </Col>
          <Col xs={24} md={12}>
            <Typography.Title level={5}>{t("llmLog.after")}</Typography.Title>
            <Block text={pretty(edit.after)} empty="—" />
          </Col>
        </Row>
      )}
    </Drawer>
  );
}

export function LlmLogPanel({ productionId, live }: { productionId: string; live: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useStudioClient();
  const [callsPage, setCallsPage] = useState(1);
  const [editsPage, setEditsPage] = useState(1);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const [openEdit, setOpenEdit] = useState<HumanEditView | null>(null);
  const refetchInterval = live ? 15_000 : false;

  const calls = useQuery({
    queryKey: ["llm-calls", productionId, callsPage],
    queryFn: () => client.listLlmCalls(productionId, { page: callsPage, pageSize: PAGE_SIZE }),
    refetchInterval,
    retry: (n, e) => !(e instanceof StudioHttpError && e.status === 403) && n < 2,
  });
  const edits = useQuery({
    queryKey: ["human-edits", productionId, editsPage],
    queryFn: () => client.listHumanEdits(productionId, { page: editsPage, pageSize: PAGE_SIZE }),
    refetchInterval,
    retry: (n, e) => !(e instanceof StudioHttpError && e.status === 403) && n < 2,
  });

  if (calls.error instanceof StudioHttpError && calls.error.status === 403) {
    return <Alert type="info" message={t("llmLog.forbidden")} showIcon />;
  }

  const time = (iso: string) => new Date(iso).toLocaleString(i18n.language);
  const episode = (idx: number | null) => (idx === null ? "—" : `#${idx}`);

  const callColumns: ColumnsType<LlmCallSummary> = [
    { title: t("llmLog.time"), dataIndex: "createdAt", width: 170, render: time },
    { title: t("llmLog.stage"), dataIndex: "stageKey", ellipsis: true, render: (v: string) => <EnumText group="stage" code={v} /> },
    { title: t("llmLog.episode"), dataIndex: "episodeIdx", width: 70, render: episode },
    { title: t("llmLog.model"), dataIndex: "model", ellipsis: true, render: (v: string) => <Typography.Text style={{ fontSize: 12 }} code>{v}</Typography.Text> },
    { title: t("llmLog.round"), dataIndex: "round", width: 80, render: (r: number) => (r === 0 ? "1" : `${r + 1} (${t("llmLog.roundRepair")})`) },
    {
      title: t("llmLog.outcome"), dataIndex: "outcome", width: 150,
      render: (o: LlmCallOutcome, row) => (
        <Tooltip title={row.problems.map((p) => `[${p.code}] ${p.message}`).join("\n") || undefined}>
          <Tag color={OUTCOME_COLOR[o]}><EnumText group="llmOutcome" code={o} /></Tag>
        </Tooltip>
      ),
    },
    { title: t("llmLog.tokens"), width: 140, render: (_, r) => `${r.inputTokens?.toLocaleString(i18n.language) ?? "—"} / ${r.outputTokens?.toLocaleString(i18n.language) ?? "—"}` },
    { title: t("llmLog.cost"), dataIndex: "costUsd", width: 120, render: (c: number) => `$${c.toFixed(4)}` },
    { title: t("llmLog.duration"), dataIndex: "wallSeconds", width: 110, render: (s: number) => `${s.toFixed(1)} s` },
    {
      key: "view", width: 56, fixed: "right",
      render: (_, r) => (
        <Tooltip title={t("llmLog.view")}>
          <Button size="small" type="text" icon={<Eye size={14} />} aria-label={t("llmLog.view")} onClick={() => setOpenCall(r.id)} />
        </Tooltip>
      ),
    },
  ];

  const editColumns: ColumnsType<HumanEditView> = [
    { title: t("llmLog.time"), dataIndex: "createdAt", width: 170, render: time },
    { title: t("llmLog.kind"), dataIndex: "kind", render: (k: string) => <EnumText group="humanEdit" code={k} /> },
    { title: t("llmLog.episode"), dataIndex: "episodeIdx", width: 70, render: episode },
    { title: t("llmLog.user"), dataIndex: "userId", ellipsis: true },
    {
      title: t("llmLog.changed"), dataIndex: "changed", width: 120,
      render: (c: boolean) => <Tag color={c ? "processing" : "default"}>{c ? t("llmLog.changed") : t("llmLog.unchanged")}</Tag>,
    },
    {
      key: "view", width: 56,
      render: (_, r) => (r.before !== null || r.after !== null ? (
        <Tooltip title={t("llmLog.view")}>
          <Button size="small" type="text" icon={<Eye size={14} />} aria-label={t("llmLog.view")} onClick={() => setOpenEdit(r)} />
        </Tooltip>
      ) : null),
    },
  ];

  return (
    <>
      <Tabs
        items={[
          {
            key: "calls", label: `${t("llmLog.tabCalls")} (${calls.data?.total ?? 0})`,
            children: (
              <Table<LlmCallSummary>
                size="small" rowKey="id" columns={callColumns} dataSource={calls.data?.items ?? []} loading={calls.isLoading}
                scroll={{ x: 1100 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("llmLog.empty")} /> }}
                pagination={{ current: callsPage, pageSize: PAGE_SIZE, total: calls.data?.total ?? 0, onChange: setCallsPage, showSizeChanger: false, hideOnSinglePage: true }}
              />
            ),
          },
          {
            key: "edits", label: `${t("llmLog.tabEdits")} (${edits.data?.total ?? 0})`,
            children: (
              <Table<HumanEditView>
                size="small" rowKey="id" columns={editColumns} dataSource={edits.data?.items ?? []} loading={edits.isLoading}
                scroll={{ x: 700 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("llmLog.emptyEdits")} /> }}
                pagination={{ current: editsPage, pageSize: PAGE_SIZE, total: edits.data?.total ?? 0, onChange: setEditsPage, showSizeChanger: false, hideOnSinglePage: true }}
              />
            ),
          },
        ]}
      />
      <CallDrawer productionId={productionId} callId={openCall} onClose={() => setOpenCall(null)} />
      <EditDrawer edit={openEdit} onClose={() => setOpenEdit(null)} />
    </>
  );
}
