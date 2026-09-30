import { useQuery } from "@tanstack/react-query";
import { Alert, Card, List, Space, Spin, Tag, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../../api/studio-client";
import { EnumText } from "../../helpers/enum-label";

const { Text } = Typography;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExportsPanel({ productionId }: { productionId: string }) {
  const { t } = useTranslation();
  const client = useStudioClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["exports", productionId],
    queryFn: () => client.getExports(productionId),
  });

  if (isLoading) {
    return (
      <Card title={t("exports.title")}>
        <Spin />
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card title={t("exports.title")}>
        <Alert type="error" message={t("exports.loadFailed")} description={error instanceof Error ? error.message : String(error)} />
      </Card>
    );
  }

  return (
    <Card title={t("exports.title")}>
      <Space style={{ marginBottom: 12 }}>
        <Text>{t("exports.duration", { seconds: data.durationSeconds.toFixed(1) })}</Text>
        {data.watermarked && <Tag color="orange">{t("exports.watermarked")}</Tag>}
      </Space>
      <List
        dataSource={data.files}
        rowKey="name"
        renderItem={(file) => (
          <List.Item>
            <List.Item.Meta
              title={
                <Space>
                  <Tag><EnumText group="exportKind" code={file.kind} /></Tag>
                  <Text>{file.name}</Text>
                  <Text type="secondary">{formatSize(file.sizeBytes)}</Text>
                </Space>
              }
              description={
                file.urlHidden === "footage_scope" ? (
                  <Text type="warning">{t("exports.noFootageAccess")}</Text>
                ) : file.url ? (
                  <a href={file.url} target="_blank" rel="noreferrer">
                    <DownloadOutlined /> {t("exports.download")}
                  </a>
                ) : (
                  <Text type="secondary">{t("exports.noDownloadLink")}</Text>
                )
              }
            />
          </List.Item>
        )}
      />
    </Card>
  );
}
