# soz for TypeScript

A second implementation of [soz](../../README.md), with no dependencies: the checker, preview,
execution, journal, audit record and policy. It passes the whole
[conformance suite](../../conformance/README.md), the same 143 cases as the reference implementation.

Requires Node 22.6 or newer. The sources are TypeScript that Node runs directly (on Node 22 with
`--experimental-strip-types`; from Node 23.6 without a flag); there is no build step yet.

```sh
npm test          # type check (tsc, strict), the 143 conformance cases, the example, the gateway end to end
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

Implementation keys are operation names after `nameFold` (`_` becomes `-`). Numbers are exact:
implementations receive and may return `Rational` values (or `bigint`), never floats.

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
| `src/gateway.ts`, `src/soz-mcp.ts` | the MCP gateway |
| `test/conformance.ts` | the conformance runner |
