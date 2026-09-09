import { App } from "antd";
import { useCallback, useEffect, useRef } from "react";
import { useBeforeUnload, useBlocker } from "react-router";

type Guard = () => "busy" | "dirty" | null;
/** One guard covers links, project changes, programmatic navigation and browser POP history. */
export function useNavigationGuard() {
  const { message, modal } = App.useApp();
  const guard = useRef<Guard | undefined>(undefined);
  const bypass = useRef(false);
  const registerGuard = useCallback((next?: Guard) => {
    guard.current = next;
  }, []);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !bypass.current && currentLocation.pathname !== nextLocation.pathname && !!guard.current?.(),
  );
  useBeforeUnload(
    useCallback((event) => {
      if (guard.current?.()) {
        event.preventDefault();
        event.returnValue = "";
      }
    }, []),
  );
  const current = useRef({ blocker, modal, message });
  current.current = { blocker, modal, message };
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const { blocker: blocked, modal, message } = current.current;
    if (blocked.state !== "blocked") return;
    if (guard.current?.() === "busy") {
      message.info("请等待当前工作流操作完成");
      blocked.reset();
      return;
    }
    // Keep one dialog even if another POP/PUSH changes the pending destination.
    const dialog = modal.confirm({
      title: "离开未保存的草稿？",
      content: "当前修改尚未保存，可以先保存后再离开。",
      okText: "离开",
      cancelText: "继续编辑",
      onOk: () => {
        const next = current.current.blocker;
        if (next.state === "blocked") next.proceed();
      },
      onCancel: () => {
        const next = current.current.blocker;
        if (next.state === "blocked") next.reset();
      },
    });
    return () => dialog.destroy();
  }, [blocker.state]);
  const confirmExit = async (action: () => Promise<void>) => {
    const reason = guard.current?.();
    if (reason === "busy") {
      message.info("请等待当前工作流操作完成");
      return;
    }
    if (
      reason === "dirty" &&
      !(await modal.confirm({
        title: "离开未保存的草稿？",
        content: "当前修改尚未保存，可以先保存后再离开。",
        okText: "离开",
        cancelText: "继续编辑",
      }))
    )
      return;
    bypass.current = true;
    try {
      await action();
    } finally {
      bypass.current = false;
    }
  };
  return { registerGuard, confirmExit };
}
