export interface WorkerConfig {
  controlPlaneUrl: string;
  runtimeId: string;
  runtimeToken: string;
  signal: AbortSignal;
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
  return async function post(path: string, body: unknown, signal: AbortSignal = config.signal) {
    const response = await fetch(config.controlPlaneUrl + path, {
      method: "POST",
      redirect: "error",
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
  };
}
