import assert from "node:assert/strict";
import test from "node:test";
import {
  pruneToolOutputs,
  TOOL_RESULT_PRUNE,
} from "../../apps/control-plane/src/modules/conversations/context.ts";
import { Message } from "../../packages/contracts/src/index.ts";

function message(parts: unknown[]) {
  return Message.parse({
    id: "m1",
    role: "assistant",
    parts,
    metadata: { runId: "00000000-0000-4000-8000-000000000001" },
  });
}

function toolPart(output: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "dynamic-tool",
    toolCallId: "call-1",
    toolName: "demo",
    state: "output-available",
    input: { path: "a.ts" },
    output,
    ...extra,
  };
}

test("oversized tool outputs become head/tail excerpts that name the original size", () => {
  const original = "前锋😺".repeat(3000); // 9000 code points, emoji-safe slicing
  const [first] = pruneToolOutputs([message([toolPart(original)])]);
  const output = String((first.parts[0] as { output: string }).output);
  assert.ok(output.startsWith(`[工具输出已裁剪：原始约 ${original.length} 字符，以下保留首尾]`));
  assert.ok(output.includes("中段省略"));
  assert.ok(output.endsWith("[完整结果在会话轨迹中可查]"));
  assert.ok(output.length < TOOL_RESULT_PRUNE.threshold + 200);
  assert.ok(output.includes("前锋😺"));
  const chars = Array.from(output);
  assert.ok(chars.length < original.length);
  // The head keeps the beginning verbatim; the tail keeps the end verbatim.
  assert.ok(output.includes(Array.from(original).slice(0, 32).join("")));
  assert.ok(output.includes(Array.from(original).slice(-32).join("")));
});

test("small outputs, inputs, error text, and non-tool parts pass through untouched", () => {
  const small = toolPart("短结果");
  const errorPart = toolPart(undefined, {
    state: "output-error",
    errorText: "E-失败".repeat(10),
  });
  const textMessage = message([{ type: "text", text: "x".repeat(20000) }]);
  const [kept, errored, plain] = pruneToolOutputs([
    message([small]),
    message([errorPart]),
    textMessage,
  ]);
  assert.equal((kept.parts[0] as { output: string }).output, "短结果");
  assert.deepEqual((kept.parts[0] as { input: unknown }).input, { path: "a.ts" });
  assert.equal((errored.parts[0] as { errorText: string }).errorText, "E-失败".repeat(10));
  assert.equal((plain.parts[0] as { text: string }).text.length, 20000);
});
