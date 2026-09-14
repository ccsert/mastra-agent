import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  MastraCompositeStore,
  type WorkflowRun,
  type WorkflowRuns,
  WorkflowsStorage,
} from "@mastra/core/storage";
import type { Workflow, WorkflowRunState } from "@mastra/core/workflows";
import { type RuntimeTaskRequest, z } from "@platform/contracts";

type WithoutLease<T> = T extends unknown ? Omit<T, "leaseToken"> : never;
export type TaskAccess = (
  input: WithoutLease<z.infer<typeof RuntimeTaskRequest>>,
) => Promise<unknown>;
const name = z.enum(["durable-agentic-loop", "durable-agentic-execution"]);
const snapshotShape = z
  .object({
    runId: z.string(),
    status: z.string(),
    context: z.record(z.string(), z.unknown()),
    activeStepsPath: z.record(z.string(), z.array(z.number())),
    value: z.record(z.string(), z.string()),
    serializedStepGraph: z.array(z.unknown()),
    activePaths: z.array(z.number()),
    suspendedPaths: z.record(z.string(), z.array(z.number())),
    waitingPaths: z.record(z.string(), z.array(z.number())),
    resumeLabels: z.record(z.string(), z.unknown()),
    timestamp: z.number(),
  })
  .loose();
const snapshotSchema = z.custom<WorkflowRunState>(
  (value) => snapshotShape.safeParse(value).success,
);

/** Native snapshots repeat message state in nested workflow inputs. Compress the
 * transport/storage representation without discarding any recovery state. */
export function encodeSnapshot(snapshot: WorkflowRunState) {
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json) > 128 * 1024 * 1024) throw new Error("WORKSPACE_LIMIT");
  // gzip's sliding window cannot deduplicate large PNG strings repeated across
  // nested workflow states. Intern identical image bytes before compression.
  let marker = `__snapshot_${randomUUID()}_`;
  while (json.includes(marker)) marker = `__snapshot_${randomUUID()}_`;
  const media: string[] = [],
    indexes = new Map<string, number>();
  const content = json.replace(/iVBORw0KGgo[A-Za-z0-9+/]*={0,2}/g, (png) => {
    let index = indexes.get(png);
    if (index === undefined) {
      index = media.length;
      media.push(png);
      indexes.set(png, index);
    }
    return `${marker}${index}__`;
  });
  return {
    runId: snapshot.runId,
    encoding: "gzip-json-v2",
    data: gzipSync(JSON.stringify({ content, media, marker })).toString("base64"),
  };
}
export function decodeSnapshot(input: unknown): WorkflowRunState {
  const compressed = z
    .object({
      runId: z.string(),
      encoding: z.enum(["gzip-json-v1", "gzip-json-v2"]),
      data: z.string(),
    })
    .safeParse(input);
  if (!compressed.success) return snapshotSchema.parse(input);
  const json = gunzipSync(Buffer.from(compressed.data.data, "base64"), {
    maxOutputLength: 128 * 1024 * 1024,
  });
  let content = json.toString("utf8");
  if (compressed.data.encoding === "gzip-json-v2") {
    const stored = z
      .object({
        content: z.string(),
        media: z.array(z.string()),
        marker: z.string().regex(/^__snapshot_[a-f0-9-]{36}_$/),
      })
      .parse(JSON.parse(content));
    let bytes = Buffer.byteLength(stored.content);
    content = stored.content.replace(
      new RegExp(`${stored.marker}(\\d+)__`, "g"),
      (_match, index: string) => {
        const png = stored.media[Number(index)];
        if (!png) throw new Error("STORAGE_SCOPE_DENIED");
        bytes += png.length;
        if (bytes > 128 * 1024 * 1024) throw new Error("WORKSPACE_LIMIT");
        return png;
      },
    );
  }
  const result = snapshotSchema.parse(JSON.parse(content));
  if (result.runId !== compressed.data.runId) throw new Error("STORAGE_SCOPE_DENIED");
  return result;
}

/** Native workflow protocol over the existing authenticated Runtime connection.
 * The control plane scopes every operation to the leased platform run. */
