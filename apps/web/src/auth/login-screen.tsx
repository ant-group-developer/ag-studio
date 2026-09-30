import { ArrowRightOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { LanguageSwitch } from "../modules/common/LanguageSwitch";

const { Title, Text } = Typography;

/** Màn chào trước khi đăng nhập, cùng bố cục với ag-go-web. */
export function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const { t } = useTranslation();
  const siteName = t("app.title");

  return (
    <div className="login-screen">
      <div className="login-backdrop" style={{ backgroundImage: 'url("/images/background-login-16x9.jpg")' }} />
      <div className="login-overlay" />
      <LanguageSwitch className="login-language" />

      <div className="login-layout">
        <section className="login-hero">
          <Monogram name={siteName} size={64} />
          <div className="login-hero-copy">
            <Title className="login-hero-title">{siteName}</Title>
            <Text className="login-hero-description">{t("auth.tagline")}</Text>
          </div>
          <ul className="login-hero-points">
            <li>
              <SafetyCertificateOutlined />
              <span>{t("auth.pointSecure")}</span>
            </li>
            <li>
              <TeamOutlined />
              <span>{t("auth.pointInternal")}</span>
            </li>
          </ul>
        </section>

        <section className="login-card" aria-labelledby="login-card-title">
          <div className="login-card-brand">
            <Monogram name={siteName} size={44} />
            <span className="login-card-brand-name">{siteName}</span>
          </div>
          <Title level={3} id="login-card-title" className="login-card-title">
            {t("auth.welcome")}
          </Title>
          <Text className="login-card-subtitle">{t("auth.loginPrompt")}</Text>
          <Button
            type="primary"
            size="large"
            block
            className="login-button"
            onClick={onLogin}
            icon={<ArrowRightOutlined />}
            iconPosition="end"
          >
            {t("auth.login")}
          </Button>
          <Text className="login-card-note">
            <SafetyCertificateOutlined />
            {t("auth.secureNote")}
          </Text>
        </section>
      </div>

      <footer className="login-footer">
        <span>
          © {new Date().getFullYear()} {siteName}
        </span>
      </footer>
    </div>
  );
}

function Monogram({ name, size }: { name: string; size: number }) {
  const words = name.split(/\s+/).filter(Boolean);
  const initials = words.length >= 2 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2);
  return (
    <span className="login-monogram" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden>
      {initials.toUpperCase()}
    </span>
  );
}
