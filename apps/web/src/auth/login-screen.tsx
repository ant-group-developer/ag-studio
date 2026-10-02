import { Button, Typography } from "antd";
import { ArrowRight, ShieldCheck, Users } from "lucide-react";
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
          <Logo size={64} />
          <div className="login-hero-copy">
            <Title className="login-hero-title">{siteName}</Title>
            <Text className="login-hero-description">{t("auth.tagline")}</Text>
          </div>
          <ul className="login-hero-points">
            <li>
              <ShieldCheck size={16} />
              <span>{t("auth.pointSecure")}</span>
            </li>
            <li>
              <Users size={16} />
              <span>{t("auth.pointInternal")}</span>
            </li>
          </ul>
        </section>

        <section className="login-card" aria-labelledby="login-card-title">
          <div className="login-card-brand">
            <Logo size={44} />
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
            icon={<ArrowRight size={16} />}
            iconPosition="end"
          >
            {t("auth.login")}
          </Button>
          <Text className="login-card-note">
            <ShieldCheck size={14} style={{ verticalAlign: "middle", marginRight: 4 }} />
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

function Logo({ size }: { size: number }) {
  return <img className="login-logo" src="/favicon.png" alt="" style={{ height: size }} aria-hidden />;
}
