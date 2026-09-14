import {
  AgentInput,
  AgentUpdate,
  type AssistantPage,
  DocumentInput,
  Id,
  KnowledgeInput,
  McpServerInput,
  ModelInput,
  type Permission,
  type Principal,
  ProjectRole,
  SkillBinding,
  SkillPreviewInput,
  SkillSourceInput,
  ToolInput,
  WorkflowAssetInput,
  WorkflowAssetUpdate,
  z,
} from "@platform/contracts";
import JSZip from "jszip";
import { notFound } from "../../infrastructure/errors.ts";
import type { Agents } from "../agents/index.ts";
import type { Applications } from "../applications/index.ts";
import type { Knowledge } from "../knowledge/index.ts";
import type { Mcp } from "../mcp/index.ts";
import type { Members } from "../members/index.ts";
import type { Projects } from "../projects/index.ts";
import { modelDto, type Resources, toolDto } from "../resources/index.ts";
import type { Skills } from "../skills/index.ts";
import type { Workflows } from "../workflows/index.ts";
export interface AssistantDomains {
  projects: Projects;
  resources: Resources;
  agents: Agents;
  knowledge: Knowledge;
  skills: Skills;
  workflows: Workflows;
  mcp: Mcp;
  members: Members;
  applications: Applications;
}
export interface Operation {
  id: string;
  label: string;
  group: string;
  mode: "read" | "write";
  permission: Permission;
  tenantAdmin?: boolean;
  risk: "draft" | "publish" | "access";
  schema: z.ZodType;
  run(actor: Principal, projectId: string, input: unknown): Promise<unknown>;
}
const empty = z.object({}).strict(),
  target = z.object({ id: Id }).strict();
const pageInput = z
  .object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) })
  .strict();
