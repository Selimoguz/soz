// fake-erp.ts — A pretend ERP as an MCP server over stdio, for testing the gateway. It does
// whatever it is told: checking is the gateway's job.

import { createInterface } from "node:readline";

type Obj = Record<string, unknown>;
const orders: Obj[] = [];
const send = (m: Obj) => process.stdout.write(JSON.stringify(m) + "\n");
const text = (s: string, isError = false) => ({ content: [{ type: "text", text: s }], isError });
const prop = (type: string, description: string, extra: Obj = {}) => ({ type, description, ...extra });

const tools = [
  { name: "find_customer", description: "Find a customer by name: code, title, balance and credit limit.",
    inputSchema: { type: "object", properties: { name: prop("string", "Customer name") }, required: ["name"] },
    annotations: { readOnlyHint: true } },
  { name: "list_orders", description: "All order lines entered so far.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "get_order", description: "An order and its status.",
    inputSchema: { type: "object", properties: { id: prop("string", "Order id") }, required: ["id"] },
    outputSchema: { type: "object", required: ["id", "status"],
                    properties: { id: { type: "string" }, status: { type: "string", enum: ["open", "shipped"] } } },
    annotations: { readOnlyHint: true } },
  { name: "cancel_order", description: "Cancel an order.",
    inputSchema: { type: "object", properties: { order: prop("string", "Order id") }, required: ["order"] } },
  { name: "add_order_line", description: "Add an order line for a customer.",
    inputSchema: { type: "object", required: ["customer", "product", "quantity"], properties: {
      customer: prop("string", "Customer code"), product: prop("string", "Product"),
      quantity: prop("number", "Quantity"), note: prop("string", "Free note") } } },
];

function call(name: string, args: Obj) {
  if (name === "find_customer")
    return String(args.name ?? "").toLowerCase().includes("yilmaz")
      ? text(JSON.stringify({ code: "C-1042", title: "Yilmaz Market", balance: 4200, limit: 10000 }))
      : text("no such customer", true);
  if (name === "list_orders") return text(JSON.stringify(orders));
  if (name === "get_order") return { ...text(""), structuredContent: { id: String(args.id), status: "open" } };
  if (name === "cancel_order") return text(JSON.stringify({ cancelled: args.order }));
  if (name === "add_order_line") {
    orders.push({ customer: args.customer, product: args.product, quantity: args.quantity });
    // An ERP that saves the line and then fails at something after it: the tool error does not
    // mean the write did not happen.
    if (args.product === "lemons") return text("order line saved, but its delivery note could not be printed", true);
    return text(JSON.stringify({ line: orders.length }));
  }
  return text("unknown tool", true);
}

createInterface({ input: process.stdin }).on("line", line => {
  let m: Obj;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined || typeof m.method !== "string") return;
  const params = (m.params ?? {}) as Obj;
  const result = m.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-erp", version: "1" } }
    : m.method === "tools/list" ? { tools }
    : m.method === "tools/call" ? call(String(params.name), (params.arguments ?? {}) as Obj)
    : {};
  send({ jsonrpc: "2.0", id: m.id, result });
});
