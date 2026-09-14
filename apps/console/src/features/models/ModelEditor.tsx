import { ApiOutlined, ReloadOutlined, SafetyOutlined } from "@ant-design/icons";
import type {
  Model,
  ModelDiscovery,
  ModelProbe,
  ModelVendor,
  ModelVendorPreset,
} from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, AutoComplete, Button, Form, Input, InputNumber, Select, Spin, Switch } from "antd";
import { useCallback, useEffect, useState } from "react";
import { unwrap } from "../../shared/api";
import { type EditorCallbacks, EditorForm } from "../../shared/EditorForm";

type Values = {
  name: string;
  baseUrl: string;
  modelId: string;
  modelKind: "chat" | "embedding" | "rerank";
  vendor: ModelVendor;
  capabilities: { vision?: boolean; toolUse?: boolean };
  apiKey?: string;
  dimensions?: number;
};
/** Where each capability is actually sent; the same paths the Runtime calls. */
const probePaths = {
  chat: "/chat/completions",
  embedding: "/embeddings",
  rerank: "/rerank",
} as const;
type Probe =
  | { state: "idle" }
  | { state: "probing" }
  /** `signature` records what was probed, so a later edit stops the verdict from describing it. */
  | { state: "done"; signature: string; result: ModelProbe }
  /** The probe request never reached the model; this is not a verdict about it. */
  | { state: "failed"; message: string };
type Discovery =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; signature: string; result: ModelDiscovery }
  | { state: "failed"; message: string };
