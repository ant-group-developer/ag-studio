import { Button, Tooltip } from "antd";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

type Props = { onRefresh: () => void; refreshing?: boolean; size?: "small" | "middle" | "large" };

export function TableRefreshButton({ onRefresh, refreshing, size }: Props) {
  const { t } = useTranslation();
  return (
    <Tooltip title={t("common.refresh")}>
      <Button
        aria-label={t("common.refresh")}
        icon={<RefreshCw size={size === "small" ? 14 : 16} />}
        loading={refreshing}
        size={size}
        onClick={onRefresh}
      />
    </Tooltip>
  );
}
