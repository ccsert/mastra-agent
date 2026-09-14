import {
  AimOutlined,
  FullscreenOutlined,
  LeftOutlined,
  MinusOutlined,
  PlusOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { Button } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FULL_TIMELINE,
  intersects,
  panTimeline,
  type TimelineWindow,
  timelineMarks,
  timelineWindow,
  zoomTimeline,
} from "./timeline-window";
import type { TraceTimeline } from "./trajectory";

export function TrajectoryTimeline({
  timeline,
  selected,
  onSelect,
  mode,
  onWindowChange,
}: {
  timeline: TraceTimeline;
  selected?: string;
  onSelect(id: string): void;
  mode: "sequence" | "duration";
  /** Lets the owner scope on-demand event reads to the visible window. */
  onWindowChange?(window: TimelineWindow): void;
}) {
  const [window, setWindow] = useState(FULL_TIMELINE);
  const [selection, setSelection] = useState<TimelineWindow | null>(null);
  const [pixels, setPixels] = useState(800);
  const plot = useRef<HTMLFieldSetElement>(null);
  const drag = useRef<{
    x: number;
    point: number;
    moved: boolean;
    selection: TimelineWindow | null;
  } | null>(null);
  const suppressClick = useRef(false);
  const windowRef = useRef(window);
  windowRef.current = window;
  useEffect(() => {
    onWindowChange?.(window);
  }, [window, onWindowChange]);
  const width = window.end - window.start;
  const all = useMemo(() => timeline.flatMap((lane) => lane.spans), [timeline]);
  const marks = useMemo(
    () =>
      timeline.map((lane) => ({
        ...lane,
        marks: timelineMarks(lane.spans, window, pixels, selected),
      })),
    [timeline, window, pixels, selected],
  );
  const selectedSpans = useMemo(
    () => (selection ? all.filter((span) => intersects(span, selection)) : []),
    [all, selection],
  );
  useEffect(() => {
    const node = plot.current;
    if (!node) return;
    const resize = () => setPixels(node.clientWidth || 800);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const anchor = Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1)));
      setWindow((current) =>
        event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? panTimeline(current, (event.deltaX || event.deltaY) / (rect.width || 800))
          : zoomTimeline(
              current,
              Math.exp(Math.max(-0.7, Math.min(0.7, event.deltaY * 0.004))),
              anchor,
            ),
      );
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      node.removeEventListener("wheel", wheel);
    };
  }, []);
  function point(x: number) {
    const rect = plot.current?.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (x - (rect?.left ?? 0)) / (rect?.width || 800)));
    const current = windowRef.current;
    return current.start + ratio * (current.end - current.start);
  }
  function reset() {
    setWindow(FULL_TIMELINE);
    setSelection(null);
  }
  const brushLeft = selection ? Math.max(0, ((selection.start - window.start) / width) * 100) : 0;
  const brushRight = selection ? Math.min(100, ((selection.end - window.start) / width) * 100) : 0;
  return (
    <section className="trajectory-overview" aria-label="分类调用顺序概览">
      <div className="trace-timeline-controls">
        <span className="trace-timeline-hint">拖动框选 · 滚轮缩放 · Shift + 滚轮平移</span>
        <span className="trace-timeline-selection" role="status">
          {selection ? `已框选 ${selectedSpans.length} 条记录` : "全部范围"}
        </span>
        <Button
          size="small"
          type="text"
          aria-label="聚焦选区"
          icon={<AimOutlined aria-hidden />}
          disabled={!selection || !selectedSpans.length}
          onClick={() => selection && setWindow(selection)}
        >
          聚焦选区
        </Button>
        <Button
          size="small"
          type="text"
          aria-label="向前平移时间轴"
          icon={<LeftOutlined />}
          disabled={window.start === 0}
          onClick={() => setWindow(panTimeline(window, -0.3))}
        />
        <Button
          size="small"
          type="text"
          aria-label="缩小时间轴"
          icon={<MinusOutlined />}
          disabled={width >= 100}
          onClick={() => setWindow(zoomTimeline(window, 2))}
        />
        <output aria-label="时间轴缩放比例">{(100 / width).toFixed(1)}×</output>
        <Button
          size="small"
          type="text"
          aria-label="放大时间轴"
          icon={<PlusOutlined />}
          disabled={width <= 0.05}
          onClick={() => setWindow(zoomTimeline(window, 0.5))}
        />
        <Button
          size="small"
          type="text"
          aria-label="向后平移时间轴"
          icon={<RightOutlined />}
          disabled={window.end === 100}
          onClick={() => setWindow(panTimeline(window, 0.3))}
        />
        <Button
          size="small"
          type="text"
          aria-label="复位"
          icon={<FullscreenOutlined aria-hidden />}
          onClick={reset}
        >
          复位
        </Button>
      </div>
      <fieldset
        ref={plot}
        className="trace-timeline-plot"
        aria-label="时间轴，拖动框选，滚轮缩放"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The brush/zoom surface supports keyboard navigation in addition to its buttons.
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (["+", "=", "-", "ArrowLeft", "ArrowRight", "Home", "Escape"].includes(event.key))
            event.preventDefault();
          if (["+", "="].includes(event.key)) setWindow(zoomTimeline(window, 0.5));
          if (event.key === "-") setWindow(zoomTimeline(window, 2));
          if (event.key === "ArrowLeft") setWindow(panTimeline(window, -0.2));
          if (event.key === "ArrowRight") setWindow(panTimeline(window, 0.2));
          if (event.key === "Home") reset();
          if (event.key === "Escape") {
            drag.current = null;
            setSelection(null);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          suppressClick.current = false;
          drag.current = { x: event.clientX, point: point(event.clientX), moved: false, selection };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          if (!current.moved && Math.abs(event.clientX - current.x) < 4) return;
          current.moved = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setSelection(timelineWindow(current.point, point(event.clientX)));
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          drag.current = null;
          if (event.currentTarget.hasPointerCapture?.(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          if (!current?.moved) return;
          suppressClick.current = true;
          const next = timelineWindow(current.point, point(event.clientX));
          setSelection(next);
          const first = all
            .filter((span) => intersects(span, next))
            .sort((a, b) => a.left - b.left)[0];
          if (first) onSelect(first.record.id);
          event.currentTarget.focus({ preventScroll: true });
        }}
        onPointerCancel={() => {
          if (drag.current) setSelection(drag.current.selection);
          drag.current = null;
          suppressClick.current = true;
        }}
        onClickCapture={(event) => {
          if (suppressClick.current && event.detail > 0) {
            event.preventDefault();
            event.stopPropagation();
          }
          suppressClick.current = false;
        }}
      >
        {marks.map(({ lane, tracks, marks: segments }) => (
          <div
            className="trace-lane"
            key={lane}
            style={{ height: Math.max(18, Math.min(3, tracks) * 6 + 5) }}
          >
            <span>{lane}</span>
            <div className="trace-track" style={{ height: Math.min(3, tracks) * 6 }}>
              {segments.map(({ record, left, width: markWidth, track, count, end }) => (
                <button
                  key={record.id}
                  type="button"
                  style={{
                    left: `min(calc(100% - 2px), ${left}%)`,
                    width: `max(2px, ${markWidth}%)`,
                    top: 1 + track * 6,
                  }}
                  aria-label={
                    count > 1
                      ? `缩放查看 ${count} 条${lane}记录`
                      : `定位 ${record.title}${record.scopeName ? ` · ${record.scopeName}` : ""}${record.turn ? ` · 第 ${record.turn} 轮` : ""}`
                  }
                  title={
                    count > 1
                      ? `${count} 条记录，点击放大`
                      : `${record.turn ? `第 ${record.turn} 轮 · ` : ""}${record.title}${record.scopeName ? ` · ${record.scopeName}` : ""}`
                  }
                  className={`trace-segment ${record.kind}${selected === record.id ? " selected" : ""}${selection && !intersects({ record, left: window.start + (left / 100) * width, width: end - (window.start + (left / 100) * width), track }, selection) ? " outside-selection" : ""}${count > 1 ? " clustered" : ""}`}
                  onClick={() => {
                    if (count === 1) onSelect(record.id);
                    else {
                      const start = window.start + (left / 100) * width;
                      const padding = Math.max(0.025, (end - start) * 0.15);
                      setWindow(timelineWindow(start - padding, end + padding));
                      onSelect(record.id);
                    }
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        {selection && brushRight > brushLeft && (
          <div
            className="trace-timeline-brush"
            aria-hidden="true"
            style={{ left: `${brushLeft}%`, width: `${brushRight - brushLeft}%` }}
          />
        )}
      </fieldset>
      <div className="trace-timeline-ruler" aria-hidden="true">
        <span>{window.start.toFixed(1)}%</span>
        <span>{((window.start + window.end) / 2).toFixed(1)}%</span>
        <span>{window.end.toFixed(1)}%</span>
      </div>
      {mode === "duration" && (
        <p className="trace-mode-note">
          优先使用 Runtime 请求与工具实测时间；历史记录回退到事件时间，详情中标明来源。
        </p>
      )}
    </section>
  );
}