// The assistant can bind guidance; script grants remain in the dedicated editor.
const assistantAgentInput = AgentInput.extend({
  skillBindings: z
    .array(SkillBinding.extend({ entrypoints: z.array(z.string()).max(0).default([]) }))
    .max(10)
    .default([]),
});
const assistantAgentUpdate = assistantAgentInput.extend({
  baseRevision: AgentUpdate.shape.baseRevision,
});
function op<S extends z.ZodType>(
  id: string,
  label: string,
  permission: Permission,
  schema: S,
  run: (actor: Principal, projectId: string, input: z.infer<S>) => Promise<unknown>,
  mode: "read" | "write" = "read",
  risk: Operation["risk"] = "draft",
  tenantAdmin = false,
): Operation {
  return {
    id,
    label,
    group: id.split(".")[0],
    permission,
    schema,
    mode,
    risk,
    tenantAdmin,
    run: (actor, projectId, input) => run(actor, projectId, schema.parse(input)),
  };
}
function created(value: unknown, page: z.infer<typeof AssistantPage>) {
  const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    id: object.id,
    name: object.name ?? object.filename ?? "",
    revision: object.draftRevision ?? object.revision,
    page,
    resourceId: object.agentId ?? object.id,
    status: object.status ?? "saved",
  };
}
export function operations(d: AssistantDomains): Operation[] {
  return [
    op("access.read", "查看我的权限", "project.read", empty, (a, p) =>
      d.projects.access.project(a, p),
    ),
    op("project.list", "列出可访问项目", "project.read", empty, (a) => d.projects.list(a)),
    op(
      "agent.list",
      "查找 Agent 摘要和发布状态",
      "project.read",
      z.object({ query: z.string().max(100).optional() }).strict(),
      async (a, p, i) => {
        const agents = (await d.agents.list(a, p)).filter(
          (agent) =>
            !i.query ||
            `${agent.name} ${agent.description}`.toLowerCase().includes(i.query.toLowerCase()),
        );
        return {
          items: agents
            .slice(0, 50)
            .map(({ id, name, description, draftRevision, publishedVersion, modelId }) => ({
              id,
              name,
              description,
              draftRevision,
              publishedVersion,
              modelId,
            })),
          total: agents.length,
          limited: agents.length > 50,
        };
      },
    ),
    op("agent.get", "读取指定 Agent 的完整配置", "resource.read", target, async (a, p, i) => {
      const agent = (await d.agents.list(a, p)).find((v) => v.id === i.id);
      if (!agent) throw notFound();
      return agent;
    }),
    op("model.list", "查看可用模型摘要", "resource.read", empty, async (a, p) =>
      (await d.resources.models(a, p)).map(
        ({ id, name, kind, modelId, capabilities, hasCredential }) => ({
          id,
          name,
          kind,
          modelId,
          capabilities,
          hasCredential,
        }),
      ),
    ),
    op("model.get", "读取指定模型配置", "resource.read", target, async (a, p, i) =>
      modelDto(await d.resources.get(a, p, i.id, "model")),
    ),
    op("tool.list", "查看工具摘要", "resource.read", empty, async (a, p) =>
      (await d.resources.tools(a, p)).map(({ id, name, description, kind }) => ({
        id,
        name,
        description,
        kind,
      })),
    ),
    op("tool.get", "读取指定工具定义", "resource.read", target, async (a, p, i) =>
      toolDto(await d.resources.get(a, p, i.id, "tool")),
    ),
    op("skill.list", "分页查看 Skills 摘要", "resource.read", pageInput, async (a, p, i) => {
      const page = await d.skills.list(a, p, i);
      return {
        ...page,
        items: page.items.map(({ id, name, description, version, enabled }) => ({
          id,
          name,
          description,
          version,
          enabled,
        })),
      };
    }),
    op("skill.get", "读取指定 Skill 的清单", "resource.read", target, (a, p, i) =>
      d.skills.get(a, p, i.id),
    ),
    op(
      "skill.file",
      "阅读 Skill 文件",
      "resource.read",
      target.extend({ path: z.string().max(200) }),
      async (a, p, i) => {
        const version = await d.skills.get(a, p, i.id),
          metadata = version.files.find((f) => f.path === i.path);
        const file = await d.skills.file(a, p, i.id, i.path);
        if (metadata?.encoding !== "utf-8")
          return {
            path: file.path,
            hash: file.hash,
            binary: true,
            message: "此文件为二进制，请在 Skills 页面查看或下载",
          };
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(file.contentBase64, "base64"),
        );
        return {
          path: file.path,
          hash: file.hash,
          text: text.slice(0, 30000),
          truncated: text.length > 30000,
        };
      },
    ),
    op("skill.discover", "查找来源中的 Skills", "resource.edit", SkillSourceInput, (a, p, i) =>
      d.skills.discover(a, p, i),
    ),
    op("skill.preview", "预览来源 Skill", "resource.edit", SkillPreviewInput, (a, p, i) =>
      d.skills.preview(a, p, i),
    ),
    op("knowledge.list", "查看知识库", "resource.read", empty, (a, p) => d.knowledge.list(a, p)),
    op(
      "document.list",
      "查看知识库文档",
      "resource.read",
      z.object({ knowledgeBaseId: Id }).strict(),
      (a, p, i) => d.knowledge.documents(a, p, i.knowledgeBaseId),
    ),
    op(
      "document.source",
      "阅读固定文档原文",
      "resource.read",
      z.object({ knowledgeBaseId: Id, id: Id, versionId: Id.optional() }).strict(),
      (a, p, i) => d.knowledge.source(a, p, i.knowledgeBaseId, i.id, i.versionId),
    ),
    op("workflow.list", "分页查看工作流摘要", "resource.read", pageInput, async (a, p, i) => {
      const page = await d.workflows.list(a, p, i);
      return {
        ...page,
        items: page.items.map(({ id, name, description, revision, publishedVersion }) => ({
          id,
          name,
          description,
          revision,
          publishedVersion,
        })),
      };
    }),
    op("workflow.get", "读取指定工作流定义", "resource.read", target, (a, p, i) =>
      d.workflows.asset(a, p, i.id),
    ),
    op("application.list", "查看应用状态（不含访问凭据）", "resource.manage", empty, async (a, p) =>
      (await d.applications.list(a, p)).map(({ id, name, active }) => ({ id, name, active })),
    ),
    op("workflow.catalog", "读取工作流节点与配置规范", "resource.read", empty, (a, p) =>
      d.workflows.catalog(a, p),
    ),
    op(
      "workflow.validate",
      "校验工作流草稿",
      "agent.edit",
      target.extend({ baseRevision: z.number().int().positive() }),
      (a, p, i) => d.workflows.validate(a, p, i.id, i.baseRevision),
    ),
    op("mcp.list", "查看 MCP 服务", "resource.read", empty, (a, p) => d.mcp.list(a, p)),
    op("member.list", "查看项目成员", "project.manage", empty, (a, p) =>
      d.members.projectMembers(a, p),
    ),
    op(
      "member.candidates",
      "查找可加入项目的团队成员",
      "project.manage",
      z.object({ query: z.string().max(100) }).strict(),
      (a, p, i) => d.members.candidates(a, p, i.query),
    ),
    op("audit.list", "查看项目审计记录", "project.manage", empty, (a, p) => d.members.audit(a, p)),
    op(
      "project.create",
      "创建项目",
      "project.read",
      z.object({ name: z.string().min(1).max(80), description: z.string().max(500) }).strict(),
      async (a, _p, i) => {
        const project = await d.projects.create(a, i);
        return { id: project.id, name: project.name, page: "overview", projectId: project.id };
      },
      "write",
      "draft",
      true,
    ),
    op(
      "agent.create",
      "创建 Agent 草稿",
      "agent.edit",
      assistantAgentInput,
      async (a, p, i) => created(await d.agents.create(a, p, i), "agents"),
      "write",
    ),
    op(
      "agent.update",
      "更新 Agent 草稿",
      "agent.edit",
      z.object({ id: Id, definition: assistantAgentUpdate }).strict(),
      async (a, p, i) => {
        const { baseRevision, ...definition } = i.definition;
        return created(await d.agents.update(a, p, i.id, definition, baseRevision), "agents");
      },
      "write",
    ),
    op(
      "agent.publish",
      "发布 Agent",
      "agent.publish",
      target.extend({ baseRevision: z.number().int().positive() }),
      async (a, p, i) => created(await d.agents.publish(a, p, i.id, i.baseRevision), "agents"),
      "write",
      "publish",
    ),
    op(
      "knowledge.create",
      "创建知识库",
      "resource.edit",
      KnowledgeInput,
      async (a, p, i) => created(await d.knowledge.create(a, p, i), "knowledge"),
      "write",
    ),
    op(
      "document.add",
      "添加文本资料",
      "resource.edit",
      z.object({ knowledgeBaseId: Id, document: DocumentInput }).strict(),
      async (a, p, i) => ({
        ...created(await d.knowledge.upload(a, p, i.knowledgeBaseId, i.document), "knowledge"),
        resourceId: i.knowledgeBaseId,
      }),
      "write",
    ),
    op(
      "document.retry",
      "重试文档索引",
      "resource.edit",
      z.object({ knowledgeBaseId: Id, id: Id }).strict(),
      async (a, p, i) => ({
        ...created(await d.knowledge.retry(a, p, i.knowledgeBaseId, i.id), "knowledge"),
        resourceId: i.knowledgeBaseId,
      }),
      "write",
    ),
    op(
      "skill.create",
      "创建纯指导 Skill",
      "resource.edit",
      z
        .object({
          name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
          description: z.string().min(1).max(500),
          instructions: z.string().min(1).max(16000),
        })
        .strict(),
      async (a, p, i) => {
        const zip = new JSZip();
        zip.file(
          "SKILL.md",
          `---\nname: ${i.name}\ndescription: ${JSON.stringify(i.description)}\n---\n\n${i.instructions}\n`,
        );
        return created(
          await d.skills.upload(
            a,
            p,
            await zip.generateAsync({ type: "base64", compression: "DEFLATE" }),
          ),
          "skills",
        );
      },
      "write",
    ),
    op(
      "skill.import",
      "导入已预览的 Skill",
      "resource.edit",
      z.object({ previewId: Id }).strict(),
      async (a, p, i) => created(await d.skills.confirmImport(a, p, i.previewId), "skills"),
      "write",
    ),
    op(
      "workflow.create",
      "创建工作流草稿",
      "agent.edit",
      WorkflowAssetInput,
      async (a, p, i) => created(await d.workflows.create(a, p, i), "workflows"),
      "write",
    ),
    op(
      "workflow.update",
      "更新工作流草稿",
      "agent.edit",
      z.object({ id: Id, definition: WorkflowAssetUpdate }).strict(),
      async (a, p, i) => {
        const { baseRevision, ...definition } = i.definition;
        return created(await d.workflows.update(a, p, i.id, definition, baseRevision), "workflows");
      },
      "write",
    ),
    op(
      "workflow.publish",
      "发布工作流",
      "agent.publish",
      target.extend({ baseRevision: z.number().int().positive() }),
      async (a, p, i) =>
        created(await d.workflows.publish(a, p, i.id, i.baseRevision), "workflows"),
      "write",
      "publish",
    ),
    op(
      "model.create",
      "登记模型（凭据另行填写）",
      "resource.manage",
      ModelInput.omit({ apiKey: true }).strict(),
      async (a, p, i) => created(await d.resources.createModel(a, p, i), "models"),
      "write",
    ),
    op(
      "tool.create",
      "登记工具（凭据另行填写）",
      "resource.manage",
      ToolInput.omit({ bearerToken: true }).strict(),
      async (a, p, i) =>
        created(await d.resources.createTool(a, p, { ...i, bearerToken: "" }), "tools"),
      "write",
    ),
    op(
      "mcp.create",
      "登记 MCP 服务（凭据另行填写）",
      "resource.manage",
      McpServerInput.omit({ bearerToken: true }).strict(),
      async (a, p, i) => created(await d.mcp.create(a, p, { ...i, bearerToken: "" }), "mcp"),
      "write",
    ),
    op(
      "member.set",
      "调整项目成员角色",
      "project.manage",
      z.object({ userId: Id, role: ProjectRole.nullable() }).strict(),
      async (a, p, i) => {
        await d.members.setProjectMember(a, p, i.userId, i.role);
        return { id: i.userId, role: i.role, page: "settings", status: "saved" };
      },
      "write",
      "access",
    ),
  ];
}
