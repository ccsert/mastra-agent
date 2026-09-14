import {
  AimOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { BorderBeam, Button } from "antd";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePageActions, usePageActivity } from "../../shared/PageActions";

export function PageActivitySummary() {
  const activity = usePageActivity(),
    registry = usePageActions();
  if (!activity) return null;
  const running = activity.status === "running";
  const step = activity.steps.at(-1);
  return (
    <div className="page-activity-summary">
      <div className="page-activity-heading" role="status" aria-live="polite">
        {running ? (
          <LoadingOutlined />
        ) : activity.status === "succeeded" ? (
          <CheckCircleOutlined />
        ) : (
          <WarningOutlined />
        )}
        <span>
          {running
            ? step && ["applying", "verifying"].includes(step.status)
              ? `${step.status === "verifying" ? "正在核对" : "正在操作"} · ${step.label}`
              : activity.message
            : activity.message}
        </span>
      </div>
      {activity.steps.length > 0 && (
        <details>
          <summary>
            本次操作 · {activity.steps.filter((s) => s.status === "applied").length} 项已核对
          </summary>
          <ol>
            {activity.steps.map((item) => (
              <li key={item.id}>
                <strong>{item.label}</strong>
                <span>
                  {
                    {
                      applying: "正在操作",
                      verifying: "正在核对",
                      applied: "已核对",
                      unknown: "结果未确认",
                      "not-applied": "未执行",
                    }[item.status]
                  }
                </span>
                {item.status === "applied" &&
                  item.before !== undefined &&
                  item.after !== undefined && (
                    <div className="page-change-values">
                      <del>{item.before || "空"}</del>
                      <span>→</span>
                      <ins>{item.after || "空"}</ins>
                    </div>
                  )}
                {registry?.pageKey() === activity.pageKey && (
                  <Button
                    type="text"
                    size="small"
                    icon={<AimOutlined />}
                    onClick={() => {
                      registry
                        .locate(item.target)
                        ?.scrollIntoView({ block: "nearest", behavior: "auto" });
                    }}
                  >
                    定位
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** Targets are registered by the application. The model never supplies selectors or coordinates. */
export function PageOperationFeedback() {
  const registry = usePageActions(),
    activity = usePageActivity();
  const step = activity?.steps.at(-1);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number }>();
  useEffect(() => {
    setRect(undefined);
    if (!registry || activity?.status !== "running" || !step) return;
    let frame = 0;
    const element = registry.locate(step.target);
    if (!element) return;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = element.getBoundingClientRect();
        // Clamp to its scroll containers: an offscreen field must not highlight the toolbar.
        let top = Math.max(0, box.top),
          left = Math.max(0, box.left);
        let right = Math.min(window.innerWidth, box.right),
          bottom = Math.min(window.innerHeight, box.bottom);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
            const bounds = parent.getBoundingClientRect();
            top = Math.max(top, bounds.top);
            left = Math.max(left, bounds.left);
            right = Math.min(right, bounds.right);
            bottom = Math.min(bottom, bounds.bottom);
          }
        }
        setRect(
          right > left && bottom > top
            ? { top, left, width: right - left, height: bottom - top }
            : undefined,
        );
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [registry, activity?.status, step]);
  if (
    !rect ||
    activity?.status !== "running" ||
    !step ||
    !["applying", "verifying"].includes(step.status)
  )
    return null;
  return createPortal(
    <div className="page-action-highlight" aria-hidden="true" style={rect}>
      <BorderBeam duration={2} size={60}>
        <div className="page-action-highlight-border" />
      </BorderBeam>
      <span className={`page-action-caption${rect.top < 100 ? " below" : ""}`}>
        <LoadingOutlined /> {step.status === "verifying" ? "正在核对" : "助手操作"} · {step.label}
      </span>
    </div>,
    document.body,
  );
}
