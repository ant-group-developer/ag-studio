/**
 * Dev-only playground: renders `EditorView` against an in-memory fake client (no Auth0, no API) so the
 * editor can be looked at and exercised directly. Served at http://localhost:5173/playground.html by `vite`
 * dev; not part of `vite build` (that only ever builds `index.html`). `?cut`: a shot-cut episode (cut 1.1.0).
 */
import "../i18n/config";
import React from "react";
import ReactDOM from "react-dom/client";
import { Button, Typography } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditorView } from "../modules/editor/EditorView";
import { createFakeEditorClient } from "./fake-client";

const { Text } = Typography;

const queryClient = new QueryClient();
const { client, simulateConflictOnNextSave } = createFakeEditorClient({ cut: new URLSearchParams(window.location.search).has("cut") });

function Playground() {
  return (
    <div>
      <div
        style={{
          padding: "8px 16px",
          background: "#fffbe6",
          borderBottom: "1px solid #ffe58f",
          display: "flex",
          gap: 12,
          alignItems: "center",
        }}
      >
        <Text strong>AG Studio — Editor playground v3 (dữ liệu giả lập)</Text>
        <Button size="small" onClick={() => simulateConflictOnNextSave()}>
          Giả lập xung đột
        </Button>
      </div>
      <div style={{ padding: 16 }}>
        <EditorView
          productionId="playground"
          episodeId="ep-playground"
          client={client}
          media={async () => null}
        />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Playground />
    </QueryClientProvider>
  </React.StrictMode>
);
