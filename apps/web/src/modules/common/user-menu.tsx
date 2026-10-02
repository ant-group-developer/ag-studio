import { Avatar, Flex, Popconfirm, Typography, theme as antdTheme } from "antd";
import { Globe, LogOut, Palette } from "lucide-react";
import type { MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import { APP_LANGUAGES, changeLanguage, currentLanguage, LANGUAGE_NAMES } from "../../i18n/language";

interface UserMenuOptions {
  nickname: string;
  email: string;
  avatarUrl?: string;
  initials: string;
  onLogout: () => void;
  /** Canva connection (hidden entirely when the integration is off). */
  canvaEnabled?: boolean;
  canvaConnected?: boolean;
  canvaDisplayName?: string | null;
  onConnectCanva?: () => void;
  onDisconnectCanva?: () => void;
}

/** Menu avatar giống ag-go-web: thẻ người dùng, chọn ngôn ngữ, Canva, đăng xuất. */
export function useUserMenu({
  nickname,
  email,
  avatarUrl,
  initials,
  onLogout,
  canvaEnabled,
  canvaConnected,
  canvaDisplayName,
  onConnectCanva,
  onDisconnectCanva,
}: UserMenuOptions): MenuProps {
  const { t } = useTranslation();
  const { token } = antdTheme.useToken();
  const language = currentLanguage();

  return {
    // Chỉ các mục ngôn ngữ chọn được; mục đang chọn là ngôn ngữ hiện tại.
    selectable: true,
    selectedKeys: [`language:${language}`],
    items: [
      {
        key: "user",
        label: (
          <Flex gap={12} align="center">
            <Avatar src={avatarUrl || undefined} size={40} style={{ backgroundColor: token.colorPrimary, flexShrink: 0 }}>
              {initials}
            </Avatar>
            <Flex vertical style={{ minWidth: 0 }}>
              <Typography.Text strong ellipsis>
                {nickname}
              </Typography.Text>
              <Typography.Text type="secondary" ellipsis>
                {email}
              </Typography.Text>
            </Flex>
          </Flex>
        ),
        disabled: true,
      },
      { type: "divider" },
      {
        key: "language",
        icon: <Globe size={14} />,
        label: `${t("common.language")}: ${LANGUAGE_NAMES[language]}`,
        children: APP_LANGUAGES.map((key) => ({
          key: `language:${key}`,
          label: LANGUAGE_NAMES[key],
          onClick: () => void changeLanguage(key),
        })),
      },
      ...(canvaEnabled
        ? [
            canvaConnected
              ? {
                  key: "canva",
                  icon: <Palette size={14} />,
                  label: (
                    <Popconfirm title={t("canva.disconnectConfirm")} onConfirm={onDisconnectCanva}>
                      <span>{t("canva.menuDisconnect", { name: canvaDisplayName ?? "" })}</span>
                    </Popconfirm>
                  ),
                }
              : {
                  key: "canva",
                  icon: <Palette size={14} />,
                  label: t("canva.menuConnect"),
                  onClick: onConnectCanva,
                },
          ]
        : []),
      {
        key: "logout",
        icon: <LogOut size={14} />,
        label: t("app.logout"),
        onClick: onLogout,
        danger: true,
      },
    ],
  };
}
