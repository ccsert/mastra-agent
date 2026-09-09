import { createLogger, type Logger, requestId } from "@platform/operations";
export interface WorkerConfig {
  controlPlaneUrl: string;
  runtimeId: string;
  runtimeToken: string;
  signal: AbortSignal;
  skillSandboxImage?: string;
  logger?: Logger;
  onContact?: (status: number) => void;
}
export const waitForPoll = (ms: number, signal: AbortSignal) =>
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
export function runtimeClient(config: WorkerConfig) {
  const log = config.logger ?? createLogger("runtime");
  return async function post(path: string, body: unknown, signal: AbortSignal = config.signal) {
    const id = requestId();
    const route = path.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, ":id");
    let status = 0;
    try {
      const response = await fetch(config.controlPlaneUrl + path, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.runtimeToken}`,
          "x-runtime-id": config.runtimeId,
          "x-request-id": id,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      status = response.status;
      const data = await response.json();
      config.onContact?.(status);
      if (!response.ok) throw new Error(`CONTROL_PLANE_${status}`);
      return data;
    } catch (error) {
      if (!signal.aborted) {
        config.onContact?.(status >= 200 && status < 300 ? 0 : status);
        log({
          event: "control_request_failed",
          requestId: id,
          route,
          status,
          runtimeId: config.runtimeId,
          errorCode: status ? `CONTROL_PLANE_${status}` : "CONTROL_PLANE_UNREACHABLE",
        });
      }
      throw error;
    }
  };
}
