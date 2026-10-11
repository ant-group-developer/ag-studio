import { lazy, Suspense } from "react";
import { ProLayout } from "@ant-design/pro-components";
import { App as AntApp, ConfigProvider, Dropdown, Spin, theme as antdTheme } from "antd";
import enUS from "antd/locale/en_US";
import viVN from "antd/locale/vi_VN";
import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import { NuqsAdapter } from "nuqs/adapters/react-router";
import { AuthGate } from "./auth/auth-provider";
import { AssistantNameProvider } from "./modules/common/assistant-name";
import { useAppUserMenu } from "./modules/common/use-app-user-menu";
import type { AppLanguage } from "./i18n/language";

const TeamsPage = lazy(() => import("./pages/TeamsPage").then((m) => ({ default: m.TeamsPage })));
const TeamDetailPage = lazy(() => import("./pages/TeamDetailPage").then((m) => ({ default: m.TeamDetailPage })));
const QueuePage = lazy(() => import("./pages/QueuePage").then((m) => ({ default: m.QueuePage })));
const MusicLibraryPage = lazy(() => import("./pages/MusicLibraryPage").then((m) => ({ default: m.MusicLibraryPage })));
const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));
const ProjectPage = lazy(() => import("./pages/ProjectPage").then((m) => ({ default: m.ProjectPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })));

const ANTD_LOCALES: Record<AppLanguage, typeof viVN> = { vi: viVN, en: enUS };

/** The team screens (lists, members, skills) keep the admin layout; everything else is the workspace. */
function TeamLayout() {
  const location = useLocation();
  const { t } = useTranslation();
  const { token } = antdTheme.useToken();
  const { menu: avatarMenu, picture, initials: userInitials, nickname } = useAppUserMenu([
    { key: "projects", label: <Link to="/">{t("menu.backToProjects")}</Link> },
  ]);

  return (
    <ProLayout
      title={t("app.title")}
      logo="/favicon.png"
      layout="mix"
      fixSiderbar
      fixedHeader
      location={{ pathname: location.pathname }}
      route={{ path: "/", routes: [{ path: "/teams", name: t("menu.teams"), icon: <Users size={16} /> }] }}
      selectedKeys={["/teams"]}
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom)}
      contentStyle={{ padding: 24 }}
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
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/teams/:teamId" element={<TeamDetailPage />} />
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
          <AssistantNameProvider>
            <BrowserRouter>
              <NuqsAdapter>
                <Suspense fallback={<div style={{ display: "flex", justifyContent: "center", padding: 48 }}><Spin /></div>}>
                  <Routes>
                    <Route path="/" element={<HomePage />} />
                    <Route path="/t/:teamId" element={<ProjectsPage />} />
                    <Route path="/p/:projectId" element={<ProjectPage />} />
                    <Route path="/p/:projectId/c/:threadId" element={<ProjectPage />} />
                    <Route path="/p/:projectId/v/:videoId" element={<ProjectPage />} />
                    <Route path="/queue" element={<QueuePage />} />
                    <Route path="/music" element={<MusicLibraryPage />} />
                    <Route path="*" element={<TeamLayout />} />
                  </Routes>
                </Suspense>
              </NuqsAdapter>
            </BrowserRouter>
          </AssistantNameProvider>
        </AuthGate>
      </AntApp>
    </ConfigProvider>
  );
}
