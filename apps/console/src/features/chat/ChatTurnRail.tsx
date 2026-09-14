import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TurnMark = { id: string; preview: string };

/**
 * ZCode-style question marks: one dash per user message beside the conversation.
 * Hovering previews the question; clicking scrolls the thread to that turn. The
 * list is read from the rendered thread so live and restored messages behave alike.
 * The rail overlays the scroll viewport through an absolutely positioned host
 * because a sticky host at the content end never re-enters the visible area.
 */
export function ChatTurnRail() {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement>();
  useEffect(() => {
    const viewport = anchor.current?.parentElement?.querySelector<HTMLElement>(
      '[data-slot="aui_thread-viewport"]',
    );
    const parent = viewport?.parentElement;
    if (!viewport || !parent) return;
    const element = document.createElement("div");
    element.className = "chat-turn-rail-host";
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const place = () => {
      element.style.top = `${viewport.offsetTop}px`;
      element.style.height = `${viewport.clientHeight}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(viewport);
    parent.appendChild(element);
    setHost(element);
    return () => {
      observer.disconnect();
      element.remove();
    };
  }, []);
  return (
    <>
      <span ref={anchor} hidden aria-hidden="true" />
      {host && createPortal(<RailMarks viewport={host.parentElement as HTMLElement} />, host)}
    </>
  );
}

function RailMarks({ viewport }: { viewport: HTMLElement }) {
  const [marks, setMarks] = useState<TurnMark[]>([]);
  const [active, setActive] = useState(-1);
  const nodes = useRef<HTMLElement[]>([]);
  useEffect(() => {
    const read = () => {
      const found = [...viewport.querySelectorAll<HTMLElement>('[data-role="user"]')];
      nodes.current = found;
      setMarks(
        found.map((node, index) => {
          const preview = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
          return { id: `${index}-${preview.slice(0, 24)}`, preview: preview || "（无文本输入）" };
        }),
      );
    };
    const onScroll = () => {
      const line = viewport.scrollTop + viewport.clientHeight * 0.3;
      let current = -1;
      nodes.current.forEach((node, index) => {
        if (node.offsetTop <= line) current = index;
      });
      setActive(current);
    };
    read();
    onScroll();
    const observer = new MutationObserver(read);
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [viewport]);
  const jump = (index: number) => {
    nodes.current[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // A single question needs no navigation rail.
  if (marks.length < 2) return null;
  return (
    <nav className="chat-turn-rail" aria-label="按提问跳转">
      {marks.map((mark, index) => (
        <button
          key={mark.id}
          type="button"
          className={`chat-turn-mark${index === active ? " active" : ""}`}
          onClick={() => jump(index)}
        >
          <span className="chat-turn-dash" aria-hidden="true" />
          <span className="chat-turn-pop" role="tooltip">
            <strong>第 {index + 1} 条提问</strong>
            {mark.preview}
          </span>
        </button>
      ))}
    </nav>
  );
}
