import {
  type AgentAppInvocation,
  AgentAppManifest,
  AgentAppOutcome,
  AgentAppView,
  canonicalJson,
} from "@platform/contracts";
import { v4 as uuid } from "uuid";
import type { AgentApplication } from "./application.ts";

const protocol = "platform-agent-app/1.0";
type Packet = {
  protocol: string;
  channel: string;
  id: string;
  method?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
};
function packet(value: unknown): Packet | undefined {
  if (!value || typeof value !== "object") return;
  const p = value as Packet;
  if (
    p.protocol !== protocol ||
    typeof p.channel !== "string" ||
    typeof p.id !== "string" ||
    p.channel.length > 80 ||
    p.id.length > 80
  )
    return;
  return p;
}
function exactOrigin(origin: string) {
  if (new URL(origin).origin !== origin || origin === "null") throw new Error("INVALID_ORIGIN");
  return origin;
}
/** Install in the application. Authorization belongs to the application and its user. */
export function serveAgentApplication(options: {
  application: AgentApplication;
  hostWindow: Window;
  hostOrigin: string;
  authorize(allowDraft: boolean): boolean;
  onConnection?(connected: boolean): void;
}) {
  const origin = exactOrigin(options.hostOrigin),
    app = options.application;
  let channel: string | undefined,
    contact = 0,
    allowDraft = false;
  const send = (p: Omit<Packet, "protocol">) =>
    options.hostWindow.postMessage({ protocol, ...p }, origin);
  const stop = () => {
    app.stop();
    if (channel) send({ channel, id: "stopped", error: "APP_DISCONNECTED" });
    channel = undefined;
    options.onConnection?.(false);
  };
  const listener = async (event: MessageEvent) => {
    if (event.source !== options.hostWindow || event.origin !== origin) return;
    const p = packet(event.data);
    if (!p) return;
    try {
      if (p.method === "connect") {
        const draft = !!(
          p.args &&
          typeof p.args === "object" &&
          "allowDraft" in p.args &&
          p.args.allowDraft === true
        );
        if (channel && channel !== p.channel) throw new Error("APP_IN_USE");
        if (!options.authorize(draft) || document.visibilityState === "hidden")
          throw new Error("APP_USER_GRANT_REQUIRED");
        channel = p.channel;
        app.enable(draft);
        allowDraft = draft;
        contact = Date.now();
        options.onConnection?.(true);
        send({ channel, id: p.id, result: { manifest: app.manifest, view: app.observe() } });
        return;
      }
      if (channel !== p.channel) return;
      if (
        Date.now() - contact > 8000 ||
        document.visibilityState === "hidden" ||
        !options.authorize(allowDraft)
      ) {
        stop();
        return;
      }
      contact = Date.now();
      if (p.method === "stop") {
        stop();
        return;
      }
      const result =
        p.method === "observe"
          ? app.observe()
          : p.method === "invoke"
            ? await app.invoke(p.args as AgentAppInvocation)
            : undefined;
      if (result === undefined) throw new Error("UNKNOWN_METHOD");
      if (channel === p.channel) send({ channel, id: p.id, result });
    } catch (e) {
      send({
        channel: p.channel,
        id: p.id,
        error: e instanceof Error ? e.message.slice(0, 1000) : "APP_ERROR",
      });
    }
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") stop();
  };
  window.addEventListener("message", listener);
  window.addEventListener("pagehide", stop);
  document.addEventListener("visibilitychange", visibility);
  const timer = setInterval(() => {
    if (channel && Date.now() - contact > 8000) stop();
  }, 1000);
  return {
    stop,
    dispose() {
      stop();
      clearInterval(timer);
      window.removeEventListener("message", listener);
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}

/** Connect one explicitly selected frame. No DOM access or credentials cross the boundary. */
export async function connectAgentFrame(options: {
  frame: Window;
  origin: string;
  manifest: AgentAppManifest;
  allowDraft: boolean;
  signal: AbortSignal;
  onDisconnect?(): void;
}) {
  const origin = exactOrigin(options.origin),
    channel = uuid();
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let closed = false,
    connected = false;
  const send = (value: Record<string, unknown>) =>
    options.frame.postMessage({ protocol, channel, ...value }, origin);
  const stop = () => {
    if (closed) return;
    closed = true;
    send({ id: uuid(), method: "stop" });
    window.removeEventListener("message", listener);
    options.signal.removeEventListener("abort", stop);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("APP_DISCONNECTED"));
    }
    pending.clear();
    if (connected) options.onDisconnect?.();
  };
  const listener = (event: MessageEvent) => {
    if (event.source !== options.frame || event.origin !== origin) return;
    const p = packet(event.data);
    if (!p || p.channel !== channel) return;
    if (p.id === "stopped") {
      stop();
      return;
    }
    const request = pending.get(p.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(p.id);
    if (p.error) request.reject(new Error(p.error));
    else request.resolve(p.result);
  };
  const call = (method: string, args?: unknown): Promise<unknown> => {
    if (closed || options.signal.aborted) return Promise.reject(new Error("APP_DISCONNECTED"));
    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error("APP_REPLY_TIMEOUT"));
          if (method === "invoke") stop();
        },
        method === "invoke" ? 20000 : 5000,
      );
      pending.set(id, { resolve, reject, timer });
      send({ id, method, args });
    });
  };
  window.addEventListener("message", listener);
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    const raw = await call("connect", { allowDraft: options.allowDraft });
    if (!raw || typeof raw !== "object" || !("manifest" in raw) || !("view" in raw))
      throw new Error("INVALID_HANDSHAKE");
    const manifest = AgentAppManifest.parse(raw.manifest);
    if (canonicalJson(manifest) !== canonicalJson(options.manifest))
      throw new Error("APP_MANIFEST_CHANGED");
    const initial = AgentAppView.parse(raw.view);
    const check = (value: unknown) => {
      const view = AgentAppView.parse(value);
      if (view.appId !== manifest.appId || view.pageSessionId !== initial.pageSessionId)
        throw new Error("APP_SESSION_CHANGED");
      return view;
    };
    check(initial);
    connected = true;
    return {
      manifest,
      initial,
      stop,
      async observe() {
        return check(await call("observe"));
      },
      async invoke(input: AgentAppInvocation) {
        const result = AgentAppOutcome.parse(await call("invoke", input));
        check(result.view);
        return result;
      },
    };
  } catch (e) {
    stop();
    throw e;
  }
}
export type AgentFrameConnection = Awaited<ReturnType<typeof connectAgentFrame>>;
