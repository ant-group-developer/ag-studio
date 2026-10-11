import { Checkbox, Radio, Select, Space } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useAiTranslation } from "../common/assistant-name";
import { useWorkspaceClient, type Learning } from "../../api/workspace-client";

/**
 * What a new chat (or video) learns from earlier chats of the project (spec agent-workspace §4): the project's
 * lessons or not, and earlier threads to read, each as its summary or its whole history.
 */
export function LearningPicker({ projectId, value, onChange, exclude }: {
  projectId: string;
  value: Learning;
  onChange: (v: Learning) => void;
  exclude?: string | undefined;
}) {
  const { t } = useAiTranslation();
  const client = useWorkspaceClient();
  const { data } = useQuery({ queryKey: ["threads", projectId], queryFn: () => client.listThreads(projectId) });
  const options = (data?.threads ?? []).filter((x) => x.id !== exclude && (x.messageCount ?? 0) > 0)
    .map((x) => ({ value: x.id, label: `${x.kind === "video" ? t("ws.learning.videoPrefix") : ""}${x.title}` }));
  const mode = value.threads[0]?.mode ?? "summary";
  return (
    <div className="ws-learning">
      <Checkbox checked={value.useLessons} onChange={(e) => onChange({ ...value, useLessons: e.target.checked })}>
        {t("ws.learning.lessons")}
      </Checkbox>
      <div className="ws-learning__threads">
        <label>{t("ws.learning.threads")}</label>
        <Select
          mode="multiple" allowClear style={{ width: "100%" }} placeholder={t("ws.learning.threadsPlaceholder")} options={options}
          value={value.threads.map((r) => r.threadId)} optionFilterProp="label"
          onChange={(ids: string[]) => onChange({ ...value, threads: ids.map((id) => ({ threadId: id, mode })) })}
          notFoundContent={t("ws.learning.noThreads")}
        />
        {value.threads.length ? (
          <Radio.Group value={mode} onChange={(e) => onChange({ ...value, threads: value.threads.map((r) => ({ ...r, mode: e.target.value as "summary" | "full" })) })}>
            <Space direction="vertical" size={2}>
              <Radio value="summary">{t("ws.learning.summary")}</Radio>
              <Radio value="full">{t("ws.learning.full")}</Radio>
            </Space>
          </Radio.Group>
        ) : null}
      </div>
    </div>
  );
}

export const DEFAULT_LEARNING: Learning = { useLessons: true, threads: [] };
