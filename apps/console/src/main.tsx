import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { consoleRoutes } from "./app/routing/routes";
import "antd/dist/reset.css";
import "./app/styles/base.css";
import "./app/auth/auth.css";
import "./features/overview/styles.css";
import "./features/agents/styles.css";
import "./features/members/styles.css";
import "./features/chat/styles.css";
import "./features/assistant/styles.css";
import "./features/capabilities/styles.css";
import "./shared/assistant-ui/styles.css";
import "./features/applications/styles.css";
import "./features/runtimes/styles.css";
import "./features/runs/styles.css";
import "./features/knowledge/styles.css";
import "./features/mcp/styles.css";
import "./features/skills/styles.css";

const router = createBrowserRouter(consoleRoutes);
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      token: {
        colorPrimary: "#246b59",
        colorInfo: "#246b59",
        colorText: "#263b36",
        colorTextSecondary: "#71807a",
        borderRadius: 8,
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
        controlHeight: 38,
      },
      components: {
        Button: { primaryShadow: "none" },
        Table: { headerBg: "#f8faf9", headerColor: "#7a8780", cellPaddingBlock: 18 },
        Select: { optionSelectedBg: "#eaf2ee" },
      },
    }}
  >
    <AntApp>
      <RouterProvider router={router} />
    </AntApp>
  </ConfigProvider>,
);
