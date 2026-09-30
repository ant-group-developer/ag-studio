import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { Alert, Spin } from "antd";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LoginScreen } from "./login-screen";

interface AuthProviderProps {
  children: ReactNode;
}

const domain = import.meta.env.VITE_AUTH0_DOMAIN as string | undefined;
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID as string | undefined;
const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined;

export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation();

  if (!domain || !clientId || !audience) {
    return (
      <Alert
        type="error"
        showIcon
        message={t("auth.missingConfig")}
        description={t("auth.missingConfigDesc")}
        style={{ maxWidth: 640, margin: "15vh auto" }}
      />
    );
  }

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      // Giữ phiên qua lần tải lại trang: localhost khác site với Auth0 nên đăng nhập ngầm bằng
      // iframe bị chặn cookie bên thứ ba.
      cacheLocation="localstorage"
      useRefreshTokens
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience,
      }}
    >
      {children}
    </Auth0Provider>
  );
}

/** Chưa đăng nhập thì hiện màn bắt đầu; đã đăng nhập thì vào ứng dụng. */
export function AuthGate({ children }: AuthProviderProps) {
  const { t } = useTranslation();
  const { isLoading, isAuthenticated, loginWithRedirect } = useAuth0();

  if (isLoading) {
    return <Spin fullscreen tip={t("auth.authenticating")} />;
  }
  if (!isAuthenticated) {
    return <LoginScreen onLogin={() => void loginWithRedirect()} />;
  }
  return <>{children}</>;
}
