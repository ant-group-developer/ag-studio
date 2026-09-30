import { useNavigate } from "react-router-dom";
import { Button, Card, Typography } from "antd";
import { EditOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

const { Paragraph } = Typography;

export function GateEdit({ productionId }: { productionId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Card title={t("gateEdit.title")}>
      <Paragraph>{t("gateEdit.description")}</Paragraph>
      <Button
        type="primary"
        icon={<EditOutlined />}
        onClick={() => navigate(`/productions/${productionId}/editor`)}
      >
        {t("gateEdit.open")}
      </Button>
    </Card>
  );
}
