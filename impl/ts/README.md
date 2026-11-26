# soz for TypeScript

A second implementation of [soz](../../README.md), with no dependencies: the checker, preview,
execution, journal, audit record and policy. It passes the whole
[conformance suite](../../conformance/README.md), the same 298 cases as the reference implementation.

Requires Node 22.6 or newer. The sources are TypeScript that Node runs directly (on Node 22 with
`--experimental-strip-types`; from Node 23.6 without a flag); there is no build step yet.

```sh
npm test          # type check (tsc, strict), the 298 conformance cases, the example, defineOperation, the stores with real processes, the renderer, the order example, the gateway
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
  {"name": "erp.add_order_line", "effect": "write", "key": ["order_id", "line_id"],
   "params": {"order_id": {"type": "text"}, "line_id": {"type": "number"},
              "customer": {"type": "text"}, "product": {"type": "text"}, "quantity": {"type": "number"}}}
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
console.log(e.outcome);                    // done, stopped, changed, conflict, failed, unknown, unresolved, not-approved, denied
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
  params: { order_id: t.text(), line_id: t.number(), customer: t.text(), product: t.text(), quantity: t.number(),
            note: t.text().optional().modelAllowed() },
  key: ["order_id", "line_id"],   // the order number names the line; the goods do not (SPEC 6)
  run: async ({ order_id, line_id, customer, product, quantity, note }) =>
    erp.orders.addLine(order_id, line_id, customer, product, quantity, note),
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

## Number words in the message

With a language profile (SPEC 5.4) the checker reads number words in the message too: with
`profiles/tr.json`, "yirmi koli" makes 20 a message number, "iki yüz elli" 250, "2 bin" 2000;
"iki üç koli" is 2 and 3, never 5. Pass `profile: profileFromJson(...)` to `checkPlan` or `preview`,
or `"profile": "path/to/tr.json"` in the gateway's configuration. A profile is data; another
language is another JSON file.

## Plans in JSON

A plan whose text starts with `{` is read in the JSON syntax (SPEC 2.1), for models with structured
output; everything after reading is the same. `planJsonSchema()` is a strict JSON Schema of it (the
gateway serves it as `soz://plan-schema`), and `planToJson(readPlan(text))` writes an s-expression
plan in JSON:

```json
{"plan": "Order", "body": [
  {"let": [{"name": "c", "value": {"call": "erp.find_customer", "args": [{"name": "name", "value": "Yilmaz Market"}]}}],
   "body": [{"call": "erp.add_order_line", "args": [{"name": "customer", "value": {"get": {"var": "c"}, "field": "code"}},
                                                   {"name": "quantity", "value": 20}]}]}]}
```

`test/make-json-cases.ts` regenerates `conformance/cases/13-json-equivalents.json`, every checker case
the JSON syntax can write, expecting what its s-expression gives.

## Showing a preview in a chat app

`previewSummary(p)` is plain text; `renderPreview(p, format)` writes the same preview for a chat app or
an approval screen, with `format` one of `"text"`, `"markdown"`, `"slack"` or `"telegram"` (Telegram's
HTML parse mode):

```ts
await slack.chat.postMessage({ channel, text: renderPreview(p, "slack") });
```

Every value says where it comes from, as the checker proved it, so the person approves the source too:

```
1. bank.transfer
     amount: 12450.75   (from the message)
     iban: TR33 0006 1005 1978 6457 8413 26   (from erp)
```

A step whose earlier run may or may not have happened is shown as such, never as "already done".

What the model or a tool wrote (the title, the message, argument values, the stop reason) is untrusted
text on an approval screen, so both functions pass it through `visible()`: a newline in a value is
written as `\n` and cannot pose as an extra step, and control, invisible and bidirectional characters
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
  claim(key: string, args?: Json): JournalEntry | null | Promise<...>;   // null: claimed by you; else the entry that was there
  complete(key: string, status: "done" | "unknown", result: Json, args?: Json): void | Promise<void>;
  release(key: string): void | Promise<void>;
}
```

Keep `args` (all the step's arguments) with the entry and return it from `get` and `claim`: a step with
the same key and other arguments is then a conflict (SPEC 10.3), not "already done". A store that drops
them still never runs a step twice, but cannot tell the two apart.
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
the gateway and a pretend ERP as real processes (80 checks, an HTTP server among them).

Every value a server returns is labelled with the server's name (SPEC 5.2), so a policy can say which
system an argument must come from: `{"args_from": {"iban": ["tool:erp"]}}` takes an IBAN from the
`erp` server only, never from the CRM or the message. `defineOperation` takes `label` too.

### Servers on another machine

A server may be an MCP endpoint over streamable HTTP instead of a program to start (SPEC 11.4):

```json
"servers": {"erp": {"url": "https://erp.example.com/mcp",
                    "headers": {"Authorization": "Bearer ${ERP_TOKEN}"}, "timeout_seconds": 30}}
