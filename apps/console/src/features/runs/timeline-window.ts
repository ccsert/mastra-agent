import type { TraceSpan } from "./trajectory";

export type TimelineWindow = { start: number; end: number };
export const FULL_TIMELINE: TimelineWindow = { start: 0, end: 100 };
export function timelineWindow(start: number, end: number): TimelineWindow {
  const width = Math.min(100, Math.max(0.05, Math.abs(end - start)));
  const left = Math.min(100 - width, Math.max(0, Math.min(start, end)));
  return { start: left, end: left + width };
}
export function zoomTimeline(window: TimelineWindow, factor: number, anchor = 0.5) {
  const width = window.end - window.start;
  const next = Math.max(0.05, Math.min(100, width * factor));
  const point = window.start + width * anchor;
  return timelineWindow(point - next * anchor, point + next * (1 - anchor));
}
export function panTimeline(window: TimelineWindow, fraction: number) {
  const distance = (window.end - window.start) * fraction;
  return timelineWindow(window.start + distance, window.end + distance);
}
export function intersects(span: TraceSpan, window: TimelineWindow) {
  return span.left <= window.end && span.left + span.width >= window.start;
}
export type TimelineMark = TraceSpan & { count: number; end: number };
/** Cluster subpixel observations, not protocol events. Zoom restores individual
 * targets. The selected record always gets its own mark. */
export function timelineMarks(
  spans: TraceSpan[],
  window: TimelineWindow,
  pixels: number,
  selected?: string,
): TimelineMark[] {
  const width = window.end - window.start;
  const buckets = new Map<string, TimelineMark>();
  const cells = Math.max(1, Math.floor(pixels / 4));
  for (const span of spans) {
    if (!intersects(span, window)) continue;
    const left = Math.max(0, ((span.left - window.start) / width) * 100);
    const right = Math.min(100, ((span.left + span.width - window.start) / width) * 100);
    const track = Math.min(span.track, 2);
    const key =
      span.record.id === selected ? selected : `${track}:${Math.floor((left / 100) * cells)}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++;
      bucket.width = Math.max(bucket.width, right - bucket.left);
      bucket.end = Math.max(bucket.end, span.left + span.width);
    } else
      buckets.set(key, {
        ...span,
        track,
        left,
        width: right - left,
        count: 1,
        end: span.left + span.width,
      });
  }
  return [...buckets.values()];
}
