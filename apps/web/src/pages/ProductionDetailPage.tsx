import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Descriptions, Tag, Typography } from "antd";
import { useStudioClient } from "../api/studio-client";
import { RunPanel } from "../modules/production/RunPanel";

const { Title } = Typography;

export function ProductionDetailPage() {
  const { productionId } = useParams<{ productionId: string }>();
  const client = useStudioClient();

  const { data: production, isLoading: loadingProduction } = useQuery({
    queryKey: ["production", productionId],
    queryFn: () => client.getProduction(productionId!),
    enabled: !!productionId,
  });

  const { data: access } = useQuery({
    queryKey: ["production-access", productionId],
    queryFn: () => client.checkProductionAccess(productionId!),
    enabled: !!productionId,
  });

  if (loadingProduction) {
    return <div>Đang tải...</div>;
  }

  if (!production || !productionId) {
    return <div>Không tìm thấy production.</div>;
  }

  return (
    <div>
      <Title level={3}>{production.title}</Title>

      {access && !access.hasAccess && (
        <Alert
          type="warning"
          message="Chế độ chỉ xem văn bản"
          description="Bạn không có quyền truy cập đầy đủ vào production này. Chỉ có thể xem văn bản."
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <Card style={{ marginBottom: 16 }}>
        <Descriptions bordered column={2}>
          <Descriptions.Item label="Tiêu đề">{production.title}</Descriptions.Item>
          <Descriptions.Item label="Trạng thái">
            <Tag>{production.status}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Chủ đề" span={2}>
            {production.brief || "—"}
          </Descriptions.Item>
          <Descriptions.Item label="Tỉ lệ khung hình">{production.aspect}</Descriptions.Item>
          <Descriptions.Item label="Thời lượng mục tiêu">
            {production.targetSeconds ? `${production.targetSeconds}s` : "—"}
          </Descriptions.Item>
          <Descriptions.Item label="Ngôn ngữ">{production.language}</Descriptions.Item>
          <Descriptions.Item label="Canvas">
            {production.canvas ? `${production.canvas.width} x ${production.canvas.height}` : "—"}
          </Descriptions.Item>
          <Descriptions.Item label="Nguồn" span={2}>
            {production.sources.join(", ") || "—"}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <RunPanel productionId={productionId} targetSeconds={production.targetSeconds} />
    </div>
  );
}
