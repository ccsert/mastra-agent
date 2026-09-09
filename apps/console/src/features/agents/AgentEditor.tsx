import type { Agent } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Form, Input, Select } from "antd";
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
  return (
    <EditorForm
      {...props}
      title={agent ? "编辑 Agent 草稿" : "创建 Agent"}
      submitLabel="保存草稿"
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
      <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
        <Input placeholder="例如：业务分析助手" maxLength={80} />
      </Form.Item>
      <Form.Item name="description" label="说明">
        <Input.TextArea rows={2} placeholder="描述用途和适用场景" maxLength={500} />
      </Form.Item>
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
          rows={7}
          placeholder="你是团队的业务助手。说明任务、约束，以及应如何使用工具。"
          maxLength={16000}
        />
      </Form.Item>
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
      <Form.Item name="maxSteps" label="每次运行最多执行轮数">
        <Select options={[1, 3, 5, 8, 10].map((v) => ({ value: v, label: `${v} 轮` }))} />
      </Form.Item>
      <Alert type="info" title="保存会更新草稿。发布后才供新会话使用，已有会话继续使用原版本。" />
    </EditorForm>
  );
}
