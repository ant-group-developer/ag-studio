import { ProLayout } from "@ant-design/pro-components";
import { useAuth0 } from "@auth0/auth0-react";
import { App as AntApp, ConfigProvider, Dropdown, Typography } from "antd";
import type { MenuProps } from "antd";
import enUS from "antd/locale/en_US";
import viVN from "antd/locale/vi_VN";
import { TeamOutlined, LogoutOutlined, GlobalOutlined } from "@ant-design/icons";
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
import { APP_LANGUAGES, LANGUAGE_NAMES, changeLanguage, currentLanguage } from "./i18n/language";
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
  const { t, i18n } = useTranslation();
  const { user, logout, isAuthenticated } = useAuth0();

  const editorRoute = isEditorRoute(location.pathname);

  const userEmail = user?.email ?? "";
  const userInitials = userEmail.slice(0, 2).toUpperCase();
  const nickname = user?.name ?? userEmail;

  const handleLogout = () => {
    void logout({ logoutParams: { returnTo: window.location.origin } });
  };

  const avatarMenu: MenuProps = {
    items: [
      {
        key: "user",
        label: (
          <div style={{ padding: "4px 0" }}>
            <Typography.Text strong>{nickname}</Typography.Text>
            <br />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {userEmail}
            </Typography.Text>
          </div>
        ),
        disabled: true,
      },
      { type: "divider" },
      {
        key: "logout",
        icon: <LogoutOutlined />,
        label: t("app.logout"),
        onClick: handleLogout,
        danger: true,
      },
    ],
  };

  const languageMenu: MenuProps = {
    selectedKeys: [currentLanguage()],
    items: APP_LANGUAGES.map((lang) => ({
      key: lang,
      label: LANGUAGE_NAMES[lang],
      onClick: () => void changeLanguage(lang),
    })),
  };

  const route = {
    path: "/",
    routes: [
      {
        path: "/teams",
        name: t("menu.teams"),
        icon: <TeamOutlined />,
      },
    ],
  };

  // Team- and production-scoped pages keep "Nhóm" highlighted in the sider even though their path
  // isn't literally under /teams.
  const selectedKeys = ["/teams"];

  return (
    <ProLayout
      title={t("app.title")}
      layout="mix"
      fixSiderbar
      fixedHeader
      location={{ pathname: editorRoute ? "/teams" : location.pathname }}
      route={route}
      selectedKeys={selectedKeys}
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom)}
      contentStyle={{ padding: editorRoute ? 0 : 24 }}
      menuRender={editorRoute ? () => null : undefined}
      avatarProps={
        isAuthenticated
          ? {
              src: user?.picture,
              size: "small",
              children: !user?.picture ? userInitials : undefined,
              title: <span style={{ fontSize: 14, fontWeight: 500 }}>{nickname}</span>,
              render: (_props, dom) => (
                <Dropdown menu={avatarMenu} trigger={["click"]} placement="bottomRight">
                  <span style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>{dom}</span>
                </Dropdown>
              ),
            }
          : undefined
      }
      actionsRender={() => [
        <Dropdown key="language" menu={languageMenu} trigger={["click"]} placement="bottomRight">
          <a onClick={(e) => e.preventDefault()} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <GlobalOutlined /> {LANGUAGE_NAMES[i18n.language as AppLanguage] ?? LANGUAGE_NAMES.vi}
          </a>
        </Dropdown>,
      ]}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/teams" replace />} />
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
        <BrowserRouter>
          <AppLayout />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}
