import type { Agent } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Form, Input, Select, Tag } from "antd";
import { useEffect } from "react";
import { unwrap } from "../../shared/api";
import { useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { type EditorCallbacks, EditorForm } from "../../shared/EditorForm";
import { SkillBindingsField } from "../skills/index";

type Values = Pick<
  Agent,
  | "name"
  | "description"
  | "modelId"
  | "instructions"
  | "toolIds"
  | "knowledgeBaseIds"
  | "skillBindings"
  | "maxSteps"
>;
export function AgentEditor({
  projectId,
  agent,
  ...props
}: EditorCallbacks & { projectId: string; agent?: Agent }) {
  const [form] = Form.useForm<Values>();
  const modelsQuery = useProjectQuery("models"),
    toolsQuery = useProjectQuery("tools"),
    knowledgeQuery = useProjectQuery("knowledgeBases"),
    skillsQuery = useProjectQuery("skills");
  const models = modelsQuery.data ?? [],
    tools = toolsQuery.data ?? [],
    knowledgeBases = knowledgeQuery.data ?? [];
  const ready = [modelsQuery, toolsQuery, knowledgeQuery, skillsQuery].every(
    (q) => q.data !== undefined && !q.error,
  );
  useEffect(() => {
    form.resetFields();
    form.setFieldsValue({
      description: "",
      toolIds: [],
      knowledgeBaseIds: [],
      skillBindings: [],
      maxSteps: 5,
      ...agent,
    });
  }, [form, agent]);
  const values = Form.useWatch([], form) as Values | undefined;
  return (
    <EditorForm
      {...props}
      title={agent ? "编辑 Agent 草稿" : "创建 Agent"}
      submitLabel="保存草稿"
      size={1040}
      form={form}
      ready={ready}
      notice={
        <>
          <QueryState label="模型服务" query={modelsQuery}>
            {null}
          </QueryState>
          <QueryState label="工具" query={toolsQuery}>
            {null}
          </QueryState>
          <QueryState label="知识库" query={knowledgeQuery}>
            {null}
          </QueryState>
        </>
      }
      onSubmit={async (values, signal) => {
        const body = {
          name: values.name,
          description: values.description ?? "",
          modelId: values.modelId,
          instructions: values.instructions,
          toolIds: values.toolIds ?? [],
          knowledgeBaseIds: values.knowledgeBaseIds ?? [],
          skillBindings: values.skillBindings ?? [],
          maxSteps: values.maxSteps ?? 5,
        };
        if (agent)
          await unwrap(
            api.updateAgent({
              signal,
              path: { projectId, id: agent.id },
              body: { ...body, baseRevision: agent.draftRevision },
            }),
            signal,
          );
        else await unwrap(api.createAgent({ signal, path: { projectId }, body }), signal);
      }}
    >
      <div className="agent-editor-layout">
        <div className="agent-editor-fields">
          <section className="agent-editor-section">
            <h3>基本信息</h3>
            <p className="form-note">告诉团队这个 Agent 适合处理哪些任务。</p>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
              <Input placeholder="例如：业务分析助手" maxLength={80} />
            </Form.Item>
            <Form.Item name="description" label="说明">
              <Input.TextArea rows={2} placeholder="描述用途和适用场景" maxLength={500} />
            </Form.Item>
          </section>
          <section className="agent-editor-section">
            <h3>模型与行为</h3>
            <Form.Item
              name="modelId"
              label="模型服务"
              rules={[{ required: true, message: "请选择模型服务" }]}
            >
              <Select
                placeholder="选择已登记的模型"
                options={models
                  .filter((m) => m.kind === "chat")
                  .map((m) => ({ label: `${m.name} · ${m.modelId}`, value: m.id }))}
              />
            </Form.Item>
            <Form.Item
              name="instructions"
              label="角色与指令"
              rules={[{ required: true, message: "请填写 Agent 指令" }]}
            >
              <Input.TextArea
                className="agent-instructions"
                rows={14}
                showCount
                placeholder={
                  "# 角色与目标\n说明服务对象、任务和成功标准。\n\n# 工作方式\n如何选择工具、检索资料和使用 Skills。\n\n# 输出要求\n结构、引用、语言以及失败时的处理。\n\n# 约束\n哪些信息必须询问用户，哪些动作需要确认。"
                }
                maxLength={16000}
              />
            </Form.Item>
            <p className="form-note">
              这里定义持续生效的行为规则。工具、知识库和脚本的实际权限由下方能力绑定决定。
            </p>
          </section>
          <section className="agent-editor-section">
            <h3>能力与授权</h3>
            <Form.Item name="toolIds" label="授权工具">
              <Select
                mode="multiple"
                placeholder="选择允许 Agent 自主调用的工具"
                options={tools.map((t) => ({ label: `${t.name} · ${t.description}`, value: t.id }))}
              />
            </Form.Item>
            <Form.Item
              name="knowledgeBaseIds"
              label="授权知识库"
              extra="Agent 可自主检索这些资料，使用最新处理成功的文档。发布版本固定知识库与模型配置。"
            >
              <Select
                mode="multiple"
                placeholder="选择当前项目的知识库"
                options={knowledgeBases.map((k) => ({
                  value: k.id,
                  label: `${k.name} · ${k.readyCount} 份可检索文档`,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="skillBindings"
              label="Skills"
              extra="发布时固定版本及脚本入口。脚本仅使用本次 JSON 输入和包内文件，无网络或业务凭据；工具授权单独生效。"
            >
              <SkillBindingsField />
            </Form.Item>
          </section>
          <section className="agent-editor-section">
            <h3>运行边界</h3>
            <Form.Item
              name="maxSteps"
              label="每次任务最多执行步骤"
              extra="一次模型响应及其工具调用构成一个步骤。到达上限后结束本次任务，不代表对话轮数。"
            >
              <Select options={[1, 3, 5, 8, 10].map((v) => ({ value: v, label: `${v} 步` }))} />
            </Form.Item>
          </section>
        </div>
        <aside className="agent-editor-summary" aria-label="Agent 配置概览">
          <Tag color="blue">{agent ? `草稿修订 ${agent.draftRevision}` : "新 Agent"}</Tag>
          <h3>{values?.name || "未命名 Agent"}</h3>
          <p>{values?.description || "补充用途后，团队可以更容易找到它。"}</p>
          <dl>
            <dt>模型</dt>
            <dd>{models.find((m) => m.id === values?.modelId)?.name ?? "尚未选择"}</dd>
            <dt>工具</dt>
            <dd>{values?.toolIds?.length ?? 0} 项</dd>
            <dt>知识库</dt>
            <dd>{values?.knowledgeBaseIds?.length ?? 0} 项</dd>
            <dt>Skills</dt>
            <dd>{values?.skillBindings?.length ?? 0} 个固定版本</dd>
            <dt>运行上限</dt>
            <dd>{values?.maxSteps ?? 5} 步</dd>
          </dl>
          <Alert
            type="info"
            title="保存草稿 → 发布 → 新建会话"
            description="保存后在 Agent 列表发布，再开始对话。已有会话继续使用原版本。"
          />
        </aside>
      </div>
    </EditorForm>
  );
}