export class RunWorkflowStore extends WorkflowsStorage {
  constructor(
    private readonly runId: string,
    private readonly call: TaskAccess,
  ) {
    super();
  }
  supportsConcurrentUpdates() {
    return false;
  }
  async dangerouslyClearAll(): Promise<void> {
    throw new Error("STORAGE_SCOPE_DENIED");
  }
  async updateWorkflowResults(): Promise<never> {
    throw new Error("CONCURRENT_STORAGE_UNSUPPORTED");
  }
  async updateWorkflowState(): Promise<never> {
    throw new Error("CONCURRENT_STORAGE_UNSUPPORTED");
  }
  private scope(runId: string) {
    if (runId !== this.runId) throw new Error("STORAGE_SCOPE_DENIED");
  }
  async persistWorkflowSnapshot(input: Parameters<WorkflowsStorage["persistWorkflowSnapshot"]>[0]) {
    this.scope(input.runId);
    await this.call({
      operation: "save",
      workflowName: name.parse(input.workflowName),
      snapshot: encodeSnapshot(input.snapshot),
    });
  }
  async loadWorkflowSnapshot(input: Parameters<WorkflowsStorage["loadWorkflowSnapshot"]>[0]) {
    this.scope(input.runId);
    const response = z
      .object({ snapshot: z.unknown().nullable() })
      .parse(await this.call({ operation: "load", workflowName: name.parse(input.workflowName) }));
    return response.snapshot == null ? null : decodeSnapshot(response.snapshot);
  }
  async listWorkflowRuns(): Promise<WorkflowRuns> {
    const result = z
      .object({
        runs: z.array(
          z.object({
            runId: z.string(),
            workflowName: name,
            snapshot: z.unknown(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        ),
        total: z.number(),
      })
      .parse(await this.call({ operation: "list" }));
    return {
      ...result,
      runs: result.runs.map((row) => ({
        ...row,
        snapshot: decodeSnapshot(row.snapshot),
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      })),
    };
  }
  async getWorkflowRunById(
    input: Parameters<WorkflowsStorage["getWorkflowRunById"]>[0],
  ): Promise<WorkflowRun | null> {
    this.scope(input.runId);
    return (
      (await this.listWorkflowRuns()).runs.find(
        (row) => !input.workflowName || row.workflowName === input.workflowName,
      ) ?? null
    );
  }
  async deleteWorkflowRunById(input: Parameters<WorkflowsStorage["deleteWorkflowRunById"]>[0]) {
    this.scope(input.runId);
    await this.call({ operation: "delete", workflowName: name.parse(input.workflowName) });
  }
}
export const runStorage = (runId: string, call: TaskAccess) =>
  new MastraCompositeStore({
    id: `run-${runId}`,
    domains: { workflows: new RunWorkflowStore(runId, call) },
  });

/** Mastra 1.64.0 restarts active steps from their predecessor output. Its default
 * pruning removes that output. Preserve only those active predecessors, keeping
 * upstream pruning for all other history. Pinned by the recovery regression. */
export function preserveRestartInputs(workflow: Workflow) {
  const prune = workflow.options.pruneSnapshot;
  workflow.options.pruneSnapshot = (params) => {
    const saved = new Map<string, unknown>();
    const entries = Object.entries(params.snapshot.context);
    for (const active of Object.keys(params.snapshot.activeStepsPath)) {
      const index = entries.findIndex(([id]) => id === active);
      const predecessor = entries
        .slice(0, index)
        .findLast(([, step]) => step?.status === "success" && "output" in step);
      if (predecessor && "output" in predecessor[1])
        saved.set(predecessor[0], structuredClone(predecessor[1].output));
    }
    const result = prune?.(params) ?? params.snapshot;
    for (const [id, output] of saved) {
      const step = result.context[id];
      if (step && "output" in step) step.output = output;
    }
    return result;
  };
  for (const step of Object.values(workflow.steps))
    if ("options" in step && "steps" in step) preserveRestartInputs(step as Workflow);
}
