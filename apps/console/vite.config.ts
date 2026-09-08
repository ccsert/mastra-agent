import { defineConfig } from "vite";

const host = process.env.CONSOLE_HOST ?? "0.0.0.0";
const port = Number(process.env.CONSOLE_PORT ?? 5179);
const proxy = {
  "/api": process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4110",
  "/openapi.json": process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4110",
};
export default defineConfig({
  server: {
    host,
    port,
    strictPort: true,
    proxy,
  },
  preview: { host, port, strictPort: true, proxy },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "chat", test: /@assistant-ui|assistant-stream|@ai-sdk/ },
            { name: "antd", test: /antd|@ant-design|@rc-component/ },
          ],
        },
      },
    },
  },
});
