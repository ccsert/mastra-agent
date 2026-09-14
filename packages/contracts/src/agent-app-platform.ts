import type { AgentAppManifest } from "./agent-app.ts";
import { AssistantUiOperation, AssistantUiView } from "./assistant-ui.ts";
import { AssistantPage } from "./platform-assistant.ts";

export const platformAppRegistrationId = "00000000-0000-4000-8000-000000000001";
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const outputSchema = object({ message: { type: "string" } }, ["message"]);
export const platformAppManifest: AgentAppManifest = {
  protocolVersion: "1.0",
  appId: "platform.console",
  name: "当前平台页面",
  version: "1.0.0",
  actions: [
    {
      id: "page.navigate",
      title: "打开平台页面",
      description: "打开有权限的页面，可选择已有资源；页面会等待加载完成。",
      effect: "view",
      inputSchema: object(
        {
          page: { type: "string", enum: AssistantPage.options.filter((p) => p !== "team") },
          resourceId: { type: "string" },
        },
        ["page"],
      ),
      outputSchema,
    },
    {
      id: "agent.create",
      title: "打开新建 Agent 草稿",
      description: "打开编辑表单，不创建或保存业务资源。",
      effect: "draft",
      inputSchema: object({}),
      outputSchema,
    },
    {
      id: "agent.draft.patch",
      title: "填写 Agent 草稿",
      description:
        "修改当前 Agent 表单的名称、描述或指令，不保存、不发布。字段必须已在当前页面显示。",
      effect: "draft",
      inputSchema: {
        ...object({
          name: { type: "string", maxLength: 80 },
          description: { type: "string", maxLength: 500 },
          instructions: { type: "string", maxLength: 16000 },
        }),
        minProperties: 1,
      },
      outputSchema,
    },
    {
      id: "page.control",
      title: "切换视图或搜索",
      description: "使用当前状态中的目标及可选值搜索目录或切换页签。",
      effect: "view",
      inputSchema: object(
        {
          target: {
            type: "string",
            enum: [
              "agent.section",
              "skills.source",
              "tools.source",
              "capability.search",
              "capability.operations.search",
              "capability.operations.available",
            ],
          },
          value: { type: "string", maxLength: 16000 },
        },
        ["target", "value"],
      ),
      outputSchema,
    },
  ],
};
/** Compatibility adapter at the platform edge; third-party applications do not use these targets. */
export function platformAppOperations(
  action: string,
  args: Record<string, unknown>,
  rawView: unknown,
) {
  const view = AssistantUiView.parse(rawView),
    viewRevision = view.revision;
  const operations =
    action === "page.navigate"
      ? [{ ...args, operation: "navigate", viewRevision }]
      : action === "agent.create"
        ? [{ operation: "act", target: "agent.create", viewRevision }]
        : action === "agent.draft.patch"
          ? Object.entries(args).map(([key, value]) => ({
              operation: "act",
              target: `agent.${key}`,
              value,
              viewRevision,
            }))
          : action === "page.control"
            ? [{ ...args, operation: "act", viewRevision }]
            : [];
  if (!operations.length) throw new Error("UNKNOWN_ACTION");
  return operations.map((operation) => AssistantUiOperation.parse(operation));
}
