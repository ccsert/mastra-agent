import { type ChildProcess, fork } from "node:child_process";
import { ParsedDocument, type z } from "@platform/contracts";
import { ApiError } from "../../infrastructure/errors.ts";

let running = 0;
/** Disposable parser processes bound parsing without sharing the API process's heap. */
export async function parseDocument(
  filename: string,
  bytes: Uint8Array,
  chunkSize: number,
  chunkOverlap: number,
): Promise<z.infer<typeof ParsedDocument>> {
  if (!bytes.length || bytes.length > 8 * 1024 * 1024)
    throw new ApiError(400, "DOCUMENT_SIZE", "文件须在 8 MiB 以内且不能为空");
  if (running >= 2) throw new ApiError(429, "PARSER_BUSY", "正在解析其他资料，请稍后重试");
  running++;
  let child: ChildProcess | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const development = import.meta.url.endsWith(".ts");
      child = fork(
        new URL(development ? "./parser-worker.ts" : "./parser-worker.js", import.meta.url),
        [],
        {
          execArgv: [
            "--max-old-space-size=512",
            ...(development ? ["--conditions=development"] : []),
          ],
          env: {},
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "advanced",
        },
      );
      const timer = setTimeout(
        () => reject(new ApiError(400, "PARSE_TIMEOUT", "文档解析超过 30 秒，请拆分后重试")),
        30000,
      );
      child.once("message", (message) => {
        clearTimeout(timer);
        if (message && typeof message === "object" && "error" in message && "message" in message)
          reject(new ApiError(400, String(message.error), String(message.message)));
        else {
          const parsed = ParsedDocument.safeParse(message);
          if (parsed.success) resolve(parsed.data);
          else
            reject(
              new ApiError(
                400,
                "DOCUMENT_TOO_LARGE",
                "解析结果超过 20 万字符或 256 个分段，请拆分资料",
              ),
            );
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new ApiError(400, "PARSE_FAILED", "无法启动文档解析，请稍后重试"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new ApiError(400, "PARSE_FAILED", "文件解析未完成，请拆分或重新导出文件"));
      });
      child.send({ filename, bytes, chunkSize, chunkOverlap });
    });
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await stopped;
    }
    running--;
  }
}