```

Only `https`, unless the server is on this machine or `"allow_http": true` is given; the token comes
from the environment variable, not the file. The gateway keeps the session the server gives, starts a
new one when the server forgot it, and reads answers sent as JSON or as server-sent events. What
matters for writes: a call fails (and may run again) only when the request certainly did not reach the
server (refused, no such host, an untrusted certificate, 4xx); a timeout, a 5xx or a tool error from
a write (the server may have saved the order and then failed) leaves it unknown, so the step is
`unresolved` until a person checks. The Lisp gateway has no TLS without dependencies, so
it starts stdio servers only.

### Another person's approval

When the policy needs someone besides the user (`approve_by` finance, `four_eyes`), list the people
who may give it, with their public keys; their roles come from here, not from them:

```json
"approvers": [{"id": "ayse", "roles": ["finance"], "public_key": "Wo5Jaq..."}],
"gateway_id": "acme-erp"
```

`gateway_id` names this gateway (and tenant); approvals are bound to it.

Each of them makes a key pair once, on their own machine:

```sh
soz-approve keygen ayse          # ayse.soz-key (passphrase protected) stays with her; prints her public key
```

For such a plan `soz_execute` runs nothing and writes an approval request (by default to
`soz-approval-requests/`). The user passes the file to Ayşe by any channel; she runs

```sh
soz-approve REQUEST.json --key ayse.soz-key
```

which computes the preview hash again from the steps it shows (an edited request is refused), asks
her to type `yes` and her passphrase in a terminal (piped input is refused), and prints a token
`soz2.ayse.<expires>.<signature>`, valid for 24 hours (`--hours`). The token is bound to this preview
of these steps, at this gateway, for the user who asked, under this policy: it does not work for the
same plan previewed again, by someone else, at another gateway or tenant, or after the policy
changed. The user
gives the token to the model, which passes it in `approvals`; then the user approves as always, and
their approval window says who else approved. The model can carry a token but cannot make one, and
the gateway holds only public keys. Details: SPEC 11.5. The Lisp gateway verifies the same tokens
(Ed25519 and SHA-512 written out in `impl/lisp/ed25519.lisp`).

## Files

| File | |
|---|---|
| `src/exact.ts` | exact numbers (`bigint` fractions), a JSON reader that keeps numbers exact, canonical JSON, SHA-256, folding |
| `src/checker.ts` | reader, checker, operations, the policy decided from the text |
| `src/run.ts` | preview, execution, journal, audit record, the policy with values |
| `src/render.ts` | the preview for chat apps: Markdown, Slack, Telegram, plain text |
| `src/profile.ts` | language profiles: number words in the message |
| `src/json-plan.ts` | the JSON syntax: reader, `planToJson`, `planJsonSchema` |
| `src/define.ts` | `defineOperation`: operations and implementations, typed together |
| `src/journal-cli.ts` | resolving unresolved steps, by a person |
| `src/approvals.ts`, `src/approve-cli.ts` | another person's approval: requests, Ed25519 tokens, `soz-approve` |
| `src/gateway.ts`, `src/soz-mcp.ts` | the MCP gateway |
| `test/conformance.ts` | the conformance runner |
