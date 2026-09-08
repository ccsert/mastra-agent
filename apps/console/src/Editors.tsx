import type { Agent, Application } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Button, Drawer, Form, Input, InputNumber, Select } from "antd";
import { useEffect, useState } from "react";
import { unwrap } from "./api";
import { useProjectQuery } from "./data/ProjectData";
import { QueryState } from "./data/QueryState";
import { useLifetime } from "./useLifetime";
export type EditorKind = "project" | "model" | "tool" | "agent" | "application";
type Values = {
  name: string;
  description?: string;
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
  modelKind?: "chat" | "embedding" | "rerank";
  dimensions?: number;
  instructions?: string;
  toolIds?: string[];
  knowledgeBaseIds?: string[];
  maxSteps?: number;
  kind?: "sum" | "http_get";
  url?: string;
  bearerToken?: string;
  inputSchema?: string;
  outputSchema?: string;
};
const labels = {
  project: "创建项目",
  model: "接入模型服务",
  tool: "登记工具",
  agent: "创建 Agent",
  application: "创建应用凭据",
};
export function Editor({
  kind,
  projectId,
  agent,
  onClose,
  onSaved,
  onCredential,
}: {
  kind: EditorKind | null;
  projectId: string;
  agent?: Agent;
  onClose: () => void;
  onSaved: () => void;
  onCredential?: (value: Application & { secretKey: string }) => void;
}) {
  const lifetime = useLifetime();
  const modelsQuery = useProjectQuery("models", { enabled: kind === "agent" }),
    toolsQuery = useProjectQuery("tools", { enabled: kind === "agent" }),
    knowledgeQuery = useProjectQuery("knowledgeBases", { enabled: kind === "agent" });
  const models = modelsQuery.data ?? [],
    tools = toolsQuery.data ?? [],
    knowledgeBases = knowledgeQuery.data ?? [];
  const ready =
    kind !== "agent" ||
    [modelsQuery, toolsQuery, knowledgeQuery].every(
      (query) => query.data !== undefined && !query.error,
    );

  const [form] = Form.useForm<Values>(),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const toolKind = Form.useWatch("kind", form);
  const modelKind = Form.useWatch("modelKind", form);
  useEffect(() => {
    if (kind) {
      form.resetFields();
      form.setFieldsValue({
        description: "",
        kind: "sum",
        modelKind: "chat",
        inputSchema: '{"type":"object","properties":{},"additionalProperties":false}',
        outputSchema: '{"type":"object"}',
        toolIds: [],
        knowledgeBaseIds: [],
        maxSteps: 5,
        ...(agent ?? {}),
      });
      setError("");
    }
  }, [kind, agent, form]);
  async function submit(values: Values) {
    if (!ready) return;
    const signal = lifetime();
    setSaving(true);
    setError("");
    try {
      const path = { projectId };
      if (kind === "project")
        await unwrap(
          api.createProject({
            signal,
            body: { name: values.name, description: values.description ?? "" },
          }),
        );
      if (kind === "model")
        await unwrap(
          api.createModel({
            signal,
            path,
            body: {
              name: values.name,
              baseUrl: values.baseUrl ?? "",
              modelId: values.modelId ?? "",
              apiKey: values.apiKey ?? "",
              kind: values.modelKind ?? "chat",
              ...(values.modelKind === "embedding" && values.dimensions
                ? { dimensions: values.dimensions }
                : {}),
            },
          }),
        );
      if (kind === "tool")
        await unwrap(
          api.createTool({
            signal,
            path,
            body: {
              name: values.name,
              description: values.description ?? "",
              kind: values.kind ?? "sum",
              url: values.url ?? "",
              bearerToken: values.bearerToken ?? "",
              inputSchema: JSON.parse(values.inputSchema ?? "{}"),
              outputSchema: JSON.parse(values.outputSchema ?? "{}"),
            },
          }),
        );
      if (kind === "agent") {
        const body = {
          name: values.name,
          description: values.description ?? "",
          modelId: values.modelId ?? "",
          instructions: values.instructions ?? "",
          toolIds: values.toolIds ?? [],
          knowledgeBaseIds: values.knowledgeBaseIds ?? [],
          maxSteps: values.maxSteps ?? 5,
        };
        if (agent)
          await unwrap(
            api.updateAgent({
              signal,
              path: { ...path, id: agent.id },
              body: { ...body, baseRevision: agent.draftRevision },
            }),
          );
        else await unwrap(api.createAgent({ path, body, signal }));
      }
      if (kind === "application") {
        const credential = await unwrap(
          api.createApplication({ path, body: { name: values.name }, signal }),
        );
        if (signal.aborted) return;
        onCredential?.(credential);
      }
      if (signal.aborted) return;
      onSaved();
      onClose();
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  }
  return (
    <Drawer
      title={kind === "agent" && agent ? "编辑 Agent 草稿" : kind ? labels[kind] : ""}
      open={!!kind}
      onClose={onClose}
      size={560}
      destroyOnHidden
      footer={
        <div className="dialog-footer">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} disabled={!ready} onClick={() => form.submit()}>
            {kind === "agent" ? "保存草稿" : "保存"}
          </Button>
        </div>
      }
    >
      {error && <Alert type="error" title={error} showIcon className="form-alert" />}
      {kind === "agent" && (
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
      )}
      <Form
        disabled={!ready}
        form={form}
        layout="vertical"
        onFinish={submit}
        requiredMark="optional"
      >
        <Form.Item
          name="name"
          label={kind === "tool" ? "工具调用名" : "名称"}
          rules={[
            { required: true, message: "请输入名称" },
            ...(kind === "tool"
              ? [
                  {
                    pattern: /^[a-z][a-z0-9_]{1,49}$/,
                    message: "使用小写字母、数字和下划线，字母开头",
                  },
                ]
              : []),
          ]}
        >
          <Input
            placeholder={
              kind === "agent"
                ? "例如：业务分析助手"
                : kind === "tool"
                  ? "例如：sum_values"
                  : "填写一个便于团队识别的名称"
            }
            maxLength={80}
          />
        </Form.Item>
        {(kind === "project" || kind === "agent" || kind === "tool") && (
          <Form.Item
            name="description"
            label="说明"
            rules={
              kind === "tool"
                ? [{ required: true, message: "请说明工具的用途，供 Agent 选择" }]
                : []
            }
          >
            <Input.TextArea rows={2} placeholder="描述用途和适用场景" maxLength={500} />
          </Form.Item>
        )}
        {kind === "model" && (
          <>
            <p className="form-note">
              接入对话、向量或重排服务。模型凭据加密保存，浏览器不会收到已保存的密钥。
            </p>
            <Form.Item name="modelKind" label="服务能力">
              <Select
                options={[
                  { value: "chat", label: "对话 · Chat Completions" },
                  { value: "embedding", label: "向量 · Embeddings" },
                  { value: "rerank", label: "重排 · Rerank" },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="baseUrl"
              label="Base URL"
              rules={[
                { required: true, message: "请输入服务地址" },
                { type: "url", message: "请输入完整 HTTP(S) 地址" },
              ]}
            >
              <Input placeholder="https://api.example.com/v1" />
            </Form.Item>
            <Form.Item
              name="modelId"
              label="模型 ID"
              rules={[{ required: true, message: "请输入模型服务中的模型 ID" }]}
            >
              <Input placeholder="服务提供的模型标识" />
            </Form.Item>
            <Form.Item name="apiKey" label="API Key">
              <Input.Password autoComplete="new-password" placeholder="无鉴权的自建服务可留空" />
            </Form.Item>
            {modelKind === "embedding" && (
              <Form.Item
                name="dimensions"
                label="向量维度（可选）"
                extra="作为 dimensions 参数发送；不填则使用模型默认值。知识库会固定实际维度。"
              >
                <InputNumber
                  min={1}
                  max={16000}
                  precision={0}
                  placeholder="例如 1024"
                  style={{ width: "100%" }}
                />
              </Form.Item>
            )}
            <Alert
              type="info"
              title="对话模型通过 Agent 验证；向量和重排模型通过文档入库及检索测试验证。"
            />
          </>
        )}
        {kind === "tool" && (
          <>
            <Form.Item name="kind" label="执行方式">
              <Select
                options={[
                  { label: "内置求和 · 确定性工具", value: "sum" },
                  { label: "HTTP GET · 只读 JSON 接口", value: "http_get" },
                ]}
              />
            </Form.Item>
            {toolKind === "sum" ? (
              <Alert
                type="info"
                title="输入 values 数字数组，返回 total。平台自动固定输入输出约束。"
              />
            ) : (
              <>
                <Form.Item
                  name="url"
                  label="接口地址"
                  rules={[
                    { required: true, message: "请输入接口地址" },
                    { type: "url", message: "请输入完整地址" },
                  ]}
                >
                  <Input placeholder="https://business.example.com/orders" />
                </Form.Item>
                <Form.Item name="bearerToken" label="服务凭据（可选）">
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Form.Item name="inputSchema" label="输入 JSON Schema" rules={[{ required: true }]}>
                  <Input.TextArea rows={5} className="code-input" />
                </Form.Item>
                <Form.Item
                  name="outputSchema"
                  label="输出 JSON Schema"
                  rules={[{ required: true }]}
                >
                  <Input.TextArea rows={4} className="code-input" />
                </Form.Item>
              </>
            )}
            <p className="form-note">
              当前交付只读工具。业务写入审批和 MCP 注册将在后续功能中接入。
            </p>
          </>
        )}
        {kind === "agent" && (
          <>
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
            <Form.Item name="maxSteps" label="每次运行最多执行轮数">
              <Select options={[1, 3, 5, 8, 10].map((v) => ({ value: v, label: `${v} 轮` }))} />
            </Form.Item>
            <Alert
              type="info"
              title="保存会更新草稿。发布后才供新会话使用，已有会话继续使用原版本。"
            />
          </>
        )}
        {kind === "application" && (
          <Alert
            type="info"
            title="凭据限定当前项目，仅能调用已发布 Agent。SK 只在创建后显示一次，请保存在业务后端。"
          />
        )}
      </Form>
    </Drawer>
  );
}
