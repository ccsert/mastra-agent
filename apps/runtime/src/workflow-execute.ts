import { randomUUID } from "node:crypto";
import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
  assertWorkflowValue,
  evaluateCondition,
  validateWorkflow,
  type WorkflowNode,
  type WorkflowSnapshot,
  workflowNodeInput,
  z,
} from "@platform/contracts";

const Envelope = z.object({
  input: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).optional(),
});
type Envelope = z.infer<typeof Envelope>;
export interface WorkflowHooks {
  start(node: WorkflowNode, input: Record<string, unknown>): Promise<unknown>;
  invoke(node: WorkflowNode, input: Record<string, unknown>, binding: unknown): Promise<unknown>;
  finish(node: WorkflowNode, output: unknown, error?: Error): Promise<void>;
}
export async function executeWorkflow(
  snapshot: WorkflowSnapshot,
  input: Record<string, unknown>,
  signal: AbortSignal,
  hooks: WorkflowHooks,
) {
  const { definition, catalog } = snapshot;
  if (validateWorkflow(definition, catalog).length) throw new Error("WORKFLOW_INVALID");
  assertWorkflowValue(definition.inputSchema, input);
  signal.throwIfAborted();
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const make = (id: string) =>
    createWorkflow({
      id,
      inputSchema: Envelope,
      outputSchema: Envelope,
      options: { validateInputs: true },
      retryConfig: { attempts: 0, delay: 0 },
    });
  let failure: Error | undefined;
  const build = (first: string): ReturnType<typeof make> => {
    let workflow = make(`path_${first}`);
    let id: string | undefined = first;
    while (id) {
      const node: WorkflowNode | undefined = nodes.get(id);
      if (!node) throw new Error("WORKFLOW_INVALID");
      const step = createStep({
        id: node.id,
        inputSchema: Envelope,
        outputSchema: Envelope,
        retries: 0,
        execute: async ({ inputData }) => {
          signal.throwIfAborted();
          const value = workflowNodeInput(node, inputData.input, inputData.outputs);
          let started = false;
          try {
            const binding = await hooks.start(node, value);
            started = true;
            signal.throwIfAborted();
            let output: unknown;
            if (node.type === "agent" || node.type === "tool")
              output = await hooks.invoke(node, value, binding);
            else if (node.type === "condition")
              output = { matched: evaluateCondition(node, inputData.input, inputData.outputs) };
            else output = value;
            const shape =
              node.type === "end"
                ? definition.outputSchema
                : node.type === "start"
                  ? definition.inputSchema
                  : (catalog.find(
                      (c) =>
                        (node.type === "tool" && c.kind === "tool" && c.id === node.toolId) ||
                        (node.type === "agent" && c.kind === "agent" && c.id === node.releaseId),
                    )?.outputSchema ?? { type: "object" });
            assertWorkflowValue(shape, output);
            signal.throwIfAborted();
            await hooks.finish(node, output);
            return {
              ...inputData,
              outputs: { ...inputData.outputs, [node.id]: output },
              ...(node.type === "end"
                ? { result: z.record(z.string(), z.unknown()).parse(output) }
                : {}),
            };
          } catch (error) {
            failure = error instanceof Error ? error : new Error("WORKFLOW_NODE_FAILED");
            if (started) await hooks.finish(node, null, failure).catch(() => {});
            throw failure;
          }
        },
      });
      workflow = workflow.then(step);
      const edges: typeof definition.edges = definition.edges.filter((e) => e.source === node.id);
      if (node.type === "condition") {
        const yesEdge = edges.find((e) => e.port === "true"),
          noEdge = edges.find((e) => e.port === "false");
        if (!yesEdge || !noEdge) throw new Error("WORKFLOW_INVALID");
        const yes = build(yesEdge.target),
          no = build(noEdge.target);
        const matches = (envelope: Envelope) =>
          (envelope.outputs[node.id] as { matched: boolean }).matched;
        return workflow
          .branch([
            [async ({ inputData }) => matches(inputData), yes],
            [async ({ inputData }) => !matches(inputData), no],
          ])
          .map(async ({ inputData }) => {
            const values = Object.values(inputData).filter((value) => value !== undefined);
            if (values.length !== 1) throw new Error("WORKFLOW_BRANCH_INVALID");
            return Envelope.parse(values[0]);
          })
          .commit();
      }
      id = edges[0]?.target;
    }
    return workflow.commit();
  };
  const start = definition.nodes.find((n) => n.type === "start");
  if (!start) throw new Error("WORKFLOW_INVALID");
  const root = build(start.id);
  const mastra = new Mastra({ workflows: { root }, logger: false, workers: false });
  const run = await mastra.getWorkflow("root").createRun({ runId: randomUUID() });
  const cancel = () => {
    void run.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const result = await run.start({ inputData: { input, outputs: {} } });
    signal.throwIfAborted();
    if (failure) throw failure;
    if (result.status !== "success" || !result.result.result) throw new Error("WORKFLOW_FAILED");
    assertWorkflowValue(definition.outputSchema, result.result.result);
    return result.result.result;
  } finally {
    signal.removeEventListener("abort", cancel);
    await mastra.shutdown();
  }
}
