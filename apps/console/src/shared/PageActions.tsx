import type { AssistantUiView } from "@platform/sdk";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { v4 as uuid } from "uuid";

import { createPageActivity, type PageActionStep } from "./page-action-activity";

type View = AssistantUiView;
type Target = View["targets"][number];
export type PageAction = Target & { execute(value?: string): void | Promise<void> };
type Registry = {
  activity: ReturnType<typeof createPageActivity>;
  locate(target: string): HTMLElement | undefined;
  pageKey(): string;
  register(key: symbol, read: () => PageAction[]): () => void;
  registerReady(key: symbol, read: () => boolean): () => void;
  view(): View;
  perform(input: Record<string, unknown>, signal: AbortSignal): Promise<string>;
};
const PageActions = createContext<Registry | null>(null);
export const usePageActions = () => useContext(PageActions);
const emptySubscribe = () => () => {};
const emptySnapshot = () => null;
export function usePageActivity() {
  const registry = usePageActions();
  return useSyncExternalStore(
    registry?.activity.subscribe ?? emptySubscribe,
    registry?.activity.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
}

export function usePageActionReadiness(ready: boolean) {
  const registry = usePageActions(),
    current = useRef(ready);
  current.current = ready;
  useEffect(() => registry?.registerReady(Symbol(), () => current.current), [registry]);
}

/** Only explicitly mounted handlers are visible to the assistant. No arbitrary DOM or JS. */
export function usePageActionTargets(targets: PageAction[]) {
  const registry = usePageActions(),
    current = useRef(targets);
  current.current = targets;
  useEffect(() => registry?.register(Symbol(), () => current.current), [registry]);
}

export function PageActionsProvider({
  children,
  page,
  resourceId,
  locationKey,
  targets = [],
  onNavigate,
}: {
  children: ReactNode;
  page: View["page"];
  resourceId?: string;
  locationKey: string;
  targets?: PageAction[];
  onNavigate(page: View["page"], id?: string): void | Promise<void>;
}) {
  const current = useRef({ page, resourceId, locationKey, targets, onNavigate });
  current.current = { page, resourceId, locationKey, targets, onNavigate };
  const entries = useRef(new Map<symbol, () => PageAction[]>());
  const readiness = useRef(new Map<symbol, () => boolean>());
  const cache = useRef({ signature: "", revision: uuid() });
  const register = useCallback((key: symbol, read: () => PageAction[]) => {
    entries.current.set(key, read);
    return () => {
      entries.current.delete(key);
    };
  }, []);
  const registry = useMemo<Registry>(() => {
    const activity = createPageActivity();
    const actions = () => [
      ...current.current.targets,
      ...[...entries.current.values()].flatMap((read) => read()),
    ];
    const view = (): View => {
      // A duplicate registration (e.g. an overlaid capability drawer) is ambiguous; expose neither.
      const all = actions();
      const targets = all
        .filter((t) => all.filter((other) => other.id === t.id).length === 1)
        .map(({ execute: _, ...target }) => target)
        .sort((a, b) => a.id.localeCompare(b.id));
      const next = {
        ready: [...readiness.current.values()].every((read) => read()),
        page: current.current.page,
        resourceId: current.current.resourceId,
        targets,
      };
      const signature = JSON.stringify([current.current.locationKey, next]);
      if (cache.current.signature !== signature) cache.current = { signature, revision: uuid() };
      return { ...next, revision: cache.current.revision };
    };
    return {
      activity,
      pageKey: () => current.current.locationKey,
      locate(target) {
        if (!actions().some((a) => a.id === target) && target !== "page") return;
        const matches = [...document.querySelectorAll<HTMLElement>("[data-agent-target]")].filter(
          (element) => element.dataset.agentTarget === target && !element.closest("[hidden]"),
        );
        return matches.length === 1 ? matches[0] : undefined;
      },
      register,
      registerReady(key, read) {
        readiness.current.set(key, read);
        return () => {
          readiness.current.delete(key);
        };
      },
      view,
      async perform(input, signal) {
        signal.throwIfAborted();
        if (input.viewRevision !== view().revision)
          throw new Error("页面已变化，动作未执行；请重新读取页面");
        const target = typeof input.target === "string" ? input.target : "page";
        const action =
          input.operation === "act" ? actions().find((a) => a.id === target) : undefined;
        const step: PageActionStep = {
          id: uuid(),
          target,
          label: action?.label ?? `打开${String(input.page ?? "页面")}`,
          ...(action?.value !== undefined ? { before: action.value } : {}),
          ...(typeof input.value === "string" ? { after: input.value } : {}),
          status: "applying",
        };
        let started = false;
        try {
          activity.step(step);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          signal.throwIfAborted();
          if (input.viewRevision !== view().revision)
            throw new Error("页面已变化，动作未执行；请重新读取页面");
          if (input.operation === "navigate") {
            if (typeof input.page !== "string") throw new Error("导航目标无效");
            started = true;
            await current.current.onNavigate(
              input.page as View["page"],
              typeof input.resourceId === "string" ? input.resourceId : undefined,
            );
          } else if (input.operation === "act") {
            const candidates = actions().filter((a) => a.id === input.target);
            if (candidates.length !== 1) throw new Error("当前页面操作目标不可用");
            const action = candidates[0],
              value = typeof input.value === "string" ? input.value : undefined;
            if (action.options && !action.options.includes(value ?? ""))
              throw new Error("无效的选项");
            started = true;
            await action.execute(value);
          } else throw new Error("不支持的页面操作");
          activity.step({ ...step, status: "verifying" });
          // Wait for React to commit and verify the visible state before acknowledging.
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          signal.throwIfAborted();
          const deadline = Date.now() + 4000;
          while (!view().ready && Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            signal.throwIfAborted();
          }
          const after = view();
          if (!after.ready) throw new Error("页面仍在加载，请稍后重新读取页面");
          if (
            input.operation === "navigate" &&
            (after.page !== input.page || after.resourceId !== input.resourceId)
          )
            throw new Error("导航没有完成");
          if (input.operation === "act" && typeof input.value === "string") {
            const target = after.targets.find((a) => a.id === input.target);
            if (!target || target.value !== input.value)
              throw new Error("字段未呈现预期值，请重新读取页面");
          }
          activity.step({ ...step, status: "applied" });
          return input.operation === "navigate"
            ? "页面已打开"
            : ["agent.name", "agent.description", "agent.instructions"].includes(
                  String(input.target),
                )
              ? "页面操作已完成；草稿字段尚未保存"
              : "页面视图已更新";
        } catch (error) {
          activity.step({ ...step, status: started ? "unknown" : "not-applied" });
          throw error;
        }
      },
    };
  }, [register]);
  return <PageActions.Provider value={registry}>{children}</PageActions.Provider>;
}
