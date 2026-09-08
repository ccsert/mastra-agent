import { McpJob } from "@platform/contracts";
import { discoverMcp } from "./mcp.ts";
import { runtimeClient, type WorkerConfig } from "./worker.ts";

export async function runMcpWorker(config: WorkerConfig) {
  const post = runtimeClient(config);
  while (!config.signal.aborted) {
    let job: McpJob | null = null;
    try {
      const response = await post("/internal/runtime/mcp/claim", {});
      job = response.job ? McpJob.parse(response.job) : null;
    } catch {
      /* Agent worker reports shared control-connection failures. */
    }
    if (!job) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          config.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 750);
        if (config.signal.aborted) done();
        else config.signal.addEventListener("abort", done, { once: true });
      });
      continue;
    }
    const current = job,
      path = `/internal/runtime/mcp/${current.id}`,
      controller = new AbortController();
    const signal = AbortSignal.any([
      config.signal,
      controller.signal,
      AbortSignal.timeout(Math.max(1, current.deadline - Date.now())),
    ]);
    const heartbeat = setInterval(() => {
      void post(`${path}/heartbeat`, { leaseToken: current.leaseToken }, signal).catch(() =>
        controller.abort(),
      );
    }, 4000);
    try {
      const tools = await discoverMcp(current, signal);
      await post(
        `${path}/finish`,
        { leaseToken: current.leaseToken, status: "succeeded", tools },
        signal,
      );
    } catch (error) {
      controller.abort();
      const code = error instanceof Error ? error.message : "MCP_CONNECTION_FAILED";
      const errorCode =
        Date.now() >= current.deadline
          ? "TIMEOUT"
          : ["MCP_DISCOVERY_INVALID", "MCP_LIMIT"].includes(code)
            ? code
            : "MCP_CONNECTION_FAILED";
      await post(
        `${path}/finish`,
        { leaseToken: current.leaseToken, status: "failed", errorCode },
        AbortSignal.timeout(8000),
      ).catch(() => {
        /* Lost leases and disabled services are finalized by the control plane. */
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
