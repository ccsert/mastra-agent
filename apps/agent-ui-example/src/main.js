import { createAgentApplication, serveAgentApplication } from "@platform/agent-ui";
import manifest from "./manifest.json";
import "./style.css";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);
const orders = [
  { id: "ORD-1001", customer: "青山科技", total: "¥ 18,600" },
  { id: "ORD-1002", customer: "星河制造", total: "¥ 42,800" },
  { id: "ORD-1003", customer: "云帆设计", total: "¥ 9,200" },
];
let query = "",
  selected = null,
  note = "",
  priority = "normal",
  validation = "",
  dirty = false;
const visible = () =>
  orders.filter((order) =>
    `${order.id} ${order.customer}`.toLowerCase().includes(query.toLowerCase()),
  );
function render() {
  elements.orders.replaceChildren(
    ...visible().map((order) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `order${selected?.id === order.id ? " selected" : ""}`;
      button.textContent = `${order.id} · ${order.customer}    ${order.total}`;
      button.onclick = () => {
        try {
          open(order.id);
        } catch (e) {
          elements.connection.textContent = e.message;
        }
      };
      return button;
    }),
  );
  elements.details.hidden = !selected;
  elements["order-title"].textContent = selected ? `${selected.id} · ${selected.customer}` : "";
  elements.dirty.textContent = dirty ? "未保存草稿" : "未修改";
  elements.validation.textContent = validation;
  elements.search.value = query;
  elements.note.value = note;
  elements.priority.value = priority;
}
function search(value) {
  query = value;
  render();
  return `已筛选 ${visible().length} 条订单`;
}
function open(id) {
  if (!visible().some((o) => o.id === id)) throw new Error("ORDER_NOT_VISIBLE");
  if (dirty && selected?.id !== id) throw new Error("UNSAVED_DRAFT");
  selected = orders.find((o) => o.id === id);
  render();
  return `已打开 ${id}`;
}
function patch(values) {
  if (!selected) throw new Error("SELECT_ORDER_FIRST");
  if (values.note !== undefined) note = values.note;
  if (values.priority !== undefined) priority = values.priority;
  dirty = true;
  validation = "";
  render();
  return `已修改 ${selected.id} 的未保存草稿`;
}
function validate() {
  validation = priority === "urgent" && !note.trim() ? "紧急订单需要填写交付备注" : "草稿检查通过";
  render();
  return validation;
}
elements.search.oninput = () => search(elements.search.value);
elements.note.oninput = () => patch({ note: elements.note.value });
elements.priority.onchange = () => patch({ priority: elements.priority.value });
const handler =
  (run) =>
  async (args, { signal }) => {
    signal.throwIfAborted();
    const message = run(args);
    return { output: { message }, message };
  };
const application = createAgentApplication({
  manifest,
  observe: () => ({
    page: {
      id: selected ? "order.detail" : "orders.list",
      title: selected ? `${selected.id} 详情` : "订单列表",
    },
    ready: true,
    summary: "订单演示应用；所有数据均为合成数据，草稿不持久化。",
    state: {
      query,
      orders: visible(),
      selected: selected?.id ?? null,
      draft: selected ? { note, priority, dirty, validation } : null,
    },
    actions: manifest.actions.map((a) => ({
      id: a.id,
      available: !a.id.startsWith("orders.draft.") || !!selected,
    })),
  }),
  handlers: {
    "orders.search": handler(({ query }) => search(query)),
    "orders.open": handler(({ orderId }) => open(orderId)),
    "orders.draft.patch": handler(patch),
    "orders.draft.validate": handler(validate),
  },
  onStatus: ({ running, title }) => {
    document.body.classList.toggle("agent-acting", running);
    elements.activity.hidden = !running;
    elements.activity.textContent = `平台助手 · ${title}`;
  },
});
const requestedOrigin =
  new URLSearchParams(location.search).get("hostOrigin") ?? "http://127.0.0.1:5179";
const allowedOrigins = ["http://127.0.0.1:5179", "http://localhost:5179"];
if (!allowedOrigins.includes(requestedOrigin)) throw new Error("HOST_ORIGIN_NOT_ALLOWED");
const bridge = serveAgentApplication({
  application,
  hostWindow: window.parent,
  hostOrigin: requestedOrigin,
  authorize: (draft) => elements.grant.checked && (!draft || elements["draft-grant"].checked),
  onConnection: (connected) => {
    elements.connection.textContent = connected
      ? "已连接平台助手 · 可随时停止或直接手动修改"
      : "未连接平台助手";
  },
});
elements.stop.onclick = () => {
  bridge.stop();
  elements.grant.checked = false;
  elements["draft-grant"].checked = false;
};
elements.grant.onchange = () => bridge.stop();
elements["draft-grant"].onchange = () => bridge.stop();
elements.registration.value = JSON.stringify({ url: "http://127.0.0.1:5181/", manifest }, null, 2);
render();
