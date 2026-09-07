import { defineConfig } from "vite";
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.CONSOLE_PORT ?? 5179),
    strictPort: true,
    proxy: {
      "/api": process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4110",
      "/openapi.json": process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:4110",
    },
  },
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
