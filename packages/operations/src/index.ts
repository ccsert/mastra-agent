import { randomUUID } from "node:crypto";

export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing setting: ${name}`);
  return value;
}
export function requestId(value?: string | null) {
  return value && /^[a-zA-Z0-9_-]{8,80}$/.test(value) ? value : randomUUID();
}
export type LogEntry = {
  event:
    | "http_request"
    | "control_request_failed"
    | "started"
    | "stopping"
    | "stopped"
    | "startup_failed"
    | "cleanup_failed"
    | "completion_unacknowledged";
  requestId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  errorCode?: string;
  runtimeId?: string;
  jobId?: string;
};
export type Logger = (entry: LogEntry) => void;
/** Only named metadata fields are serialized. Never pass payloads, credentials or Error objects. */
export function createLogger(
  service: "control-plane" | "runtime",
  sink: (line: string) => void = console.log,
): Logger {
  return (entry) => {
    const { event, requestId, method, route, status, durationMs, errorCode, runtimeId, jobId } =
      entry;
    sink(
      JSON.stringify({
        time: new Date().toISOString(),
        service,
        event,
        requestId,
        method,
        route,
        status,
        durationMs,
        errorCode,
        runtimeId,
        jobId,
      }),
    );
  };
}

export { localConsoleOrigins } from "./console-origins.ts";
