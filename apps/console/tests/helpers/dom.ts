import { after } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://console.test",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLBodyElement",
  "Element",
  "Node",
  "ShadowRoot",
  "SVGElement",
  "HTMLInputElement",
  "MutationObserver",
  "Event",
  "MouseEvent",
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === "window" ? window : Reflect.get(window, name),
  });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  writable: true,
  value: true,
});
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: (element: Element) => window.getComputedStyle(element),
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: window.requestAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: window.cancelAnimationFrame.bind(window),
});
// jsdom has no layout engine; exercise the chat lifecycle without emulating scrolling geometry.
window.HTMLElement.prototype.scrollTo = () => {};
window.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return false;
  },
});
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

// Select uses MessageChannel for browser macrotasks; Node ports need explicit teardown.
const channels = new Set<MessageChannel>();
Object.defineProperty(globalThis, "MessageChannel", {
  configurable: true,
  value: class extends MessageChannel {
    constructor() {
      super();
      channels.add(this);
    }
  },
});
after(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  channels.clear();
  window.close();
});
