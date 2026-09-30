import { Avatar, Flex, Typography } from "antd";
import { useTranslation } from "react-i18next";
import type { UserSummary } from "../../api/studio-client";

/** Avatar, name and email of a person, like ag-go-web's user cell; falls back to the raw user id. */
export function UserCell({ user, size = 32 }: { user: UserSummary; size?: number }) {
  const { t } = useTranslation();
  const name = user.name || user.email || t("teams.unknownUser");
  const secondary = user.email && user.email !== name ? user.email : !user.name && !user.email ? user.userId : null;
  return (
    <Flex align="center" gap={10} style={{ minWidth: 0 }}>
      <Avatar size={size} src={user.avatar || undefined} style={{ flexShrink: 0 }}>
        {name.charAt(0).toUpperCase()}
      </Avatar>
      <Flex vertical style={{ minWidth: 0 }}>
        <Typography.Text ellipsis={{ tooltip: name }}>{name}</Typography.Text>
        {secondary ? (
          <Typography.Text type="secondary" ellipsis={{ tooltip: secondary }} style={{ fontSize: 12 }}>
            {secondary}
          </Typography.Text>
        ) : null}
      </Flex>
    </Flex>
  );
}
