import {
  createAgentApplication,
  platformAppManifest,
  platformAppOperations,
} from "@platform/agent-ui";
import type { usePageActions } from "../../shared/PageActions";

export function createPlatformApplication(
  registry: NonNullable<ReturnType<typeof usePageActions>>,
  onStatus: (status: { running: boolean; title: string }) => void,
) {
  return createAgentApplication({
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
}
