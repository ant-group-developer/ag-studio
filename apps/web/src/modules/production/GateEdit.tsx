import { useNavigate } from "react-router-dom";
import { Button, Card, Typography } from "antd";
import { EditOutlined } from "@ant-design/icons";

const { Paragraph } = Typography;

export function GateEdit({ productionId }: { productionId: string }) {
  const navigate = useNavigate();
  return (
    <Card title="Chỉnh sửa video">
      <Paragraph>
        Dựng phim đã sẵn sàng để chỉnh sửa. Mở trình chỉnh sửa để xem trước, chỉnh timeline và hoàn tất.
      </Paragraph>
      <Button
        type="primary"
        icon={<EditOutlined />}
        onClick={() => navigate(`/productions/${productionId}/editor`)}
      >
        Mở editor
      </Button>
    </Card>
  );
}
