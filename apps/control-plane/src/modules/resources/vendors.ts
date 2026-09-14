import { ModelVendorPreset } from "@platform/contracts";

/**
 * The platform's vendor catalogue. Every entry is an OpenAI-compatible surface,
 * because that is the only protocol the Runtime speaks — a vendor with a
 * different protocol is deliberately absent rather than listed with a note that
 * it will not work.
 *
 * `baseUrl` is the exact prefix the Runtime concatenates `/chat/completions`
 * onto, so it includes the version segment the vendor documents. `note` records
 * only constraints that are not visible in the address itself.
 *
 * These are operator-facing defaults, not an allow-list: `custom` accepts any
 * OpenAI-compatible address, and an operator may override any preset.
 */
const presets: ModelVendorPreset[] = [
  {
    vendor: "custom",
    label: "自定义（OpenAI 兼容）",
    baseUrl: null,
    note: "适用于任何实现 OpenAI 接口的服务，包括内网自建。地址需包含服务商要求的版本路径。",
  },
  {
    vendor: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com/v1",
    note: "对话模型 deepseek-chat 与推理模型 deepseek-reasoner 使用同一地址。",
  },
  {
    vendor: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    note: "需要平台侧网络可直连 api.openai.com。",
  },
  {
    vendor: "moonshot",
    label: "Moonshot（Kimi）",
    baseUrl: "https://api.moonshot.cn/v1",
    note: "地址已包含 /v1，不要再重复拼接。",
  },
  {
    vendor: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    note: "地址以 /v4 结尾，与其他厂商的 /v1 不同。",
  },
  {
    vendor: "dashscope",
    label: "阿里云百炼（通义千问）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    note: "必须使用 compatible-mode 路径；DashScope 原生协议地址不适用于本平台。",
  },
  {
    vendor: "volcengine",
    label: "火山方舟（豆包）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    note: "模型 ID 需填写控制台里的接入点 ID（ep- 开头），而不是模型名称。",
  },
  {
    vendor: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    note: "模型 ID 形如 Qwen/Qwen3-32B，需包含组织前缀。",
  },
  {
    vendor: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    note: "地址为 api.minimaxi.com；不同区域的域名不同，以控制台显示为准。",
  },
  {
    vendor: "qianfan",
    label: "百度千帆",
    baseUrl: "https://qianfan.baidubce.com/v2",
    note: "地址以 /v2 结尾；API Key 形如 bce-v3/ 开头。",
  },
  {
    vendor: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    note: "模型 ID 形如 vendor/model，需包含提供方前缀。",
  },
  {
    vendor: "ollama",
    label: "Ollama（本地）",
    baseUrl: "http://127.0.0.1:11434/v1",
    note: "本地服务通常无鉴权，API Key 可留空。Runtime 与模型需在同一网络可达位置。",
  },
];
export const modelVendorPresets = () => presets.map((preset) => ModelVendorPreset.parse(preset));
