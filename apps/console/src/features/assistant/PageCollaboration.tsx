import { BorderOutlined, CheckCircleOutlined, ControlOutlined } from "@ant-design/icons";
import * as api from "@platform/sdk";
import { Alert, BorderBeam, Button, Switch } from "antd";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { v4 as uuid } from "uuid";
import { unwrap } from "../../shared/api";
import { usePageActions } from "../../shared/PageActions";

export function PageCollaboration({
  projectId,
  conversationId,
  onReveal,
}: {
  projectId: string;
  conversationId: string;
  onReveal(): void;
}) {
  const registry = usePageActions();
  const [enabled, setEnabled] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [acting, setActing] = useState(false);
  const [clientId, setClientId] = useState(() => uuid());
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  const stop = useRef<AbortController | undefined>(undefined);
  const disable = () => {
    stop.current?.abort();
    setEnabled(false);
    setActing(false);
  };
  useEffect(() => {
    if (!enabled || !registry) return;
    const controller = new AbortController();
    stop.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const path = { projectId, id: conversationId };
    const tick = async (grant = false) => {
      if (controller.signal.aborted) return;
      try {
        if (document.visibilityState === "hidden") throw new Error("窗口已隐藏，页面协作已停止");
        const synced = await unwrap(
          api.syncAssistantUi({
            path,
            body: { clientId, enabled: true, grant, view: registry.view() },
            signal: controller.signal,
          }),
        );
        if (!synced.active) throw new Error("页面连接已过期，请重新开启页面协作");
        const action = synced.action;
        if (action) {
          controller.signal.throwIfAborted();
          setActing(true);
          setStatus(
            action.input.operation === "navigate" ? "助手正在打开页面" : "助手正在操作页面",
          );
          reveal.current();
          // Give the status and beam one paint before invoking the registered handler.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          let outcome: "succeeded" | "failed" = "succeeded",
            message: string;
          try {
            message = await registry.perform(action.input, controller.signal);
          } catch (e) {
            outcome = "failed";
            message = e instanceof Error ? e.message : "页面操作失败";
          }
          controller.signal.throwIfAborted();
          // Keep quick operations perceptible and capture newly mounted controls in the receipt.
          await new Promise<void>((resolve) => setTimeout(resolve, 600));
          controller.signal.throwIfAborted();
          const receipt = await unwrap(
            api.completeAssistantUi({
              path: { ...path, actionId: action.id },
              body: { clientId, status: outcome, message, view: registry.view() },
              signal: controller.signal,
            }),
          );
          if (!receipt) throw new Error("页面回执缺失");
          setStatus(
            receipt.status === "succeeded"
              ? message
              : String(receipt.result?.message ?? "动作未完成"),
          );
          setActing(false);
        } else if (grant) setStatus("页面协作已开启");
        if (!controller.signal.aborted) timer = setTimeout(() => void tick(), 650);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "页面连接失败");
          setEnabled(false);
          setActing(false);
        }
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        controller.abort();
        setEnabled(false);
        setActing(false);
        setStatus("窗口已隐藏，页面协作已停止");
      }
    };
    document.addEventListener("visibilitychange", visibility);
    void tick(true);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      // The short server lease also revokes access if this request cannot be delivered.
      void api
        .syncAssistantUi({ path, body: { clientId, enabled: false, view: registry.view() } })
        .catch(() => {});
    };
  }, [enabled, registry, projectId, conversationId, clientId]);
  if (!registry) return null;
  return (
    <>
      <div className="assistant-ui-toggle">
        <ControlOutlined />{" "}
        <span>
          页面协作<small>导航、搜索、切换视图、填写草稿</small>
        </span>
        <Switch
          aria-label="页面协作"
          checked={enabled}
          onChange={(next) => {
            if (!next) disable();
            else {
              setError("");
              setClientId(uuid());
              setEnabled(true);
            }
          }}
        />
      </div>
      {error && <Alert type="warning" title={error} closable={{ onClose: () => setError("") }} />}
      {enabled &&
        createPortal(
          <div className="assistant-ui-overlay">
            {acting && (
              <BorderBeam
                className="assistant-ui-beam"
                color={[
                  { color: "#1677ff", percent: 0 },
                  { color: "#9254de", percent: 100 },
                ]}
                duration={3}
                size="28%"
                lineWidth={2}
              >
                <div className="assistant-ui-frame" />
              </BorderBeam>
            )}
            <div className={`assistant-ui-status${acting ? " is-acting" : ""}`} role="status">
              {acting ? <ControlOutlined /> : <CheckCircleOutlined />}
              <span>{status || "正在连接页面"}</span>
              <Button size="small" icon={<BorderOutlined />} onClick={disable}>
                停止页面协作
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
