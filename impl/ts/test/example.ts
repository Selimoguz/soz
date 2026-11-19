// example.ts — The README's example, run end to end against a pretend ERP.
// node --experimental-strip-types test/example.ts

import { operationsFromJson, preview, execute, previewSummary, Journal, parseJson } from "../src/index.ts";

const operations = operationsFromJson(parseJson(`[
  {"name": "erp.find_customer", "effect": "read", "params": {"name": {"type": "text"}},
   "returns": {"type": "record", "fields": {"code": {"type": "text"}, "balance": {"type": "number"},
                                            "limit": {"type": "number"}}}},
  {"name": "erp.add_order_line", "effect": "write", "key": ["customer", "product", "quantity"],
   "params": {"customer": {"type": "text"}, "product": {"type": "text"}, "quantity": {"type": "number"}}}
]`));

const orders: unknown[] = [];
const implementations = new Map([
  ["erp.find-customer", async () => ({ code: "C-1042", balance: 4200n, limit: 0.5e4 })],
  ["erp.add-order-line", async (args: Record<string, unknown>) => { orders.push(args); return null; }],
]);

const message = "Please send Yilmaz Market 20 crates of tomatoes and 5 crates of peppers tomorrow.";
const plan = `(plan "Order for Yilmaz Market"
  (let ((c (erp.find_customer name "Yilmaz Market")))
    (if (> (get c balance) (get c limit))
        (stop "over the limit")
        (for-each (line (list (record product "tomatoes" quantity 20) (record product "peppers" quantity 5)))
          (erp.add_order_line customer (get c code) product (get line product) quantity (get line quantity))))))`;

const journal = new Journal();
const bad = await preview(plan.replace("quantity 20", "quantity 25"), { message, operations, implementations, journal });
console.log(previewSummary(bad));
const p = await preview(plan, { message, operations, implementations, journal });
console.log(previewSummary(p));
const e = await execute(p, p.hash!, { implementations, journal });
console.log("outcome:", e.outcome, "orders:", orders.length);
const again = await preview(plan, { message, operations, implementations, journal });
const e2 = await execute(again, again.hash!, { implementations, journal });
console.log("again:", e2.outcome, e2.steps.map(s => s.status).join(", "), "orders:", orders.length);
if (e.outcome !== "done" || orders.length !== 2 || bad.status !== "invalid") process.exit(1);
