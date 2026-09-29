import { Layout, Menu } from "antd";
import { TeamOutlined, VideoCameraOutlined } from "@ant-design/icons";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { TeamsPage } from "./pages/TeamsPage";
import { TeamDetailPage } from "./pages/TeamDetailPage";
import { ProductionsPage } from "./pages/ProductionsPage";
import { ProductionDetailPage } from "./pages/ProductionDetailPage";
import { EditorPage } from "./modules/editor/EditorPage";

const { Sider, Content } = Layout;

function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const selectedKey = location.pathname.startsWith("/teams") ? "teams" : "teams";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider>
        <div
          style={{
            height: 32,
            margin: 16,
            background: "rgba(255, 255, 255, 0.2)",
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontWeight: "bold",
          }}
        >
          AG Studio
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={[
            {
              key: "teams",
              icon: <TeamOutlined />,
              label: "Nhóm",
              onClick: () => navigate("/teams"),
            },
            {
              key: "productions",
              icon: <VideoCameraOutlined />,
              label: "Production",
              disabled: true,
            },
          ]}
        />
      </Sider>
      <Layout>
        <Content style={{ padding: 24 }}>
          <Routes>
            <Route path="/" element={<Navigate to="/teams" replace />} />
            <Route path="/teams" element={<TeamsPage />} />
            <Route path="/teams/:teamId" element={<TeamDetailPage />} />
            <Route path="/teams/:teamId/productions" element={<ProductionsPage />} />
            <Route path="/productions/:productionId" element={<ProductionDetailPage />} />
            <Route path="/productions/:productionId/editor" element={<EditorPage />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}
