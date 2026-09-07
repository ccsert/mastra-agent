import { ExecutionJob, Message } from "@platform/contracts";
import { executeJob } from "./execute.ts";
export interface WorkerConfig {
  controlPlaneUrl: string;
  runtimeId: string;
  runtimeToken: string;
  signal: AbortSignal;
}
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
export async function runWorker(config: WorkerConfig) {
  async function post(path: string, body: unknown, signal: AbortSignal = config.signal) {
    const response = await fetch(config.controlPlaneUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.runtimeToken}`,
        "x-runtime-id": config.runtimeId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw new Error(`CONTROL_PLANE_${response.status}`);
    return response.json();
  }
  let disconnected = false;
  while (!config.signal.aborted) {
    let job: ExecutionJob | null = null;
    try {
      const response = await post("/internal/runtime/claim", {});
      job = response.job ? ExecutionJob.parse(response.job) : null;
      if (disconnected) {
        console.log("Runtime control connection restored");
        disconnected = false;
      }
    } catch {
      if (!config.signal.aborted && !disconnected)
        console.error("Runtime control connection unavailable");
      disconnected = true;
      await wait(1000, config.signal);
      continue;
    }
    if (!job) {
      await wait(500, config.signal);
      continue;
    }
    const current = job,
      controller = new AbortController(),
      executionSignal = AbortSignal.any([
        config.signal,
        controller.signal,
        AbortSignal.timeout(Math.max(1, current.deadline - Date.now())),
      ]);
    let seq = 0,
      cancelled = false;
    const heartbeat = setInterval(() => {
      void post(
        `/internal/runtime/runs/${current.runId}/heartbeat`,
        { leaseToken: current.leaseToken },
        executionSignal,
      )
        .then((result) => {
          if (result.cancelRequested) {
            cancelled = true;
            controller.abort();
          }
        })
        .catch(() => controller.abort());
    }, 4000);
    try {
      const message = await executeJob(current, executionSignal, async (chunk) => {
        await post(
          `/internal/runtime/runs/${current.runId}/events`,
          { leaseToken: current.leaseToken, seq: seq++, chunk },
          executionSignal,
        );
      });
      await post(`/internal/runtime/runs/${current.runId}/finish`, {
        leaseToken: current.leaseToken,
        status: "succeeded",
        message: Message.parse(message),
      });
    } catch {
      controller.abort();
      const errorCode =
        cancelled || config.signal.aborted
          ? "CANCELLED"
          : Date.now() >= current.deadline
            ? "TIMEOUT"
            : "MODEL_ERROR";
      try {
        await post(
          `/internal/runtime/runs/${current.runId}/finish`,
          { leaseToken: current.leaseToken, status: cancelled ? "cancelled" : "failed", errorCode },
          AbortSignal.timeout(8000),
        );
      } catch {
        console.error(
          "Runtime completion could not be acknowledged; lease expiry will finalize the run.",
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
