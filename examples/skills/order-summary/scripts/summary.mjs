let input = "";
for await (const chunk of process.stdin) input += chunk;
const { orders } = JSON.parse(input);
if (!Array.isArray(orders) || !orders.length || orders.length > 100) throw new Error("Provide 1–100 orders");
const ids = new Set();
let cents = 0;
for (const order of orders) {
  if (typeof order.id !== "string" || !order.id || ids.has(order.id)) throw new Error("Order IDs must be non-empty and unique");
  if (typeof order.amount !== "number" || !Number.isFinite(order.amount) || order.amount < 0 || order.amount > 100000000) throw new Error("Invalid order amount");
  ids.add(order.id);
  cents += Math.round(order.amount * 100);
}
console.log(JSON.stringify({ source: "synthetic-input", count: orders.length, total: cents / 100, orders }));
