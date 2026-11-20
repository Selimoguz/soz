// define.test.ts — defineOperation: what TypeScript refuses at compile time (the @ts-expect-error
// lines below fail `npm run typecheck` if they ever stop being errors), and what it does at run time.

import {
  t, defineOperation, defineOperations, preview, execute, previewSummary, Journal, Rational,
  operationToJson, operationFromJson, canonicalJson, OperationFailed, type Json,
} from "../src/index.ts";

let failed = 0;
const check = (what: string, ok: unknown) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) failed++; };

const lines: { customer: string; product: string; quantity: string; note?: string }[] = [];

const findCustomer = defineOperation({
  name: "erp.find_customer",
  effect: "read",
  params: { name: t.text() },
  returns: t.record({ code: t.text(), balance: t.number(), limit: t.number(), status: t.enum("open", "blocked") }),
  run: async ({ name }) => {
    if (!name.toLowerCase().includes("yilmaz")) throw new OperationFailed("no such customer");
    return { code: "C-1042", balance: 4200n, limit: 10000, status: "open" as const };
  },
});

const addLine = defineOperation({
  name: "erp.add_order_line",
  effect: "write",
  params: { customer: t.text(), product: t.text(), quantity: t.number(), note: t.text().optional().modelAllowed() },
  key: ["customer", "product", "quantity"],
  run: async ({ customer, product, quantity, note }) => {
    const q: Rational = quantity;                 // exact
    lines.push({ customer, product, quantity: q.toString(), ...(note !== undefined ? { note } : {}) });
    return null;
  },
});

// --- What TypeScript refuses (checked by npm run typecheck) -------------------------------------------

defineOperation({
  name: "x.bad_key", params: { a: t.text() },
  // @ts-expect-error: the key may only name parameters
  key: ["b"],
  run: () => null,
});

defineOperation({
  name: "x.bad_return", params: {}, returns: t.number(),
  // @ts-expect-error: a number was declared, a text is returned
  run: () => "twenty",
});

defineOperation({
  name: "x.bad_enum", params: {}, returns: t.enum("open", "shipped"),
  // @ts-expect-error: not one of the declared values
  run: () => "lost",
});

defineOperation({
  name: "x.unknown_arg", params: { a: t.text() },
  // @ts-expect-error: there is no parameter b
  run: ({ b }) => b,
});

defineOperation({
  name: "x.optional", params: { a: t.text().optional() },
  run: ({ a }) => {
    // @ts-expect-error: an optional parameter may be undefined
    const s: string = a;
    return s;
  },
});

// --- What it does ---------------------------------------------------------------------------------------

console.log("\ndefineOperation");
const { operations, implementations } = defineOperations(findCustomer, addLine);
check("operations and implementations come from one definition", operations.size === 2 && implementations.size === 2);

const json = operationToJson(addLine.operation);
check("operationToJson gives the SPEC 6 declaration", canonicalJson(json) === canonicalJson({
  name: "erp.add_order_line", effect: "write", key: ["customer", "product", "quantity"], returns: { type: "any" },
  params: { customer: { type: "text" }, product: { type: "text" }, quantity: { type: "number" },
            note: { type: "text", required: false, model_allowed: true } } }));
const back = operationFromJson(JSON.parse(canonicalJson(operationToJson(findCustomer.operation))) as Json);
check("operationFromJson(operationToJson(op)) keeps everything, enum values included",
      canonicalJson(operationToJson(back)) === canonicalJson(operationToJson(findCustomer.operation)));
let twice = false;
try { defineOperations(addLine, addLine); } catch { twice = true; }
check("the same operation defined twice is refused", twice);

const message = "Yilmaz Market: 20 tomatoes and 5 peppers.";
const plan = `(plan "x" (let ((c (erp.find_customer name "Yilmaz Market")))
  (if (= (get c status) "open")
      (for-each (l (list (record p "tomatoes" q 20) (record p "peppers" q 5)))
        (erp.add_order_line customer (get c code) product (get l p) quantity (get l q) note "deliver before noon")))))`;
const journal = new Journal();
const p = await preview(plan, { message, operations, implementations, journal });
check("a plan over defined operations previews; the enum constant may guard the write", p.status === "ready" && p.steps.length === 2);
check("the model's own text goes to the model_allowed parameter", previewSummary(p).includes("note=deliver before noon"));
const e = await execute(p, p.hash!, { implementations, journal });
check("it executes; run receives exact numbers and the optional note",
      e.outcome === "done" && lines.length === 2 && lines[0].quantity === "20" && lines[0].note === "deliver before noon");

const liar = defineOperation({
  name: "erp.find_customer", effect: "read", params: { name: t.text() },
  returns: t.record({ code: t.text(), balance: t.number(), limit: t.number(), status: t.enum("open", "blocked") }),
  run: async () => ({ code: "C-1042", balance: 4200, limit: 10000, status: "frozen" }) as never,   // gets past the type checker on purpose
});
const lied = await preview(plan, { message, ...defineOperations(liar, addLine), journal: new Journal() });
check("at run time too: a value outside the declared ones is a bad result", lied.status === "error" && lied.problems[0]?.code === "bad-result");

console.log(`\n${failed ? `${failed} FAILED` : "All defineOperation tests passed"}`);
process.exit(failed ? 1 : 0);
