import { TranslationOutlined } from "@ant-design/icons";
import { Button, Dropdown } from "antd";
import { useTranslation } from "react-i18next";
import {
  APP_LANGUAGES,
  type AppLanguage,
  changeLanguage,
  currentLanguage,
  LANGUAGE_NAMES,
} from "../../i18n/language";

/** Nút đổi Việt / Anh cho màn chưa đăng nhập (sau khi đăng nhập thì đổi trong menu người dùng). */
export function LanguageSwitch({ className }: { className?: string }) {
  const { t } = useTranslation();
  const language = currentLanguage();

  return (
    <Dropdown
      trigger={["click"]}
      placement="bottomRight"
      menu={{
        selectable: true,
        selectedKeys: [language],
        items: APP_LANGUAGES.map((key) => ({ key, label: LANGUAGE_NAMES[key] })),
        onClick: ({ key }) => void changeLanguage(key as AppLanguage),
      }}
    >
      <Button
        type="text"
        className={className}
        icon={<TranslationOutlined />}
        aria-label={t("common.language")}
        title={t("common.language")}
      >
        {language.toUpperCase()}
      </Button>
    </Dropdown>
  );
}
