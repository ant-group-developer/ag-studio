import { Button, Result } from "antd";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Result
      status="404"
      title="404"
      subTitle={t("common.notFoundTitle")}
      extra={<Button type="primary" onClick={() => navigate("/")}>{t("common.backHome")}</Button>}
    />
  );
}
