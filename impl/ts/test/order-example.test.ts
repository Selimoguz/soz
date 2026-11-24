// order-example.test.ts — examples/order: the order number is the idempotency key of its lines.
// node --experimental-strip-types test/order-example.test.ts

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { operationsFromJson, preview, execute, Journal, parseJson, type Implementation } from "../src/index.ts";

const folder = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples", "order");
const read = (name: string) => readFileSync(join(folder, name), "utf8").trim();
const operations = operationsFromJson(parseJson(read("operations.json")));
const good = read("good.soz");
const message = read("message.txt");

let failed = 0;
const check = (what: string, ok: unknown) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) failed++; };

const lines: unknown[] = [];
const implementations = new Map<string, Implementation>([
  ["erp.find-customer", async () => ({ code: "C-1042", title: "Yilmaz Market", balance: 4200, limit: 10000 })],
  ["erp.add-order-line", async args => { lines.push(args); return { line: lines.length }; }],
]);
const journal = new Journal();

async function run(plan: string, msg: string) {
  const p = await preview(plan, { message: msg, operations, implementations, journal });
  const e = p.status === "ready" ? await execute(p, p.hash!, { implementations, journal }) : null;
  return { p, e };
}

console.log("\nexamples/order: the order number is the key");
check("the example declares order_id and line_id as the key of erp.add_order_line",
      JSON.stringify(operations.get("erp.add-order-line")?.key) === JSON.stringify(["order_id", "line_id"]));

const first = await run(good, message);
check("the order runs: two lines", first.e?.outcome === "done" && lines.length === 2);

const again = await run(good, message);
check("the same request again runs nothing: both lines already done",
      again.e?.outcome === "done" && again.e.steps.every(s => s.status === "already_done") && lines.length === 2);

const nextDay = await run(good.replaceAll("SO-24117", "SO-24131"), message.replaceAll("SO-24117", "SO-24131"));
check("the same customer, product and quantity the next day, under a new order number: it runs",
      nextDay.e?.outcome === "done" && nextDay.e.steps.every(s => s.status === "done") && lines.length === 4);

const changed = await run(good.replace("quantity 20", "quantity 25"), message.replace("20 crates", "25 crates"));
check("the same order number with another quantity is a key-conflict, not already done; nothing runs",
      changed.p.status === "error" && changed.p.problems.some(x => x.code === "key-conflict")
      && changed.p.problems.some(x => x.message.includes("SO-24117")) && changed.e === null && lines.length === 4);

const noted = await run(good.replace("quantity (get line quantity)", 'quantity (get line quantity) note "ring twice"'),
                        message);
check("a note the model wrote does not turn the same order into a new one: also a key-conflict",
      noted.p.status === "error" && noted.p.problems.some(x => x.code === "key-conflict") && lines.length === 4);

console.log(`\n${failed ? `${failed} FAILED` : "All order example tests passed"}`);
process.exit(failed ? 1 : 0);
