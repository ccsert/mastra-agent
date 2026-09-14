import {
  AgentAppInvocation,
  AgentAppManifest,
  AgentAppOutcome,
  AgentAppView,
  canonicalJson,
  compileMcpSchema,
} from "@platform/contracts";
import { v4 as uuid } from "uuid";
export type Observation = Omit<AgentAppView, "appId" | "pageSessionId" | "revision">;
export type Handler = (
  args: Record<string, unknown>,
  context: { signal: AbortSignal },
) => Promise<{ output: Record<string, unknown>; message: string }>;
export function createAgentApplication(options: {
  manifest: AgentAppManifest;
  observe(): Observation;
  handlers: Record<string, Handler>;
  onStatus?(status: { running: boolean; title: string }): void;
}) {
  const manifest = AgentAppManifest.parse(options.manifest);
  const validators = new Map(
    manifest.actions.map((a) => [
      a.id,
      { input: compileMcpSchema(a.inputSchema), output: compileMcpSchema(a.outputSchema) },
    ]),
  );
  for (const action of manifest.actions)
    if (!options.handlers[action.id]) throw new Error(`缺少 handler: ${action.id}`);
  const pageSessionId = uuid();
  let signature = "",
    revision = uuid(),
    enabled = false,
    allowDraft = false;
  let active: AbortController | undefined;
  const receipts = new Map<string, { signature: string; result: Promise<AgentAppOutcome> }>();
  const observe = (): AgentAppView => {
    const observed = options.observe();
    const next = canonicalJson(observed);
    if (signature !== next) {
      signature = next;
      revision = uuid();
    }
    return AgentAppView.parse({ ...observed, appId: manifest.appId, pageSessionId, revision });
  };
  const stop = () => {
    enabled = false;
    active?.abort();
  };
  const invoke = async (
    raw: AgentAppInvocation,
    signal?: AbortSignal,
  ): Promise<AgentAppOutcome> => {
    const input = AgentAppInvocation.parse(raw),
      key = canonicalJson(input),
      prior = receipts.get(input.requestId);
    if (prior) {
      if (prior.signature !== key) throw new Error("IDEMPOTENCY_CONFLICT");
      return prior.result;
    }
    if (receipts.size >= 2000) throw new Error("SESSION_LIMIT");
    const result = (async (): Promise<AgentAppOutcome> => {
      let started = false;
      const controller = new AbortController();
      try {
        if (!enabled) throw new Error("NOT_CONNECTED");
        if (active) throw new Error("PAGE_BUSY");
        signal?.throwIfAborted();
        const action = manifest.actions.find((a) => a.id === input.action),
          view = observe();
        if (!action) throw new Error("UNKNOWN_ACTION");
        if (action.effect === "draft" && !allowDraft) throw new Error("DRAFT_NOT_GRANTED");
        if (!view.ready) throw new Error("NOT_READY");
        if (!view.actions.some((a) => a.id === input.action && a.available))
          throw new Error("ACTION_UNAVAILABLE");
        if (view.revision !== input.expectedRevision) throw new Error("STALE_REVISION");
        if (!validators.get(action.id)?.input(input.args)) throw new Error("INVALID_INPUT");
        active = controller;
        const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
        options.onStatus?.({ running: true, title: action.title });
        // The app indicator must paint before its handler changes the page.
        if (typeof requestAnimationFrame !== "undefined")
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        combined.throwIfAborted();
        if (observe().revision !== input.expectedRevision) throw new Error("STALE_REVISION");
        started = true;
        const output = await options.handlers[action.id](input.args, { signal: combined });
        combined.throwIfAborted();
        if (!validators.get(action.id)?.output(output.output)) throw new Error("INVALID_OUTPUT");
        return AgentAppOutcome.parse({
          status: "succeeded",
          ...output,
          view: observe(),
          uiApplied: true,
          persistence: "not-requested",
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "APP_ERROR";
        return AgentAppOutcome.parse({
          status: started ? "unknown" : "failed",
          code: code.slice(0, 80),
          message: started
            ? "动作已开始但结果未确认，请核对当前页面，不能自动重放"
            : code.slice(0, 1000),
          output: {},
          view: observe(),
          uiApplied: false,
          persistence: "not-requested",
        });
      } finally {
        if (active === controller) {
          active = undefined;
          options.onStatus?.({ running: false, title: "页面操作已结束" });
        }
      }
    })();
    receipts.set(input.requestId, { signature: key, result });
    // Do not evict request IDs and accidentally make an old action replayable.
    return result;
  };
  return {
    manifest,
    observe,
    invoke,
    stop,
    enable(draft = false) {
      if (receipts.size >= 2000) throw new Error("SESSION_LIMIT");
      enabled = true;
      allowDraft = draft;
    },
  };
}
export type AgentApplication = ReturnType<typeof createAgentApplication>;