const probeVerdicts = {
  ok: { type: "success" as const, title: "平台直连成功" },
  rejected: { type: "error" as const, title: "服务已响应，但拒绝了请求或格式不符" },
  unreachable: { type: "warning" as const, title: "平台无法连接该地址" },
  timeout: { type: "warning" as const, title: "平台等待服务响应超时" },
};
function ProbeVerdict({ result }: { result: ModelProbe }) {
  const verdict = probeVerdicts[result.outcome];
  return (
    <Alert
      type={verdict.type}
      title={verdict.title}
      showIcon
      className="form-alert"
      description={
        <>
          <span>{result.message}</span>
          <small className="probe-facts">
            {result.httpStatus === null ? "未取得 HTTP 响应" : `HTTP ${result.httpStatus}`}
            {result.latencyMs === null ? "" : ` · 用时 ${result.latencyMs} ms`}
            {result.dimensions === null ? "" : ` · ${result.dimensions} 维`}
          </small>
          {result.outcome === "unreachable" || result.outcome === "timeout" ? (
            <small className="probe-facts">
              这只说明平台侧网络不通。Runtime
              可能位于另一个网络，能连接该地址，因此不要据此判断模型配置有误。
            </small>
          ) : null}
        </>
      }
    />
  );
}
export function ModelEditor({
  projectId,
  model,
  ...props
}: EditorCallbacks & { projectId: string; model?: Model }) {
  const [form] = Form.useForm<Values>();
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  const [discovery, setDiscovery] = useState<Discovery>({ state: "idle" });
  const [vendors, setVendors] = useState<ModelVendorPreset[]>();
  const [vendorError, setVendorError] = useState<string>();
  const vendor = Form.useWatch("vendor", form);
  /**
   * Reported ids become choices for 模型 ID, but they are kept per base URL: an
   * id list gathered from one service must not be offered after the address
   * changes, because those ids describe a different service.
   */
  const [choices, setChoices] = useState<{ signature: string; ids: string[] }>();
  useEffect(() => {
    form.resetFields();
    form.setFieldsValue({
      modelKind: "chat",
      vendor: "custom",
      capabilities: { vision: false, toolUse: true },
      name: "",
      baseUrl: "",
      modelId: "",
      apiKey: "",
      ...(model
        ? {
            name: model.name,
            modelKind: model.kind,
            vendor: model.vendor ?? "custom",
            capabilities: {
              vision: model.capabilities?.vision ?? false,
              toolUse: model.capabilities?.toolUse ?? true,
            },
            baseUrl: model.baseUrl,
            modelId: model.modelId,
            apiKey: "",
            dimensions: model.dimensions,
          }
        : {}),
    });
  }, [form, model]);
  /**
   * The catalogue only powers a convenience dropdown, so it must never block
   * registering a model — but silence is worse than no list: an empty dropdown
   * reads as "there are no vendors" rather than "the catalogue could not be
   * read". The failure is kept and shown, with a way to retry. It is a
   * `useCallback` so the mount effect can depend on it without re-running on
   * every render.
   */
  const loadVendors = useCallback(async () => {
    setVendorError(undefined);
    try {
      setVendors(await unwrap(api.listModelVendors()));
    } catch (error) {
      setVendorError(error instanceof Error ? error.message : "供应商目录读取失败");
    }
  }, []);
  useEffect(() => {
    void loadVendors();
  }, [loadVendors]);
  const activeVendor = vendors?.find((v) => v.vendor === vendor);
  // The watched values arrive after the first render, so the verdict is keyed to
  // what was probed instead of being cleared by an effect that would fire late.
  const modelKind = Form.useWatch("modelKind", form),
    baseUrl = Form.useWatch("baseUrl", form),
    modelId = Form.useWatch("modelId", form),
    signature = `${modelKind ?? ""}|${baseUrl ?? ""}|${modelId ?? ""}`,
    endpoint = baseUrl ? `${baseUrl.replace(/\/$/, "")}${probePaths[modelKind ?? "chat"]}` : "";
  const choiceSignature = `${baseUrl ?? ""}|${modelKind ?? "chat"}`,
    modelChoices = choices?.signature === choiceSignature ? choices.ids : [];
  async function runProbe() {
    let values: Values;
    try {
      values = await form.validateFields(["baseUrl", "modelId", "modelKind"]);
    } catch {
      return;
    }
    setProbe({ state: "probing" });
    try {
      const result = await unwrap(
        api.probeModel({
          path: { projectId },
          body: {
            kind: values.modelKind,
            baseUrl: values.baseUrl,
            modelId: values.modelId,
            ...(values.modelKind === "embedding" && values.dimensions
              ? { dimensions: values.dimensions }
              : {}),
            // A blank key on an existing model reuses its stored credential.
            ...(values.apiKey
              ? { apiKey: values.apiKey }
              : model
                ? { credentialFrom: model.id }
                : {}),
          },
        }),
      );
      setProbe({
        state: "done",
        // Keyed to the values actually probed, not to the watched ones.
        signature: `${values.modelKind}|${values.baseUrl}|${values.modelId}`,
        result,
      });
    } catch (error) {
      setProbe({
        state: "failed",
        message: error instanceof Error ? error.message : "无法发出探测请求。",
      });
    }
  }
  /** Reads the service's own model list so the operator picks instead of typing. */
  async function runDiscovery() {
    let baseUrlValue: string;
    try {
      ({ baseUrl: baseUrlValue } = await form.validateFields(["baseUrl"]));
    } catch {
      return;
    }
    // The key is read from the form rather than from validateFields, which only
    // returns the fields it was asked to validate.
    const apiKeyValue = form.getFieldValue("apiKey") as string | undefined,
      signatureAtRequest = `${baseUrlValue}|${form.getFieldValue("modelKind") ?? "chat"}`;
    setDiscovery({ state: "loading" });
    try {
      const result = await unwrap(
        api.discoverModels({
          path: { projectId },
          body: {
            baseUrl: baseUrlValue,
            ...(apiKeyValue ? { apiKey: apiKeyValue } : model ? { credentialFrom: model.id } : {}),
          },
        }),
      );
      setDiscovery({ state: "done", signature: signatureAtRequest, result });
      if (result.models.length) setChoices({ signature: signatureAtRequest, ids: result.models });
    } catch (error) {
      setDiscovery({
        state: "failed",
        message: error instanceof Error ? error.message : "无法发出列表请求。",
      });
    }
  }
  return (
    <EditorForm
      {...props}
      title={model ? "编辑模型服务" : "接入模型服务"}
      form={form}
      onSubmit={async (values, signal) => {
        const base = {
          name: values.name,
          baseUrl: values.baseUrl,
          modelId: values.modelId,
          kind: values.modelKind,
          vendor: values.vendor,
          capabilities: {
            vision: values.capabilities?.vision ?? false,
            toolUse: values.capabilities?.toolUse ?? true,
          },
          ...(values.modelKind === "embedding" && values.dimensions
            ? { dimensions: values.dimensions }
            : {}),
        };
        if (model)
          await unwrap(
            api.updateModel({
              signal,
              path: { projectId, id: model.id },
              // Leaving the key blank keeps the stored credential.
              body: { ...base, ...(values.apiKey ? { apiKey: values.apiKey } : {}) },
            }),
            signal,
          );
        else
          await unwrap(
            api.createModel({
              signal,
              path: { projectId },
              body: { ...base, apiKey: values.apiKey ?? "" },
            }),
            signal,
          );
      }}
    >
      <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
        <Input placeholder="填写一个便于团队识别的名称" maxLength={80} />
      </Form.Item>
      <p className="form-note">
        接入对话、向量或重排服务。模型凭据加密保存，浏览器不会收到已保存的密钥。
        {model ? " 已发布的版本固定了原有配置，这里的修改只影响之后重新发布的 Agent。" : ""}
      </p>
      <Form.Item
        name="vendor"
        label="供应商"
        extra={
          vendorError
            ? "供应商列表只是预填地址的便利，不影响保存；也可以直接填写 Base URL。"
            : undefined
        }
      >
        <Select
          showSearch
          optionFilterProp="label"
          loading={!vendors && !vendorError}
          placeholder="选择供应商以预填地址，或选择自定义"
          options={(vendors ?? []).map((preset) => ({
            value: preset.vendor,
            label: preset.label,
            preset,
          }))}
          onChange={(next: string) => {
            const preset = vendors?.find((v) => v.vendor === next);
            // Only presets that carry an address overwrite what is already typed;
            // `custom` deliberately leaves the operator's own URL in place.
            if (preset?.baseUrl) form.setFieldValue("baseUrl", preset.baseUrl);
            setChoices(undefined);
            setDiscovery({ state: "idle" });
          }}
        />
      </Form.Item>
      {vendorError ? (
        <Alert
          type="warning"
          showIcon
          className="form-alert"
          title="供应商列表没有取到"
          description={
            <>
              <span>{vendorError}</span>
              <Button size="small" onClick={() => void loadVendors()}>
                重新获取
              </Button>
            </>
          }
        />
      ) : null}
      {activeVendor?.note ? <p className="form-note">{activeVendor.note}</p> : null}
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
      <p className="form-note">
        {endpoint ? (
          <>
            实际调用 <code className="code-input">{endpoint}</code>
            。服务商文档里的版本路径（如 <code className="code-input">/v1</code>）需要包含在 Base
            URL 中。
          </>
        ) : (
          <>Base URL 是接口前缀，平台会在其后拼接各能力的路径。</>
        )}
      </p>
      <Form.Item
        name="modelId"
        label="模型 ID"
        rules={[{ required: true, message: "请输入模型服务中的模型 ID" }]}
      >
        {modelChoices.length ? (
          // AutoComplete suggests the listed ids but still accepts free text: some
          // services use ids that were not listed (a volcengine endpoint id, for
          // example), so the field must not become a closed list.
          <AutoComplete
            options={modelChoices.map((id) => ({ value: id }))}
            placeholder="选择或输入模型 ID"
          />
        ) : (
          <Input placeholder="服务提供的模型标识，例如 qwen3-27b" />
        )}
      </Form.Item>
      <section className="model-probe">
        <div>
          <strong>获取可用模型</strong>
          <span>
            读取该服务声明的模型
            ID。列表只说明服务列出了什么，不代表模型可用，也不代表具备某种能力。
          </span>
        </div>
        <Button
          icon={discovery.state === "loading" ? <Spin size="small" /> : <ReloadOutlined />}
          onClick={() => void runDiscovery()}
        >
          获取模型列表
        </Button>
      </section>
      {discovery.state === "done" && discovery.signature === choiceSignature && (
        <Alert
          type={discovery.result.outcome === "ok" ? "success" : "warning"}
          showIcon
          title={
            discovery.result.outcome === "ok"
              ? `已获取 ${discovery.result.models.length} 个模型 ID`
              : "未能获取模型列表"
          }
          description={
            <>
              <span>{discovery.result.message}</span>
              <small className="probe-facts">
                {discovery.result.httpStatus === null
                  ? "未取得 HTTP 响应"
                  : `HTTP ${discovery.result.httpStatus}`}
                {discovery.result.latencyMs === null
                  ? ""
                  : ` · 用时 ${discovery.result.latencyMs} ms`}
              </small>
            </>
          }
        />
      )}
      {discovery.state === "failed" && (
        // Not 「列表请求未发出」: the request may well have reached the platform
        // and been answered with an error (a 404 for a route the running backend
        // lacks), so the title must not assert something about the request. The
        // message below names the actual cause.
        <Alert type="error" title="没能获取模型列表" description={discovery.message} showIcon />
      )}
      <Form.Item
        name="apiKey"
        label="API Key"
        extra={model ? "留空表示保留已保存的密钥。" : undefined}
      >
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
      <section className="model-probe">
        <div>
          <strong>存盘前先验证</strong>
          <span>用与 Runtime 相同的方式请求一次服务，只发送 “ping”，不保存任何内容。</span>
        </div>
        <Button
          icon={probe.state === "probing" ? <Spin size="small" /> : <ApiOutlined />}
          onClick={() => void runProbe()}
        >
          测试连接
        </Button>
      </section>
      {probe.state === "done" && probe.signature === signature && (
        <ProbeVerdict result={probe.result} />
      )}
      {probe.state === "failed" && (
        <Alert type="error" title="探测请求未发出" description={probe.message} showIcon />
      )}
      <section className="model-capabilities">
        <div>
          <strong>
            <SafetyOutlined /> 模型能力声明
          </strong>
          <span>
            由你根据服务商文档填写，平台不会自动探测，也不会据此改变请求方式。发布 Agent
            时用它与已绑定能力对照，避免选了不具备对应能力的模型。
          </span>
        </div>
        <Form.Item name={["capabilities", "toolUse"]} valuePropName="checked" noStyle>
          <Switch checkedChildren="支持工具调用" unCheckedChildren="不支持工具调用" />
        </Form.Item>
        <Form.Item name={["capabilities", "vision"]} valuePropName="checked" noStyle>
          <Switch checkedChildren="支持图片输入" unCheckedChildren="不支持图片输入" />
        </Form.Item>
        <small className="probe-facts">
          当前对话还不接受图片附件，因此「支持图片输入」仅作为选型记录，不会让对话能够发送图片。
        </small>
      </section>
    </EditorForm>
  );
}
