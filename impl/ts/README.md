# soz for TypeScript

A second implementation of [soz](../../README.md), with no dependencies: the checker, preview,
execution, journal, audit record and policy. It passes the whole
[conformance suite](../../conformance/README.md), the same 146 cases as the reference implementation.

Requires Node 22.6 or newer. The sources are TypeScript that Node runs directly (on Node 22 with
`--experimental-strip-types`; from Node 23.6 without a flag); there is no build step yet.

```sh
npm test          # type check (tsc, strict), the 146 conformance cases, the example, defineOperation, the stores with real processes, the gateway
```

The only development dependency is the TypeScript compiler, for type checking; nothing is needed
at run time. The few Node APIs used are typed in `types/node.d.ts` instead of `@types/node`.

## Use

```ts
import { operationsFromJson, policyFromJson, preview, execute, previewSummary, Journal, Audit,
         OperationFailed, parseJson } from "./src/index.ts";

const operations = operationsFromJson(parseJson(`[
  {"name": "erp.find_customer", "effect": "read", "params": {"name": {"type": "text"}},
   "returns": {"type": "record", "fields": {"code": {"type": "text"}, "balance": {"type": "number"},
                                            "limit": {"type": "number"}}}},
  {"name": "erp.add_order_line", "effect": "write", "key": ["customer", "product", "quantity"],
   "params": {"customer": {"type": "text"}, "product": {"type": "text"}, "quantity": {"type": "number"}}}
]`));

const implementations = new Map([
  ["erp.find-customer", async (args) => ({ code: "C-1042", balance: 4200n, limit: 10000n })],
  ["erp.add-order-line", async (args) => { /* call your ERP; throw new OperationFailed(...) if it refuses */ return null; }],
]);

const journal = Journal.open("soz-journal.jsonl");
const audit = Audit.open("soz-audit.jsonl");

const p = await preview(planFromTheModel, { message: whatTheUserWrote, operations, implementations, journal, audit });
console.log(previewSummary(p));           // show it to the person
// ... the person approves p.hash ...
const e = await execute(p, p.hash!, { implementations, journal, audit });
console.log(e.outcome);                    // done, stopped, changed, failed, unknown, not-approved, denied
```

### Declaring operations in TypeScript

Instead of JSON declarations and a separate map of implementations, `defineOperation` puts both in
one place, and TypeScript checks them against each other:

```ts
import { t, defineOperation, defineOperations, OperationFailed } from "./src/index.ts";

const findCustomer = defineOperation({
  name: "erp.find_customer",
  effect: "read",
  params: { name: t.text() },
  returns: t.record({ code: t.text(), balance: t.number(), status: t.enum("open", "blocked") }),
  run: async ({ name }) => erp.customers.find(name) ?? (() => { throw new OperationFailed("no such customer"); })(),
});

const addLine = defineOperation({
  name: "erp.add_order_line",
  effect: "write",
  params: { customer: t.text(), product: t.text(), quantity: t.number(),
            note: t.text().optional().modelAllowed() },
  key: ["customer", "product", "quantity"],
  run: async ({ customer, product, quantity, note }) => erp.orders.addLine(customer, product, quantity, note),
});

const { operations, implementations } = defineOperations(findCustomer, addLine);
```

- `run` receives typed arguments: `quantity` is an exact `Rational`, `note` is `string | undefined`.
- These do not compile: a `key` that names no parameter, a `run` that returns a text where a number
  was declared, an enum value that was not declared, an argument that does not exist, using an
  optional argument as if it were always there.
- At run time the result is still checked against the declaration (a value outside an enum is a
  `bad-result`): the type checker can be talked past with a cast, the checker cannot.
- `operationToJson(op)` gives the SPEC 6 JSON declaration, so a definition can be published,
  inspected, or read back with `operationFromJson`.

Types: `t.text()`, `t.number()`, `t.bool()`, `t.any()`, `t.list(item)`, `t.record({...})`,
`t.enum("a", "b")`; for parameters, `.optional()` and `.modelAllowed()`.

Implementation keys are operation names after `nameFold` (`_` becomes `-`). Numbers are exact:
implementations receive and may return `Rational` values (or `bigint`), never floats.

## Showing a preview in a chat app

