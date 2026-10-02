import { lazy, Suspense, useEffect } from "react";
import { ProLayout } from "@ant-design/pro-components";
import { useAuth0 } from "@auth0/auth0-react";
import { App as AntApp, ConfigProvider, Dropdown, Spin, theme as antdTheme } from "antd";
import enUS from "antd/locale/en_US";
import viVN from "antd/locale/vi_VN";
import { Film, Users, LayoutList } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { NuqsAdapter } from "nuqs/adapters/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthGate } from "./auth/auth-provider";
import { useUserMenu } from "./modules/common/user-menu";
import { menuKeyFor } from "./helpers/menu";
import { useStudioClient } from "./api/studio-client";
import type { AppLanguage } from "./i18n/language";

const TeamsPage = lazy(() => import("./pages/TeamsPage").then((m) => ({ default: m.TeamsPage })));
const TeamDetailPage = lazy(() => import("./pages/TeamDetailPage").then((m) => ({ default: m.TeamDetailPage })));
const ProductionsPage = lazy(() => import("./pages/ProductionsPage").then((m) => ({ default: m.ProductionsPage })));
const AllProductionsPage = lazy(() => import("./pages/AllProductionsPage").then((m) => ({ default: m.AllProductionsPage })));
const ProductionDetailPage = lazy(() => import("./pages/ProductionDetailPage").then((m) => ({ default: m.ProductionDetailPage })));
const EditorPage = lazy(() => import("./modules/editor/EditorPage").then((m) => ({ default: m.EditorPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })));

const ANTD_LOCALES: Record<AppLanguage, typeof viVN> = { vi: viVN, en: enUS };

function isEditorRoute(pathname: string): boolean {
  return /^\/productions\/[^/]+\/episodes\/[^/]+\/editor$/.test(pathname);
}

function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { user, logout } = useAuth0();
  const { token } = antdTheme.useToken();
  const client = useStudioClient();
  const qc = useQueryClient();
  const editorRoute = isEditorRoute(location.pathname);

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => client.getMe(),
    staleTime: 5 * 60_000,
  });
  const isAdmin = me?.isAdmin ?? false;

  const { data: canva } = useQuery({
    queryKey: ["canva-connection"],
    queryFn: () => client.getCanvaConnection(),
  });
  const disconnectCanva = useMutation({
    mutationFn: () => client.disconnectCanva(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["canva-connection"] });
      void message.success(t("canva.disconnectDone"));
    },
  });
  const connectCanva = async () => {
    const returnTo = location.pathname + location.search;
    const { authorizeUrl } = await client.authorizeCanva(returnTo);
    window.location.href = authorizeUrl;
  };

  // The browser lands back here (`returnTo`) after a Canva OAuth round trip with `?canva=connected` or
  // `?canva=error&reason=...`: show a message once, then strip those params from the URL.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const outcome = params.get("canva");
    if (!outcome) return;
    if (outcome === "connected") {
      void qc.invalidateQueries({ queryKey: ["canva-connection"] });
      void message.success(t("canva.connectedMessage"));
    } else {
      void message.error(t("canva.errorMessage"));
    }
    params.delete("canva");
    params.delete("reason");
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "" }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const userEmail = user?.email ?? "";
  const userInitials = userEmail.slice(0, 2).toUpperCase();
  const nickname = user?.name ?? userEmail;
  const handleLogout = () => void logout({ logoutParams: { returnTo: window.location.origin } });
  const avatarMenu = useUserMenu({
    nickname,
    email: userEmail,
    avatarUrl: user?.picture,
    initials: userInitials,
    onLogout: handleLogout,
    canvaEnabled: canva?.enabled ?? false,
    canvaConnected: canva?.connected ?? false,
    canvaDisplayName: canva?.displayName ?? null,
    onConnectCanva: () => void connectCanva(),
    onDisconnectCanva: () => disconnectCanva.mutate(),
  });

  const sideRoutes = [
    { path: "/productions", name: t("menu.productions"), icon: <Film size={16} /> },
    ...(isAdmin ? [{ path: "/all-productions", name: t("menu.allProductions"), icon: <LayoutList size={16} /> }] : []),
    { path: "/teams", name: t("menu.teams"), icon: <Users size={16} /> },
  ];

  return (
    <ProLayout
      title={t("app.title")}
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
      <Suspense fallback={<div style={{ display: "flex", justifyContent: "center", padding: 48 }}><Spin /></div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/productions" replace />} />
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
              <AppLayout />
            </NuqsAdapter>
          </BrowserRouter>
        </AuthGate>
      </AntApp>
    </ConfigProvider>
  );
}
