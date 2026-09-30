import { ProLayout } from "@ant-design/pro-components";
import { useAuth0 } from "@auth0/auth0-react";
import { App as AntApp, ConfigProvider, Dropdown, theme as antdTheme } from "antd";
import enUS from "antd/locale/en_US";
import viVN from "antd/locale/vi_VN";
import { TeamOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useLocation,
} from "react-router-dom";
import { TeamsPage } from "./pages/TeamsPage";
import { TeamDetailPage } from "./pages/TeamDetailPage";
import { ProductionsPage } from "./pages/ProductionsPage";
import { ProductionDetailPage } from "./pages/ProductionDetailPage";
import { EditorPage } from "./modules/editor/EditorPage";
import { AuthGate } from "./auth/auth-provider";
import { useUserMenu } from "./modules/common/user-menu";
import { menuKeyFor } from "./helpers/menu";
import type { AppLanguage } from "./i18n/language";

const ANTD_LOCALES: Record<AppLanguage, typeof viVN> = {
  vi: viVN,
  en: enUS,
};

/** The editor route is a full-width workspace: no sider, no content padding. */
function isEditorRoute(pathname: string): boolean {
  return /^\/productions\/[^/]+\/editor$/.test(pathname);
}

function AppLayout() {
  const location = useLocation();
  const { t } = useTranslation();
  const { user, logout } = useAuth0();
  const { token } = antdTheme.useToken();

  const editorRoute = isEditorRoute(location.pathname);

  const userEmail = user?.email ?? "";
  const userInitials = userEmail.slice(0, 2).toUpperCase();
  const nickname = user?.name ?? userEmail;

  const handleLogout = () => {
    void logout({ logoutParams: { returnTo: window.location.origin } });
  };

  const avatarMenu = useUserMenu({
    nickname,
    email: userEmail,
    avatarUrl: user?.picture,
    initials: userInitials,
    onLogout: handleLogout,
  });

  const route = {
    path: "/",
    routes: [
      {
        path: "/productions",
        name: t("menu.productions"),
        icon: <VideoCameraOutlined />,
      },
      {
        path: "/teams",
        name: t("menu.teams"),
        icon: <TeamOutlined />,
      },
    ],
  };

  // A team's production list and every production page sit under "Production"; the team list and a
  // team's members under "Nhóm".
  const selectedKeys = [menuKeyFor(location.pathname)];

  return (
    <ProLayout
      title={t("app.title")}
      layout="mix"
      fixSiderbar
      fixedHeader
      location={{ pathname: editorRoute ? "/productions" : location.pathname }}
      route={route}
      selectedKeys={selectedKeys}
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom)}
      contentStyle={{ padding: editorRoute ? 0 : 24 }}
      menuRender={editorRoute ? () => null : undefined}
      avatarProps={{
        src: user?.picture,
        size: "small",
        style: { backgroundColor: token.colorPrimary },
        children: !user?.picture ? userInitials : undefined,
        title: <span style={{ fontSize: 14, fontWeight: 500 }}>{nickname}</span>,
        render: (_props, dom) => (
          <Dropdown menu={avatarMenu} trigger={["click"]} placement="bottomRight" className="user-dropdown">
            <span style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>{dom}</span>
          </Dropdown>
        ),
      }}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/productions" replace />} />
        <Route path="/productions" element={<ProductionsPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/teams/:teamId" element={<TeamDetailPage />} />
        <Route path="/teams/:teamId/productions" element={<ProductionsPage />} />
        <Route path="/productions/:productionId" element={<ProductionDetailPage />} />
        <Route path="/productions/:productionId/editor" element={<EditorPage />} />
      </Routes>
    </ProLayout>
  );
}

export function App() {
  const { i18n } = useTranslation();
  const locale = ANTD_LOCALES[(i18n.language as AppLanguage) in ANTD_LOCALES ? (i18n.language as AppLanguage) : "vi"];

  return (
    <ConfigProvider locale={locale}>
      <AntApp>
        <AuthGate>
          <BrowserRouter>
            <AppLayout />
          </BrowserRouter>
        </AuthGate>
      </AntApp>
    </ConfigProvider>
  );
}
