import type { KnowledgeBase, Model, Tool } from "@platform/sdk";
import {
  Alert,
  Button,
  Collapse,
  Form,
  type FormInstance,
  Input,
  InputNumber,
  Select,
  Switch,
} from "antd";
import { SkillBindingsField } from "../skills/index";
import { type AgentValues, startingPoints, taskPresets } from "./agent-form";

export type AgentSection = "purpose" | "knowledge" | "tools" | "runtime" | "releases";
export function AgentFields({
  section,
  form,
  values,
  models,
  tools,
  knowledge,
  newAgent,
  changed,
  canPublish,
}: {
  section: AgentSection;
  form: FormInstance<AgentValues>;
  values: AgentValues;
  models: Model[];
  tools: Tool[];
  knowledge: KnowledgeBase[];
  newAgent: boolean;
  changed(): void;
  canPublish: boolean;
}) {
  const model = models.find((m) => m.id === values.modelId);
  const incompatible =
    model?.capabilities?.toolUse === false &&
    (!!values.toolIds?.length ||
      !!values.knowledgeBaseIds?.length ||
      values.planningEnabled ||
      values.delegation?.enabled ||
      values.workspaceEnabled);
  return (
    <>
      <section hidden={section !== "purpose"} className="agent-config-section">
        <header>
          <span className="agent-section-kicker">01 / 用途与指令</span>
          <h2>这个 Agent 要帮助你完成什么？</h2>
          <p>先说明适用场景和完成标准，再选择它使用的模型。</p>
        </header>
        {newAgent && (
          <fieldset className="agent-starting-points" aria-label="选择创建起点">
            {startingPoints.map((point) => (
              <Button
                key={point.key}
                onClick={() => {
                  form.setFieldsValue({
                    instructions: point.instructions,
                    ...(point.key === "research"
                      ? {
                          maxSteps: 30,
                          planningEnabled: true,
                          executionLimits: taskPresets[1].executionLimits,
                        }
                      : {}),
                  });
                  changed();
                }}
              >
                <strong>{point.name}</strong>
                <span>{point.description}</span>
              </Button>
            ))}
          </fieldset>
        )}
        <div className="agent-form-pair">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, whitespace: true, message: "请输入名称" }]}
          >
            <Input data-agent-target="agent.name" maxLength={80} placeholder="例如：客户服务助手" />
          </Form.Item>
          <Form.Item
            name="modelId"
            label="模型服务"
            rules={[{ required: true, message: "请选择模型服务" }]}
          >
            <Select
              showSearch={{ optionFilterProp: "label" }}
              placeholder="选择已接入的模型"
              options={models
                .filter((m) => m.kind === "chat")
                .map((m) => ({ value: m.id, label: `${m.name} · ${m.modelId}` }))}
            />
          </Form.Item>
        </div>
        <Form.Item name="description" label="适用场景" extra="帮助团队判断什么时候使用它。">
          <Input.TextArea
            data-agent-target="agent.description"
            rows={2}
            maxLength={500}
            placeholder="面向谁，解决哪些问题，交付什么结果"
          />
        </Form.Item>
        <Form.Item
          name="instructions"
          label="角色与指令"
          rules={[{ required: true, whitespace: true, message: "请输入角色与指令" }]}
          extra="写清目标、工作方法、输出要求，以及信息不足时如何处理。"
        >
          <Input.TextArea
            data-agent-target="agent.instructions"
            rows={9}
            maxLength={16000}
            placeholder="你负责……请根据……完成……最后检查……"
          />
        </Form.Item>
        {!models.some((m) => m.kind === "chat") && (
          <Alert type="info" title="项目还没有对话模型，请联系项目管理员接入。" showIcon />
        )}
        {incompatible && (
          <Alert
            type="warning"
            title="所选模型被标记为不支持工具调用"
            description="知识检索、工具、计划和子代理需要模型支持工具调用，请更换模型或联系管理员检查声明。"
            showIcon
          />
        )}
      </section>
      <section hidden={section !== "knowledge"} className="agent-config-section">
        <header>
          <span className="agent-section-kicker">02 / 知识与技能</span>
          <h2>给它资料，也给它做事的方法</h2>
          <p>知识库提供事实和资料，Skill 提供可复用的任务指导。</p>
        </header>
        <Form.Item
          name="knowledgeBaseIds"
          label="知识库"
          extra="Agent 可以检索所选知识库中已处理成功的资料。"
        >
          <Select
            mode="multiple"
            showSearch={{ optionFilterProp: "label" }}
            placeholder="选择用于回答问题的资料"
            options={knowledge.map((k) => ({
              value: k.id,
              label: `${k.name} · ${k.readyCount} 份可检索文档`,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="skillBindings"
          label="Skills"
          extra="固定引用包的版本；脚本入口由项目管理员授权。"
        >
          <SkillBindingsField allowScriptChanges={canPublish} />
        </Form.Item>
      </section>
      <section hidden={section !== "tools"} className="agent-config-section">
        <header>
          <span className="agent-section-kicker">03 / 工具</span>
          <h2>允许它执行哪些动作？</h2>
          <p>工具用于查询业务信息或执行操作。选择后，Agent 可根据任务自主调用。</p>
        </header>
        <Form.Item name="toolIds" label="授权工具">
          <Select
            mode="multiple"
            showSearch={{ optionFilterProp: "label" }}
            placeholder="选择完成任务需要的工具"
            options={tools.map((t) => ({ value: t.id, label: `${t.name} · ${t.description}` }))}
          />
        </Form.Item>
        <div className="agent-selected-resources">
          {(values.toolIds ?? []).map((id) => {
            const tool = tools.find((t) => t.id === id);
            return (
              <article key={id}>
                <strong>{tool?.name ?? "工具暂不可用"}</strong>
                <p>{tool?.description ?? "请重新选择可用工具。"}</p>
              </article>
            );
          })}
        </div>
        {!tools.length && (
          <Alert
            type="info"
            title="项目还没有可用工具"
            description="可以先创建问答 Agent，之后由管理员接入业务工具。"
            showIcon
          />
        )}
      </section>
      <section hidden={section !== "runtime"} className="agent-config-section">
        <header>
          <span className="agent-section-kicker">04 / 运行设置</span>
          <h2>让投入与任务复杂度相匹配</h2>
          <p>先选常用配置，需要时再调整具体预算。Agent 完成目标后可以提前结束。</p>
        </header>
        <fieldset className="agent-preset-grid" aria-label="任务档位">
          {taskPresets.map((preset) => {
            const selected =
              values.maxSteps === preset.maxSteps &&
              values.planningEnabled === preset.planningEnabled &&
              JSON.stringify(values.executionLimits) === JSON.stringify(preset.executionLimits);
            return (
              <Button
                key={preset.key}
                type={selected ? "primary" : "default"}
                aria-pressed={selected}
                onClick={() => {
                  form.setFieldsValue({
                    maxSteps: preset.maxSteps,
                    planningEnabled: preset.planningEnabled,
                    executionLimits: preset.executionLimits,
                  });
                  changed();
                }}
              >
                <strong>{preset.label}</strong>
                <span>
                  {preset.maxSteps} 步 · {preset.executionLimits.timeoutSeconds / 60} 分钟
                </span>
                <small>{preset.note}</small>
              </Button>
            );
          })}
        </fieldset>
        <p className="form-note">
          当前上限：{values.maxSteps ?? 5} 步 ·{" "}
          {Math.round(
            (values.executionLimits?.timeoutSeconds ?? Math.max(180, (values.maxSteps ?? 5) * 30)) /
              60,
          )}{" "}
          分钟。手动调整后使用自定义配置。
        </p>
        <div className="agent-form-pair">
          <Form.Item
            name="planningEnabled"
            label="记录任务计划"
            valuePropName="checked"
            extra="展示计划、进度与阻塞。"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name={["delegation", "enabled"]}
            label="允许委派子任务"
            valuePropName="checked"
            extra="独立子任务可并行执行，共享总预算。"
          >
            <Switch />
          </Form.Item>
        </div>
        <Form.Item
          name="workspaceEnabled"
          label="网页任务工作区"
          valuePropName="checked"
          extra="使用隔离的文件、命令和浏览器；需 Runtime 已配置网页任务环境，未配置时对话会立即失败（配置见 docs/operations/web-agent.md）。"
        >
          <Switch />
        </Form.Item>
        <Collapse
          ghost
          items={[
            {
              key: "limits",
              label: "高级设置 · 步骤、时间与模型预算",
              forceRender: true,
              children: (
                <div className="agent-form-pair">
                  <Form.Item name="maxSteps" label="每次任务最多执行步骤">
                    <InputNumber min={1} max={80} precision={0} />
                  </Form.Item>
                  <Form.Item
                    name={["executionLimits", "timeoutSeconds"]}
                    label="运行时间上限（秒）"
                  >
                    <InputNumber min={30} max={7200} precision={0} placeholder="自动" />
                  </Form.Item>
                  <Form.Item name={["executionLimits", "maxModelCalls"]} label="总模型请求上限">
                    <InputNumber min={1} max={240} precision={0} placeholder="100" />
                  </Form.Item>
                  <Form.Item name={["executionLimits", "maxTokens"]} label="Token 保护额度">
                    <InputNumber min={1000} max={2000000} precision={0} placeholder="400000" />
                  </Form.Item>
                  <Form.Item name={["executionLimits", "contextTokens"]} label="上下文窗口预算">
                    <InputNumber min={4000} max={128000} precision={0} placeholder="32000" />
                  </Form.Item>
                  <Form.Item name={["executionLimits", "maxOutputTokens"]} label="单次输出上限">
                    <InputNumber min={512} max={32000} precision={0} placeholder="4096" />
                  </Form.Item>
                  <Form.Item name={["delegation", "maxCalls"]} label="每轮最多委派">
                    <InputNumber min={1} max={8} precision={0} />
                  </Form.Item>
                  <Form.Item name={["delegation", "maxParallel"]} label="同时执行上限">
                    <InputNumber min={1} max={4} precision={0} />
                  </Form.Item>
                  <Form.Item name={["delegation", "maxSteps"]} label="每个子任务最多步骤">
                    <InputNumber min={1} max={20} precision={0} />
                  </Form.Item>
                </div>
              ),
            },
          ]}
        />
      </section>
    </>
  );
}
