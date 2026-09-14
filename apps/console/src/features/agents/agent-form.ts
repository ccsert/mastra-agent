import type { Agent, AgentInput, ExecutionLimits } from "@platform/sdk";

export type AgentValues = AgentInput;
export const taskPresets = [
  {
    key: "short",
    label: "日常问答",
    note: "快速问答与简单工具任务",
    maxSteps: 5,
    planningEnabled: false,
    executionLimits: {
      timeoutSeconds: 180,
      maxModelCalls: 20,
      maxTokens: 100000,
      contextTokens: 32000,
      maxOutputTokens: 4096,
    },
  },
  {
    key: "iteration",
    label: "持续迭代",
    note: "分析、研究与多步执行",
    maxSteps: 30,
    planningEnabled: true,
    executionLimits: {
      timeoutSeconds: 3600,
      maxModelCalls: 60,
      maxTokens: 1000000,
      contextTokens: 32000,
      maxOutputTokens: 8192,
    },
  },
  {
    key: "complex",
    label: "复杂任务",
    note: "允许更长时间与更多步骤",
    maxSteps: 80,
    planningEnabled: true,
    executionLimits: {
      timeoutSeconds: 7200,
      maxModelCalls: 160,
      maxTokens: 2000000,
      contextTokens: 32000,
      maxOutputTokens: 8192,
    },
  },
] satisfies {
  key: string;
  label: string;
  note: string;
  maxSteps: number;
  planningEnabled: boolean;
  executionLimits: ExecutionLimits;
}[];
export const startingPoints = [
  {
    key: "knowledge",
    name: "知识问答",
    description: "根据团队资料回答问题",
    instructions:
      "你是团队知识助手。先理解用户的问题，再检索已授权知识库。回答应简洁、准确，并说明使用的资料来源；没有足够依据时说明缺少什么信息，不编造事实。",
  },
  {
    key: "business",
    name: "业务执行",
    description: "调用工具完成明确的业务任务",
    instructions:
      "你是业务执行助手。先明确任务目标与必要输入，再使用已授权工具完成操作。核对工具实际返回的结果，清楚说明完成情况、异常和需要用户补充的信息。",
  },
  {
    key: "research",
    name: "复杂任务",
    description: "分解任务、持续核对与改进",
    instructions:
      "你负责完成复杂任务。先明确目标、约束和验收标准，制定可执行计划。按需使用知识、技能和工具，持续验证中间结果，遇到阻塞说明具体原因。交付成果时提供验证依据与剩余限制。",
  },
];
export function agentValues(agent?: Agent): AgentValues {
  return agent
    ? agentBody(agent)
    : {
        name: "",
        description: "",
        instructions: "",
        modelId: "",
        toolIds: [],
        knowledgeBaseIds: [],
        skillBindings: [],
        maxSteps: 5,
        planningEnabled: false,
        delegation: { enabled: false, maxCalls: 3, maxParallel: 2, maxSteps: 3 },
      };
}
export function agentBody(v: AgentValues): AgentValues {
  return {
    name: v.name,
    description: v.description ?? "",
    instructions: v.instructions,
    modelId: v.modelId,
    toolIds: v.toolIds ?? [],
    knowledgeBaseIds: v.knowledgeBaseIds ?? [],
    skillBindings: v.skillBindings ?? [],
    maxSteps: v.maxSteps ?? 5,
    planningEnabled: v.planningEnabled,
    delegation: v.delegation
      ? {
          enabled: v.delegation.enabled ?? false,
          maxCalls: v.delegation.maxCalls ?? 3,
          maxParallel: v.delegation.maxParallel ?? 2,
          maxSteps: v.delegation.maxSteps ?? 3,
        }
      : undefined,
    workspaceEnabled: v.workspaceEnabled,
    executionLimits:
      v.executionLimits && Object.values(v.executionLimits).some((value) => value != null)
        ? {
            timeoutSeconds:
              v.executionLimits.timeoutSeconds ?? Math.max(180, (v.maxSteps ?? 5) * 30),
            maxModelCalls: v.executionLimits.maxModelCalls ?? 100,
            maxTokens: v.executionLimits.maxTokens ?? 400000,
            contextTokens: v.executionLimits.contextTokens ?? 32000,
            maxOutputTokens: v.executionLimits.maxOutputTokens ?? 4096,
          }
        : undefined,
  };
}
export function changedSections(current: AgentValues, published?: AgentValues) {
  if (!published) return ["首次发布：用途、模型及所选能力"];
  const groups: [string, (keyof AgentValues)[]][] = [
    ["用途与指令", ["name", "description", "instructions"]],
    ["模型", ["modelId"]],
    ["知识与技能", ["knowledgeBaseIds", "skillBindings"]],
    ["工具", ["toolIds"]],
    [
      "运行设置",
      ["maxSteps", "planningEnabled", "delegation", "executionLimits", "workspaceEnabled"],
    ],
  ];
  return groups
    .filter(([, keys]) =>
      keys.some((key) => JSON.stringify(current[key]) !== JSON.stringify(published[key])),
    )
    .map(([label]) => label);
}
