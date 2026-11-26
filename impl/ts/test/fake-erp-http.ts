// fake-erp-http.ts — The pretend ERP as an MCP server over streamable HTTP, for testing the gateway's
// HTTP client. Prints its port. It wants "Authorization: Bearer $FAKE_TOKEN", keeps sessions, answers
// tools/call as server-sent events (asking the client something first), everything else as JSON.
// POST /control {"mode": ...} makes it misbehave: "forget" (drops all sessions), "fail500" (records an
// order line, then answers 500), "fail422" (records an order line, then answers 422), "refuse403" (records
// nothing and answers 403), "slow" (add_order_line answers after 3 s), "lose-session" (forgets every
// session when add_order_line comes, and answers 404, once), "normal".

import { createServer } from "node:http";

type Obj = Record<string, unknown>;
const orders: Obj[] = [];
const sessions = new Set<string>();
let mode = "normal", nextSession = 0;
const text = (s: string, isError = false) => ({ content: [{ type: "text", text: s }], isError });
const tools = [
  { name: "find_customer", description: "Find a customer by name.", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "list_orders", description: "All order lines.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
  { name: "add_order_line", description: "Add an order line.",
    inputSchema: { type: "object", required: ["order_id", "customer", "product", "quantity"],
                   properties: { order_id: { type: "string" }, line_id: { type: "number" }, customer: { type: "string" },
                                 product: { type: "string" }, quantity: { type: "number" } } } },
];

function call(name: string, args: Obj) {
  if (name === "find_customer") return text(JSON.stringify({ code: "C-1042", title: "Yilmaz Market", balance: 4200, limit: 10000 }));
  if (name === "list_orders") return text(JSON.stringify(orders));
  if (name === "add_order_line") { orders.push({ order_id: args.order_id, line_id: args.line_id ?? null, customer: args.customer, product: args.product, quantity: args.quantity }); return text(JSON.stringify({ line: orders.length })); }
  return text("unknown tool", true);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += String(c); }).on("end", () => {
    if (req.url === "/control") { mode = (JSON.parse(body) as { mode: string }).mode; if (mode === "forget") { sessions.clear(); mode = "normal"; } res.writeHead(200); res.end("{}"); return; }
    if (req.headers.authorization !== `Bearer ${process.env.FAKE_TOKEN}`) { res.writeHead(401); res.end(); return; }
    if (req.method === "DELETE") { sessions.delete(String(req.headers["mcp-session-id"])); res.writeHead(200); res.end(); return; }
    let m: Obj;
    try { m = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
    if (m.method === "initialize") {
      const id = `s${++nextSession}`; sessions.add(id);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": id });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-erp-http", version: "1" } } }));
      return;
    }
    if (!sessions.has(String(req.headers["mcp-session-id"]))) { res.writeHead(404); res.end(); return; }
    if (req.headers["mcp-protocol-version"] !== "2025-06-18") { res.writeHead(400); res.end(); return; }
    if (m.id === undefined) { res.writeHead(202); res.end(); return; }          // notifications, and our declined questions
    const params = (m.params ?? {}) as Obj;
    if (m.method === "tools/list") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools } })); return; }
    if (m.method === "tools/call") {
      const name = String(params.name);
      if (mode === "fail500" && name === "add_order_line") { call(name, (params.arguments ?? {}) as Obj); res.writeHead(500); res.end(); return; }
      if (mode === "fail422" && name === "add_order_line") { call(name, (params.arguments ?? {}) as Obj); res.writeHead(422); res.end(); return; }
      if (mode === "refuse403" && name === "add_order_line") { res.writeHead(403); res.end(); return; }
      if (mode === "lose-session" && name === "add_order_line") { sessions.clear(); mode = "normal"; res.writeHead(404); res.end(); return; }
      const answer = () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "ask-1", method: "roots/list", params: {} })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: call(name, (params.arguments ?? {}) as Obj) })}\n\n`);
      };
      if (mode === "slow" && name === "add_order_line") setTimeout(answer, 3000); else answer();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } }));
  });
});
server.listen(0, "127.0.0.1", () => { const a = server.address(); process.stdout.write(`${typeof a === "object" && a ? a.port : 0}\n`); });
