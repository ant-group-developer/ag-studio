import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Descriptions, Space, Tag, Typography } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { useAuth0 } from "@auth0/auth0-react";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../api/studio-client";
import { getFolders } from "../api/ag-go-client";
import { EnumText, PRODUCTION_STATUS_COLORS } from "../helpers/enum-label";
import { RunPanel } from "../modules/production/RunPanel";

const { Title } = Typography;

export function ProductionDetailPage() {
  const { t } = useTranslation();
  const { productionId } = useParams<{ productionId: string }>();
  const client = useStudioClient();
  const { getAccessTokenSilently } = useAuth0();

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

  // Source folders are stored as ag-go folder ids; their names come from ag-go (ids stay shown if that fails).
  const { data: folderData } = useQuery({
    queryKey: ["folders"],
    queryFn: async () => {
      const token = await getAccessTokenSilently();
      if (!token) throw new Error("No token");
      return getFolders(token);
    },
    enabled: !!production?.sources.length,
  });
  const folderNames = new Map(folderData?.folders.map((f) => [f.id, f.name]));

  if (loadingProduction) {
    return <div>{t("common.loading")}</div>;
  }

  if (!production || !productionId) {
    return <div>{t("productions.notFound")}</div>;
  }

  return (
    <div>
      <Link to={`/teams/${production.teamId}/productions`}>
        <ArrowLeftOutlined /> {t("productions.backToList")}
      </Link>
      <Title level={3} style={{ marginTop: 8 }}>{production.title}</Title>

      {access && !access.hasAccess && (
        <Alert
          type="warning"
          message={t("productions.viewOnlyTitle")}
          description={t("productions.viewOnlyDescription")}
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <Card style={{ marginBottom: 16 }}>
        <Descriptions bordered column={2}>
          <Descriptions.Item label={t("productions.detailFieldTitle")}>{production.title}</Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldStatus")}>
            <Tag color={PRODUCTION_STATUS_COLORS[production.status]}>
              <EnumText group="productionStatus" code={production.status} />
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldBrief")} span={2}>
            {production.brief || t("productions.empty")}
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldAspect")}>
            <EnumText group="aspect" code={production.aspect} />
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldTargetSeconds")}>
            {production.targetSeconds ? `${production.targetSeconds}s` : t("productions.empty")}
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldLanguage")}>
            <EnumText group="language" code={production.language} />
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldCanvas")}>
            {production.canvas ? `${production.canvas.width} x ${production.canvas.height}` : t("productions.empty")}
          </Descriptions.Item>
          <Descriptions.Item label={t("productions.detailFieldSources")} span={2}>
            {production.sources.length ? (
              <Space size={[4, 4]} wrap>
                {production.sources.map((id) => (
                  <Tag key={id} title={id}>{folderNames.get(id) ?? id}</Tag>
                ))}
              </Space>
            ) : (
              t("productions.empty")
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <RunPanel productionId={productionId} targetSeconds={production.targetSeconds} />
    </div>
  );
}
