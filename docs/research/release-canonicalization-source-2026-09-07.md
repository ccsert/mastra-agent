# 发布摘要的规范化与输入边界事实核查

日期：2026-09-07。范围：候选发布契约的 JSON 输入、摘要和 Mastra 装配；不代表 AI 编排、FlowGram 往返、授权签发或发布原子性已经实现。

## 固定版本与证据

- `@mastra/core 1.64.0`，固定提交 `c19a93b0956f957581931786645d0597efec41eb`。本地 `workflow-persistence/node_modules` 的 source map 中 builder/index.ts、builder/preflight.ts、builder/authoring-schema.ts、dynamic/validate/refs.ts、dynamic/validate/types.ts 与该提交原文逐字节一致；本次只核对这些文件，不声称整个包均已比对。[固定源目录](https://github.com/mastra-ai/mastra/tree/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows)
- `canonicalize 4.0.0` 的 npm `gitHead` 为 `c1b08c3771d681c8bd9c4d8765e00f2f717482f8`；核查固定提交，不能用已变化的 master 代替。[实现](https://github.com/erdtman/canonicalize/blob/c1b08c3771d681c8bd9c4d8765e00f2f717482f8/lib/canonicalize.js)
- `Ajv 8.20.0` 的 npm `gitHead` 为 `0fba0b8e649909613cfce0999b149cd08f4a4987`；`jsonc-parser 3.3.1` 核查官方固定 tag。本地小探针使用新 `release-contract/node_modules` 中这三个固定版本。[Ajv 类型检查](https://github.com/ajv-validator/ajv/blob/0fba0b8e649909613cfce0999b149cd08f4a4987/lib/compile/validate/dataType.ts)、[Microsoft parser](https://github.com/microsoft/node-jsonc-parser/blob/v3.3.1/src/impl/parser.ts)

## RFC 8785/JCS 的准确含义

| 项目 | 规则与契约影响 |
| --- | --- |
| 对象键 | 递归排序，按解码后字符串的 UTF-16 code unit 比较；不使用 localeCompare。 |
| 数组 | 保留元素顺序；数组中的对象仍排序键。因此不能把工作流步骤排序，也不会自动把 schema 的 required 数组当成集合。 |
| Unicode | 字符串保持原值，不做 NFC/NFD；组合字符不同序列可以得到不同摘要。孤立 surrogate 必须报错。 |
| 重复键 | 输入对象不得有重复成员名；解析成普通 JS 对象以后，已被覆盖的键无法恢复。 |
| 数字 | 基于 IEEE 754 double 和 ECMAScript 序列化，NaN/Infinity 必须报错；负零序列化为 0。需精确保留的大整数或高精度数应采用明确约定的字符串。 |
| 输出 | 不输出 token 间空白，以 UTF-8 字节供哈希/签名；JCS 负责确定表达，不负责选择哪些业务字段参与摘要。 |

以上为 RFC 的输入约束、字符串/数字序列化、对象排序及 UTF-8 规则；该 RFC 是 Informational，并非 IETF Standards Track。[RFC 8785 §3.1–3.2.4](https://www.rfc-editor.org/rfc/rfc8785.html#section-3.1)

**候选契约推论：**布局可以在业务投影阶段排除，但投影规则及其版本必须明确。应先构造完整执行对象，再 JCS，再对 UTF-8 求摘要；摘要本身不能证明目录可信、调用获准或依赖代码完整。JCS 不替应用执行这些验证。[RFC 8785 §5](https://www.rfc-editor.org/rfc/rfc8785.html#section-5)

## canonicalize 与 Ajv 仍需补充什么

`canonicalize 4.0.0` 拒绝非有限数、孤立 surrogate 和循环引用，按 `Object.keys(...).sort()` 递归序列化；同时支持 `toJSON`，跳过对象中的 undefined/symbol。它接受的是 JS 值，不是保留原始键的 JSON 解析器；不能因此把任意 JS 对象当作合法发布输入。[固定实现](https://github.com/erdtman/canonicalize/blob/c1b08c3771d681c8bd9c4d8765e00f2f717482f8/lib/canonicalize.js)

本地固定包观察：`Date` 经 `toJSON` 变为时间字符串；`{a: undefined, b: 1}` 得到 `{"b":1}`；`Array(2)` 得到无效 JSON `[,]`；`JSON.parse('{"a":1,"a":2}')` 之后规范化只得到 `{"a":2}`。这些是限制输入为严格解析 JSON 的理由，不是允许修复或静默丢弃异常输入的依据。

Ajv 的 `strictNumbers` 只在数值类型检查发生时排除非有限数；`strict` 是 schema 使用约束，不等于全树 I-JSON 检查。本地 `strict:true` 小探针中，`{}` schema 接受 Infinity，`{type:'number'}` 拒绝 Infinity，`{type:'string'}` 接受孤立 surrogate。[类型检查源码](https://github.com/ajv-validator/ajv/blob/0fba0b8e649909613cfce0999b149cd08f4a4987/lib/compile/validate/dataType.ts)、[strictNumbers 文档](https://ajv.js.org/options.html#strictnumbers)

`removeAdditional`、`useDefaults`、`coerceTypes` 会修改验证数据，且默认关闭；候选发布校验应保留关闭并拒绝不满足 schema 的输入，避免签摘要前后验证对象变化。`strict:true` 可把未知关键字等问题转为编译错误，但不证明输入输出 schema 兼容或授权成立。[数据修改](https://ajv.js.org/guide/modifying-data.html)、[strict 模式](https://ajv.js.org/options.html#strict)

对于 AI/第三方提供的 schema，Ajv 官方将 schema 视为类似应用代码的可信输入，并明确提醒大小、深度、复杂正则和编译耗时风险。因此应先限制 schema 方言与关键字、输入字节/深度/节点数，再编译；不得把不受限的远程 schema、正则或自定义关键字直接交给通用编译路径。正式边界需要独立验收，合成受信目录不能覆盖它。[Ajv 安全说明](https://ajv.js.org/security.html#untrusted-schemas)

## jsonc-parser 只用于保留键的解析检查

官方 `parseTree` 在每次 `onObjectProperty` 时追加独立 property 节点，其 string 子节点含已解码的键；因此可以在每个 object 节点内用 Set 检测重复键。必须递归检查嵌套对象及数组中的对象。`parse` 直接构造对象，不适合先丢失重复键信息再检测。[parser.ts:212](https://github.com/microsoft/node-jsonc-parser/blob/v3.3.1/src/impl/parser.ts#L212)

该解析器是容错的：返回 tree 不等于语法有效，必须检查 `errors`，显式设置 `disallowComments:true`、`allowTrailingComma:false`、`allowEmptyContent:false`。[官方 API](https://github.com/microsoft/node-jsonc-parser/tree/v3.3.1#parser)

本地固定包验证：`{"a":1,"\u0061":2}` 得到两个解码后的键 `a`，且无 parse error；尾逗号、注释、`{} {}` 均记录错误；`1e400` 无 parse error。因此重复键由平台拒绝，所有解析错误必须拒绝，并继续检查每个数值有限性及每个键/字符串的 Unicode 有效性。严格 `JSON.parse` 可以作为后续语法复核，不能替代前面的重复键检查。

## Mastra 规范化与引用装配

`normalizeWorkflowBuilderDefinition` 清理部分 optional null，将对象形式 `mapConfig` 用 `JSON.stringify` 变为字符串，已有字符串保持不变；这不是 RFC 8785 规范化，也不执行完整 schema/preflight。它检查有限数、循环和普通对象，但会丢弃 undefined 属性；普通对象的赋值还意味着 `__proto__` 等输入需在平台边界处理。[builder/index.ts:126](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/index.ts#L126)

输入 schema、规范化、规范形式 schema 和 preflight 是独立步骤。导出的 `workflowBuilderMappingDescriptorSchema` 用严格对象的 union 约束来源互斥；`workflowBuilderDefinitionInputSchema` 的对象形式会应用它，但字符串形式只要求非空，不解析字符串内部；`workflowBuilderDefinitionSchema` 的 mapConfig 也只检查非空字符串。[authoring-schema.ts:93–134](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/authoring-schema.ts#L93)

本地固定包用 `mapConfig={total:{initData:true,path:'total',value:1}}` 验证：

| 调用 | 对象形式 | 含相同对象的 JSON 字符串形式 |
| --- | --- | --- |
| `workflowBuilderDefinitionInputSchema.safeParse` | 拒绝，`invalid_union` | 接受外部结构 |
| 单独 `normalizeWorkflowBuilderDefinition` | 接受并转为字符串 | 接受且保持字符串 |
| 规范化后 `workflowBuilderDefinitionSchema.safeParse` | 接受外部结构 | 接受外部结构 |
| `workflowBuilderMappingConfigSchema.safeParse` 对解析后的映射对象 | 拒绝混合来源 | 拒绝混合来源 |
| 正确上下文的 `preflightWorkflowDefinition` | 报 `invalid-map-config` | 报 `invalid-map-config` |

因此不能把 normalization 接受输入算作来源验证，也不能仅增加全定义 InputSchema 就声称两种形式都已覆盖。**候选契约推论：**先以同一严格入口解析字符串 mapConfig，再用导出的 MappingConfigSchema 校验解析后的对象；全定义 InputSchema 验证、规范化、规范形式 schema 验证和 preflight 继续分别执行。映射对象 JCS 成字符串后再计算外围摘要，避免内部空白/键序影响摘要；别将模板字符串或普通常量字符串当 JSON 再解析。

| 引用 | 固定版本的实际行为 |
| --- | --- |
| preflight 上下文 | 未提供某类 registry 时跳过该类引用检查；未知 schema 不构成已证明兼容。平台必须提供完整且按权限过滤的目录。 |
| toolId | rehydrate 使用 `mastra.getTool(toolId)`，按实际注册 key 获取；节点 id、tool 自身 id 不应替代 key。 |
| workflowId | 优先 intrinsic workflow id，注册 key 回退；局部节点 id 是 call-site，允许不同于 workflowId。 |
| 内建目录索引 | Mastra 内部同时收录 key 与 intrinsic id；tool intrinsic id 与注册 key 不同可能使引用校验通过、装配仍失败。 |

来源：[preflight](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/preflight.ts)、[refs.ts](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/validate/refs.ts)、[tool 装配](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/rehydrate.ts#L300)、[workflow 查找](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/rehydrate.ts#L397)、[内建目录索引](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/mastra/index.ts#L4960)。

preflight 的 context 是 `WorkflowRegistryIndex`：各目录成员为 `{inputSchema?: JsonSchema, outputSchema?: JsonSchema}` 记录。直接传 Tool/Workflow 实例会把其中的运行时 schema 对象交给错误的分析路径；平台应提供转换后的 JSON Schema 记录。实验中此类误传导致的路径误判是调用方错误，不是已证实的 Mastra 路径校验缺陷。[context 类型](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/validate/types.ts#L62)

**候选契约推论：**服务端提供稳定、版本明确的实际装配标识，并检测 key/id 冲突；不接受客户端自报依赖摘要作为可信事实。平台目录查找使用 Map 或无原型对象及 own-key 检查，避免官方 `index.tools[toolId]` 真值检查把继承属性当资源存在。编排 schema 通过、目录命中、版本摘要匹配和真实装配成功应分别验证；本次事实核查没有实现发布事务、租约或签名信任链。
