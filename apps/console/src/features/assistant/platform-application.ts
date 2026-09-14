import {
  AgentAppInvocation,
  AgentAppOutcome,
  canonicalJson,
  createAgentApplication,
  platformAppManifest,
  platformAppOperations,
} from "@platform/agent-ui";
import type { usePageActions } from "../../shared/PageActions";

export function createPlatformApplication(
  registry: NonNullable<ReturnType<typeof usePageActions>>,
  onStatus: (status: { running: boolean; title: string }) => void,
  awaitReceipt = false,
) {
  const app = createAgentApplication({
    manifest: platformAppManifest,
    onStatus,
    observe() {
      const view = registry.view();
      return {
        page: { id: view.page, title: view.page },
        ready: view.ready !== false,
        summary: "当前平台页面；表单修改均为未保存草稿",
        state: { platform: view },
        actions: platformAppManifest.actions.map((a) => ({
          id: a.id,
          available:
            view.ready !== false &&
            (a.id === "page.navigate" ||
              (a.id === "agent.create"
                ? view.targets.some((t) => t.id === "agent.create")
                : a.id === "agent.draft.patch"
                  ? view.targets.some((t) =>
                      ["agent.name", "agent.description", "agent.instructions"].includes(t.id),
                    )
                  : view.targets.some(
                      (t) =>
                        ![
                          "agent.create",
                          "agent.name",
                          "agent.description",
                          "agent.instructions",
                        ].includes(t.id),
                    ))),
        })),
      };
    },
    handlers: Object.fromEntries(
      platformAppManifest.actions.map((a) => [
        a.id,
        async (args, { signal }) => {
          const starting = registry.view();
          const operations = platformAppOperations(a.id, args, starting);
          const applied = new Map<string, string | undefined>();
          const assertDraftState = () => {
            if (a.id !== "agent.draft.patch") return;
            const current = registry.view();
            const expectedTargets = starting.targets.map((target) =>
              applied.has(target.id) ? { ...target, value: applied.get(target.id) } : target,
            );
            if (
              current.page !== starting.page ||
              current.resourceId !== starting.resourceId ||
              current.ready === false ||
              JSON.stringify(current.targets) !== JSON.stringify(expectedTargets)
            )
              throw new Error("用户或页面已修改草稿，停止剩余字段操作，请重新读取");
          };
          const messages: string[] = [];
          for (const operation of operations) {
            signal.throwIfAborted();
            assertDraftState();
            messages.push(
              await registry.perform(
                { ...operation, viewRevision: registry.view().revision },
                signal,
              ),
            );
            if (operation.operation === "act") applied.set(operation.target, operation.value);
            assertDraftState();
          }
          const message =
            a.id === "agent.draft.patch"
              ? `已填写 ${operations.length} 个 Agent 字段，草稿尚未保存`
              : messages.join("；");
          return { output: { message }, message };
        },
      ]),
    ),
  });
  // Keep the same enriched receipt for retries, including partially verified changes.
  // Input identity and the bounded session lifetime match the application SDK.
  const receipts = new Map<string, { signature: string; result: Promise<AgentAppOutcome> }>();
  return {
    ...app,
    async invoke(raw: AgentAppInvocation, signal?: AbortSignal): Promise<AgentAppOutcome> {
      const input = AgentAppInvocation.parse(raw),
        signature = canonicalJson(input);
      const prior = receipts.get(input.requestId);
      if (prior) {
        if (prior.signature !== signature) throw new Error("IDEMPOTENCY_CONFLICT");
        return prior.result;
      }
      if (receipts.size >= 2000) throw new Error("SESSION_LIMIT");
      // A rejected concurrent request must not replace the action the user is watching.
      const ownsActivity = registry.activity.getSnapshot()?.status !== "running";
      const result = (async () => {
        if (ownsActivity) {
          const title =
            platformAppManifest.actions.find((a) => a.id === input.action)?.title ?? "操作页面";
          registry.activity.begin(input.requestId, title, registry.pageKey());
        }
        try {
          const outcome = await app.invoke(input, signal);
          const activity = registry.activity.getSnapshot();
          const changes =
            input.action === "agent.draft.patch" && activity?.id === input.requestId
              ? activity.steps
                  .filter(
                    (s) =>
                      s.status === "applied" && s.before !== undefined && s.after !== undefined,
                  )
                  .map((s) => ({
                    target: s.target,
                    label: s.label,
                    before: s.before?.slice(0, 2000) ?? "",
                    after: s.after?.slice(0, 2000) ?? "",
                    truncated: (s.before?.length ?? 0) > 2000 || (s.after?.length ?? 0) > 2000,
                  }))
              : [];
          registry.activity.finish(
            input.requestId,
            awaitReceipt ? "running" : outcome.status,
            awaitReceipt ? "正在确认页面操作回执" : outcome.message,
          );
          return AgentAppOutcome.parse(
            changes.length ? { ...outcome, output: { ...outcome.output, changes } } : outcome,
          );
        } catch (error) {
          registry.activity.finish(input.requestId, "unknown", "页面结果未确认，请核对当前状态");
          throw error;
        }
      })();
      receipts.set(input.requestId, { signature, result });
      return result;
    },
  };
}