`previewSummary(p)` is plain text; `renderPreview(p, format)` writes the same preview for a chat app or
an approval screen, with `format` one of `"text"`, `"markdown"`, `"slack"` or `"telegram"` (Telegram's
HTML parse mode):

```ts
await slack.chat.postMessage({ channel, text: renderPreview(p, "slack") });
```

What the model or a tool wrote (the title, the message, argument values, the stop reason) is untrusted
text on an approval screen, so both functions pass it through `visible()`: a newline in a value is
written as `
` and cannot pose as an extra step, and control, invisible and bidirectional characters
are named (`⟨U+202E⟩`) instead of turning an IBAN around. The renderers also put the steps in a code
block and escape everything else for the format, so `*bold*`, `<b>` or `[click](https://...)` in a
value is shown as written and never becomes formatting or a link.

## Journal and audit stores

`preview` and `execute` take any `JournalStore` and `AuditSink` (SPEC 10.8), so a host can keep them
in a database; `Journal` and `Audit` are the built-in ones, in memory or in files.

A step is **claimed** before it is called and only then run: a step is never run twice, not even when
two executions race for it or the host dies during the call. A claim left behind (a crash) or an
unknown outcome makes the next execution stop with `unresolved` instead of guessing; a person checks
the system and resolves it:

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning src/journal-cli.ts soz-journal.jsonl          # list
node --experimental-strip-types --disable-warning=ExperimentalWarning src/journal-cli.ts soz-journal.jsonl done '["erp.add-order-line"'   # it happened
node --experimental-strip-types --disable-warning=ExperimentalWarning src/journal-cli.ts soz-journal.jsonl release '["erp.pay"'         # it did not
```

On disk, each claim is a file created with the exclusive flag, so several gateways on one machine can
share a journal; audit appends take turns through a lock file and always continue from the record's
real last line, so they stay one chain. `npm run stores` checks this with real processes: 8 racing
for one step (exactly one wins), 4 writing one audit record (100 records, one chain), and a host that
dies mid-call (the step is not run again).

A store of your own implements four methods:

```ts
interface JournalStore {
  get(key: string): JournalEntry | undefined | Promise<...>;
  claim(key: string): JournalEntry | null | Promise<...>;      // null: claimed by you; else the entry that was there
  complete(key: string, status: "done" | "unknown", result: Json): void | Promise<void>;
  release(key: string): void | Promise<void>;
}
```

On Postgres, for example, `claim` is an `INSERT ... ON CONFLICT DO NOTHING RETURNING`; the audit sink
takes the previous hash inside the transaction that inserts the next record.

## MCP gateway

`src/soz-mcp.ts` is the MCP gateway of [SPEC section 11](../../SPEC.md#11-mcp-gateway), also with no
dependencies: MCP over stdio is written out here (about 300 lines) rather than taken from the MCP SDK,
which would bring 95 packages into a security tool's front door.

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning src/soz-mcp.ts gateway.json
```

The configuration is the same as the Lisp gateway's (servers, operations, approval, actor, policy,
journal, audit). Beyond the tools `soz_guide`, `soz_preview` and `soz_execute` it offers:

- `soz_inspect_audit`: what happened to a plan (its preview, approval, calls and outcome) and whether
  the audit record's hash chain is intact;
- resources `soz://guide`, `soz://operations` (with record fields and enum values) and `soz://policy`;
- the prompt `soz_plan_guard`: the rules for working through soz, ready to load in a client.

Approval works as in the Lisp gateway: MCP elicitation when the client supports it, otherwise a
one-time code shown to the person in a window outside the chat. `npm run gateway` runs the client,
the gateway and a pretend ERP as real processes (36 checks).

## Files

| File | |
|---|---|
| `src/exact.ts` | exact numbers (`bigint` fractions), a JSON reader that keeps numbers exact, canonical JSON, SHA-256, folding |
| `src/checker.ts` | reader, checker, operations, the policy decided from the text |
| `src/run.ts` | preview, execution, journal, audit record, the policy with values |
| `src/render.ts` | the preview for chat apps: Markdown, Slack, Telegram, plain text |
| `src/define.ts` | `defineOperation`: operations and implementations, typed together |
| `src/journal-cli.ts` | resolving unresolved steps, by a person |
| `src/gateway.ts`, `src/soz-mcp.ts` | the MCP gateway |
| `test/conformance.ts` | the conformance runner |
