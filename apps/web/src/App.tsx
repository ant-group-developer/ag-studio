import { lazy, Suspense } from "react";
import { ProLayout } from "@ant-design/pro-components";
import { App as AntApp, ConfigProvider, Dropdown, Spin, theme as antdTheme } from "antd";
import enUS from "antd/locale/en_US";
import viVN from "antd/locale/vi_VN";
import { Film, Users, LayoutList } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import { NuqsAdapter } from "nuqs/adapters/react-router";
import { AuthGate } from "./auth/auth-provider";
import { useAppUserMenu } from "./modules/common/use-app-user-menu";
import { menuKeyFor } from "./helpers/menu";
import type { AppLanguage } from "./i18n/language";

const TeamsPage = lazy(() => import("./pages/TeamsPage").then((m) => ({ default: m.TeamsPage })));
const TeamDetailPage = lazy(() => import("./pages/TeamDetailPage").then((m) => ({ default: m.TeamDetailPage })));
const ProductionsPage = lazy(() => import("./pages/ProductionsPage").then((m) => ({ default: m.ProductionsPage })));
const AllProductionsPage = lazy(() => import("./pages/AllProductionsPage").then((m) => ({ default: m.AllProductionsPage })));
const ProductionDetailPage = lazy(() => import("./pages/ProductionDetailPage").then((m) => ({ default: m.ProductionDetailPage })));
const EditorPage = lazy(() => import("./modules/editor/EditorPage").then((m) => ({ default: m.EditorPage })));
const ChatHomePage = lazy(() => import("./pages/ChatHomePage").then((m) => ({ default: m.ChatHomePage })));
const ChatProductionPage = lazy(() => import("./pages/ChatProductionPage").then((m) => ({ default: m.ChatProductionPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })));

const ANTD_LOCALES: Record<AppLanguage, typeof viVN> = { vi: viVN, en: enUS };

function isEditorRoute(pathname: string): boolean {
  return /^\/productions\/[^/]+\/episodes\/[^/]+\/editor$/.test(pathname);
}

function AppLayout() {
  const location = useLocation();
  const { t } = useTranslation();
  const { token } = antdTheme.useToken();
  const editorRoute = isEditorRoute(location.pathname);
  const { menu: avatarMenu, isAdmin, picture, initials: userInitials, nickname } = useAppUserMenu([
    { key: "chat-home", label: <Link to="/">{t("chat.backToChat")}</Link> },
  ]);

  const sideRoutes = [
    { path: "/productions", name: t("menu.productions"), icon: <Film size={16} /> },
    ...(isAdmin ? [{ path: "/all-productions", name: t("menu.allProductions"), icon: <LayoutList size={16} /> }] : []),
    { path: "/teams", name: t("menu.teams"), icon: <Users size={16} /> },
  ];

  return (
    <ProLayout
      title={t("app.title")}
      logo="/favicon.png"
      layout="mix"
      fixSiderbar
      fixedHeader
      location={{ pathname: editorRoute ? "/productions" : location.pathname }}
      route={{ path: "/", routes: sideRoutes }}
      selectedKeys={[menuKeyFor(location.pathname)]}
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom)}
      contentStyle={{ padding: editorRoute ? 0 : 24 }}
      menuRender={editorRoute ? () => null : undefined}
      avatarProps={{
        src: picture,
        size: "small",
        style: { backgroundColor: token.colorPrimary },
        children: !picture ? userInitials : undefined,
        title: <span style={{ fontSize: 14, fontWeight: 500 }}>{nickname}</span>,
        render: (_props, dom) => (
          <Dropdown menu={avatarMenu} trigger={["click"]} placement="bottomRight" className="user-dropdown">
            <span style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>{dom}</span>
          </Dropdown>
        ),
      }}
    >
      <Suspense fallback={<div style={{ display: "flex", justifyContent: "center", padding: 48 }}><Spin /></div>}>
        <Routes>
          <Route path="/productions" element={<ProductionsPage />} />
          <Route path="/all-productions" element={<AllProductionsPage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/teams/:teamId" element={<TeamDetailPage />} />
          <Route path="/teams/:teamId/productions" element={<ProductionsPage />} />
          <Route path="/productions/:productionId" element={<ProductionDetailPage />} />
          <Route path="/productions/:productionId/episodes/:episodeId/editor" element={<EditorPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
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
            <NuqsAdapter>
              <Suspense fallback={<div style={{ display: "flex", justifyContent: "center", padding: 48 }}><Spin /></div>}>
                <Routes>
                  <Route path="/" element={<ChatHomePage />} />
                  <Route path="/v/:productionId" element={<ChatProductionPage />} />
                  <Route path="/v/:productionId/e/:episodeId" element={<ChatProductionPage />} />
                  <Route path="*" element={<AppLayout />} />
                </Routes>
              </Suspense>
            </NuqsAdapter>
          </BrowserRouter>
        </AuthGate>
      </AntApp>
    </ConfigProvider>
  );
}
