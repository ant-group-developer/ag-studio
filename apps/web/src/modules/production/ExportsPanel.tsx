import { useQuery } from "@tanstack/react-query";
import { Alert, Card, List, Space, Spin, Tag, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { useStudioClient } from "../../api/studio-client";

const { Text } = Typography;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExportsPanel({ productionId }: { productionId: string }) {
  const client = useStudioClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["exports", productionId],
    queryFn: () => client.getExports(productionId),
  });

  if (isLoading) {
    return (
      <Card title="Xuất bản">
        <Spin />
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card title="Xuất bản">
        <Alert type="error" message="Không tải được danh sách xuất bản" description={error instanceof Error ? error.message : String(error)} />
      </Card>
    );
  }

  return (
    <Card title="Xuất bản">
      <Space style={{ marginBottom: 12 }}>
        <Text>Thời lượng: {data.durationSeconds.toFixed(1)}s</Text>
        {data.watermarked && <Tag color="orange">Có watermark</Tag>}
      </Space>
      <List
        dataSource={data.files}
        rowKey="name"
        renderItem={(file) => (
          <List.Item>
            <List.Item.Meta
              title={
                <Space>
                  <Tag>{file.kind}</Tag>
                  <Text>{file.name}</Text>
                  <Text type="secondary">{formatSize(file.sizeBytes)}</Text>
                </Space>
              }
              description={
                file.urlHidden === "footage_scope" ? (
                  <Text type="warning">Bạn không có quyền xem footage của production này</Text>
                ) : file.url ? (
                  <a href={file.url} target="_blank" rel="noreferrer">
                    <DownloadOutlined /> Tải xuống
                  </a>
                ) : (
                  <Text type="secondary">Chưa có liên kết tải xuống</Text>
                )
              }
            />
          </List.Item>
        )}
      />
    </Card>
  );
}
