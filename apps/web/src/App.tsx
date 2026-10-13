import { lazy, Suspense } from "react";
import { App as AntApp, ConfigProvider, Spin } from "antd";
import enUS from "antd/locale/en_US";
import viVN from "antd/locale/vi_VN";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NuqsAdapter } from "nuqs/adapters/react-router";
import { AuthGate } from "./auth/auth-provider";
import { AssistantNameProvider, SiteNameProvider } from "./modules/common/assistant-name";
import type { AppLanguage } from "./i18n/language";

const TeamsPage = lazy(() => import("./pages/TeamsPage").then((m) => ({ default: m.TeamsPage })));
const TeamDetailPage = lazy(() => import("./pages/TeamDetailPage").then((m) => ({ default: m.TeamDetailPage })));
const QueuePage = lazy(() => import("./pages/QueuePage").then((m) => ({ default: m.QueuePage })));
const AuditPage = lazy(() => import("./pages/AuditPage").then((m) => ({ default: m.AuditPage })));
const StatsPage = lazy(() => import("./pages/StatsPage").then((m) => ({ default: m.StatsPage })));
const MusicLibraryPage = lazy(() => import("./pages/MusicLibraryPage").then((m) => ({ default: m.MusicLibraryPage })));
const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));
const ProjectPage = lazy(() => import("./pages/ProjectPage").then((m) => ({ default: m.ProjectPage })));
const GuidePage = lazy(() => import("./pages/GuidePage").then((m) => ({ default: m.GuidePage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })));

const ANTD_LOCALES: Record<AppLanguage, typeof viVN> = { vi: viVN, en: enUS };

export function App() {
  const { i18n } = useTranslation();
  const locale = ANTD_LOCALES[(i18n.language as AppLanguage) in ANTD_LOCALES ? (i18n.language as AppLanguage) : "vi"];
  return (
    <ConfigProvider locale={locale}>
      <AntApp>
        <SiteNameProvider>
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
                    <Route path="/audit" element={<AuditPage />} />
                    <Route path="/stats" element={<StatsPage />} />
                    <Route path="/music" element={<MusicLibraryPage />} />
                    <Route path="/teams" element={<TeamsPage />} />
                    <Route path="/teams/:teamId" element={<TeamDetailPage />} />
                    <Route path="/guide" element={<GuidePage />} />
                    <Route path="*" element={<NotFoundPage />} />
                  </Routes>
                </Suspense>
              </NuqsAdapter>
            </BrowserRouter>
          </AssistantNameProvider>
        </AuthGate>
        </SiteNameProvider>
      </AntApp>
    </ConfigProvider>
  );
}
