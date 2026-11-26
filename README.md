# soz

**A small plan language that a language model writes and a checker proves, before anything runs.**

Agents today call tools one at a time, and whatever checks exist look at each call after the model
has decided it. soz turns the order around: the model writes the whole job as one small plan, and a
deterministic checker decides whether that plan may run at all.

```lisp
(plan "Order for Yilmaz Market"
  (let ((customer (erp.find_customer name "Yilmaz Market")))
    (if (> (get customer balance) (get customer limit))
        (stop "Yilmaz Market is over its credit limit")
        (for-each (line (list (record product "tomatoes" quantity 20)
                              (record product "peppers" quantity 5)))
          (erp.add_order_line customer (get customer code)
                              product (get line product)
                              quantity (get line quantity))))))
```

Without running anything, the checker proves:

- **Provenance.** Every value knows where it came from: the user's message, a tool, or the model.
  If the user asked for 20 crates and the plan says 25, the plan does not run: a number the model
  made up cannot reach an operation that changes something. Nor can such an operation depend on a
  condition built on a made-up threshold (`(if (> balance 50000) ...)` with 50000 from nowhere).
  What it proves is that each value is in the message it was given, not that it went where the user
  meant it ([SPEC 5.5](SPEC.md#55-in-the-message-is-not-for-that-field)), and that message is passed by
  the agent: the person who approves sees it word for word next to the steps, with where each value
  came from, and is the last check ([SPEC 11.3](SPEC.md#113-approval)). A number in the message means
  one value: `12,5` is 12.5, and with a language profile `1.250` is 1250 in Turkish and 1.25 in English;
  digits that could be read two ways are not taken at all, and the model is told to ask
  ([SPEC 5.1](SPEC.md#51-literals)).
- **Effects.** What the plan touches (`read`, `write`, `external`, `money`, or your own effects such
  as `erp.post`) and whether it needs approval are known from its text.
- **Bounds.** Loops run only over finite lists, and the largest number of operation calls is known
  in advance. No user-defined functions, no recursion, no unbounded loops.
- **Isolation.** A plan is data. Reading it never evaluates anything of the host language.

## Two tools, one idea

What a model claims, it has to show. This repository holds two tools built on that idea; they do not
depend on each other:

| | When | What it checks |
|---|---|---|
| **soz** (this README) | at run time, before an agent acts | the plan an agent wants to run: where every value came from, what it touches, how far it can go; then preview, approval, execution, audit |
| **[soz-guard](guard/README.md)** | at development time, before a coding agent's "done" counts | the work itself: the checks the repository's owner requires, run by soz-guard on exactly this change; tests and rules the agent may add to but not weaken; and the gaps it did not mention (a `TODO`, an empty handler, a swallowed error, made-up data). As a Claude Code hook and as a CI check |

## Quickstart

The reference checker needs [SBCL](https://www.sbcl.org) and nothing else.

```sh
sbcl --script impl/lisp/soz-check.lisp examples/order/operations.json examples/order/good.soz \
     --message-file examples/order/message.txt
```

```
Plan: Order SO-24117 for Yilmaz Market
Effects: read, write (needs approval)
- erp.find_customer (read)
- erp.add_order_line (write, up to 2 times, conditional)
At most 3 operation calls. The plan may stop on a condition.
```

The same plan with a quantity and a product the user never asked for (`examples/order/invented.soz`):

```
The plan did not run. Fix these and send it again:
1. line 5, column 72 [invented-value]: 25 is not in the message; a value the model wrote cannot go
   to parameter quantity of erp.add_order_line. Use the value from the message or from a read
   operation; if it is unknown, ask the user with (stop "...").
2. line 6, column 52 [invented-value]: "eggplant" is not in the message; ...
```

The error text is written for the model: it says where, why, and what to do instead. Add `--json`
for the machine-readable result.

### With Node instead of SBCL

The TypeScript implementation passes the same conformance suite and needs Node 22.6 or newer (the
only dependency, TypeScript, is for type checking):

```sh
cd impl/ts
npm install
npm test        # type check, the conformance suite, the stores, the renderer, the MCP gateway end to end
```

[impl/ts/README.md](impl/ts/README.md) shows the API (`preview`, `execute`, `defineOperation`) and how
to put the gateway in front of your MCP servers.

### The whole loop

```sh
sbcl --script examples/order/demo.lisp
```

On a pretend ERP, the demo shows the plan with invented values refused; the corrected plan
previewed (reads run, nothing is written); the person's approval and an execution that does exactly
that; the same plan run again, where nothing happens twice; the same goods the next day under a new
order number, which run; the first order number with another quantity, which is a conflict and does
not run; and the audit record, whose hash chain breaks when someone edits a line. The order number
and the line number are the key of an order line (`"key": ["order_id", "line_id"]` in
`operations.json`); the number comes with the request, as the invoice number does in the payments
example.

```
If you approve, these will happen:
  1. erp.add_order_line customer=C-1042 (from a tool) line_id=1 (from the message) order_id=SO-24117 (from the message) product=tomatoes (from the message) quantity=20 (from the message)
  2. erp.add_order_line customer=C-1042 (from a tool) line_id=2 (from the message) order_id=SO-24117 (from the message) product=peppers (from the message) quantity=5 (from the message)
Preview: 25467c3a8704
...
Outcome: done; steps: already_done, already_done
Order lines in the ERP: 2 (nothing twice)
...
=== 5. The same goods the next day, under a new order number ===
Outcome: done; steps: done, done
...
=== 6. The first order number again, with another quantity ===
Cannot run: step 1 (erp.add_order_line) has the key ["erp.add-order-line",{"line_id":1,"order_id":"SO-24117"}], which is in the journal (done) with other arguments: ...
...
demo-audit.jsonl: 15 lines, chain intact
Someone edits line 3 (a 5 becomes 9): chain broken at line 3
```

### Not only orders

The core knows nothing about any domain; each example brings its own operations and a pretend
system that does whatever it is told.

| Example | What goes wrong without soz | What soz does |
|---|---|---|
| [`examples/order`](examples/order) | the model orders 25 crates when 20 were asked, or a product nobody named | refuses the plan; a repeated order (same order number) is a no-op, the same order number with other quantities a conflict |
| [`examples/payments`](examples/payments) (`effect: money`) | the model pays a rounded amount to an IBAN from its memory; the bank pays the same invoice twice; the supplier changes the invoice after you looked | refuses invented amounts and IBANs (they must come from the invoice); the invoice number is the idempotency key; the plan compares the invoice with your request and stops |
| [`examples/devops`](examples/devops) (custom effect `infra.restart`) | the model looks in production when you said staging, and restarts what it found there; a server fails after you approved | a lookup with a made-up value cannot drive a change; one restart per server per ticket; a server not in the approved preview is never touched |

```sh
sbcl --script examples/payments/demo.lisp
sbcl --script examples/devops/demo.lisp
```

### Policy

The host can put rules in force for the person who asked (the model does not say who that is):

```json
{"actor": {"id": "ali", "roles": ["accounts-payable"]},
 "rules": [
   {"name": "payments over 10.000 need finance, four eyes",
    "when": {"operation": "bank.pay", "args": {"amount": {">": 10000}}},
    "then": {"approve_by": "finance", "four_eyes": true}},
   {"name": "amounts come from the invoice",
    "when": {"operation": "bank.pay"},
    "then": {"args_from": {"amount": ["tool"], "to_iban": ["tool"]}}},
   {"name": "field staff do not pay", "when": {"effect": "money", "actor_role": "field"}, "then": "deny"},
   {"name": "more than 25.000 in one plan: finance",
    "when": {"effect": "money", "total": {"amount": {">": 25000}}},
    "then": {"approve_by": "finance"}}]}
```

A limit on each payment can be met by splitting it into many; `total` and `count` look at the whole plan,
so ten payments of 9.999 still need finance.

Rules that do not depend on values are errors in the checker, so the model learns them while
planning; rules on values apply to the preview (a denied step makes it unapprovable, a required
approval is shown on the step) and again, with the actual values, before each step runs. With four
eyes, the person who asked cannot be the approver even if they have the role. In the payments demo,
Ali's approval alone pays nothing; Ali and Ayşe from finance together pay once. Details:
[SPEC section 12](SPEC.md#12-policy-03).

### Execution, in short

- **Preview.** Reads run; every operation with a side effect becomes a numbered step with its
  arguments, and nothing is written. A step's result is *pending* and can feed later steps (create
  an order, then add lines to it).
- **An approval text that cannot be forged from inside**: newlines, control, invisible and bidirectional
  characters in values are shown as escapes, so a value cannot pose as an extra step or turn an IBAN
  around; the TypeScript implementation renders it for Markdown, Slack and Telegram too.
- **One approval** for the whole preview, bound to it by a SHA-256 hash, and good for one execution.
- **Execution** evaluates the plan again with live reads and stops before any step whose operation or
  arguments differ from what was approved (the balance moved, the customer changed).
- **Idempotency keys** come from business data (the parameters an operation names as its key), are
  kept in a journal, and make a step that was already done a no-op: a retry, a double click or a
  message the model copied twice does not order twice. The same key with other arguments is a
  conflict that stops the plan, never a silent "already done".
- **Unknown outcomes** (a timeout, or a write whose tool reports an error: it may have written first) stop the plan, are recorded, and are never retried by themselves.
- **Audit record**: preview, approval, every call and the outcome, one JSON line each, chained by
  SHA-256.

## How a model uses soz

The model never declares where its values come from; that would let it lie. It writes plain values,
and the checker works out their provenance by comparing them with the message and following them
through the plan. What the model needs is a short description of the language, the operations it
may call, and a few example plans; the checker's errors teach it the rest.

soz is built in layers:

| Layer | For | State |
|---|---|---|
| **Core library**: checker, preview, execution, journal, audit | embedding in your own agent | Lisp reference, 0.2 |
| **CLI**: `soz-check`, conformance runner, demo | terminals, CI, porting | available |
| **MCP gateway**: tools `soz_guide`, `soz_preview`, `soz_execute` in front of your MCP servers | Claude Desktop, Cursor, any MCP client, without code changes | available (stdio) |

## The MCP gateway

Put the gateway between your agent and your MCP servers. Read-only tools pass through; tools that
change something are no longer offered to the model at all. To change anything, the model writes a
plan, `soz_preview` checks and previews it, the **user** approves it in their client (MCP
elicitation: a question the model cannot answer), and `soz_execute` runs exactly that.

```json
{
  "mcpServers": {
    "soz": {
      "command": "sbcl",
      "args": ["--script", "/path/to/soz/impl/lisp/soz-mcp.lisp", "/path/to/gateway.json"]
    }
  }
}
```

`gateway.json` names the servers behind it; `examples/gateway/` has one with a pretend ERP that does
whatever it is told, which is the point:

```json
{
  "servers": {"erp": {"command": "sbcl", "args": ["--script", "fake-erp.lisp"]}},
  "operations": {"erp.add_order_line": {"key": ["order_id", "line_id"], "model_allowed": ["note"]}},
  "approval": "auto"
}
```

A tool is treated as read-only only when its server annotates it `readOnlyHint: true` (or the config
says so); everything else is a write.

**Approval.** If the client supports MCP elicitation, the user approves in the client. If it does not
(Claude's desktop app, for one, did not when we tried it), the gateway shows the steps and a one-time
code such as `K7V-XYN` in a window of its own, outside the chat; the user tells the model the code if
they agree. The model never sees the code, a code works once, and three wrong codes lock the
preview. When a policy needs someone else too (finance, four eyes), the gateway writes an approval
request; that person checks it with `soz-approve` on their own machine and gives back a signed token
the model can carry but not forge. Details: [SPEC section 11](SPEC.md#11-mcp-gateway).

```sh
sbcl --script impl/lisp/test-gateway.lisp   # the gateway end to end: a client, the gateway and the ERP as real processes
```

## What soz is not

- **Not a general-purpose language.** It has no functions, no recursion, no strings library and no
  I/O of its own. It does one job: it is the contract between a model's intent and the operations
  that change the world.
- **Not a cage for the model's reasoning.** The model thinks however it wants; only the plan it hands
  over is checked. Single read-only tool calls do not need a plan.
- **Not a sandbox.** It does not run code safely; it refuses plans that are not provably within the
  rules, and runs nothing else. The operations themselves are the host's.
- **Not domain-specific.** The core knows nothing about ERPs, orders or payments. Hosts declare their
  operations and, if they need them, their own effects.

## Status

| Part | State |
|---|---|
| [Specification](SPEC.md) 0.4: syntax, provenance, effects, bounds, preview, approval, execution, journal (claimed before each call), audit, policy | draft |
| [Conformance suite](conformance/): 298 language-neutral cases in JSON (246 checker, 52 preview and execution), every convertible checker case in both syntaxes | done |
| Reference implementation in Common Lisp (`impl/lisp/`) | passes the suite |
| [TypeScript implementation](impl/ts/README.md) (`impl/ts/`), no dependencies | passes the suite |
| MCP gateway over stdio, in Lisp and in TypeScript (both without dependencies), with elicitation or approval-code approval, resources and a prompt; end-to-end tests | available |
| Downstream servers over streamable HTTP (https, tokens from the environment, sessions; a write whose answer is lost is unknown, never retried), in the TypeScript gateway | available |
| Policy: deny, approval by role with four eyes, sources an argument may come from, down to the system (`tool:erp`: an IBAN from the ERP, never from the CRM or a message) | available |
| Another person's approval collected by the gateway: approval requests and Ed25519-signed tokens (`soz-approve`), verified in both gateways | available |
| JSON syntax for models with structured output (SPEC 2.1), with a JSON Schema; read by both implementations into the same tree | available |
| Language profiles: number words in the message ("yirmi koli", "iki yüz elli", "2 bin"), as data in `profiles/` (Turkish, English), in both implementations and gateways | available |

## Writing another implementation

Ports are welcome, in any language. An implementation conforms when it passes every case in
[`conformance/`](conformance/README.md): each case gives a plan, a message and the expected result,
and errors are compared by their stable codes (`invented-value`, `too-many-calls`, ...) and
positions, never by their wording.

```sh
sbcl --script impl/lisp/run-conformance.lisp      # the Lisp reference implementation against the suite
cd impl/ts && npm run conformance                 # the TypeScript implementation against the same suite
```

Two implementations in two very different languages pass the same 298 cases, including one that
pins the preview hash computed independently in Python: the suite, not either implementation, is
what defines soz.

## soz-guard: the same idea, for code an agent writes

[soz-guard](guard/README.md) is a deterministic wrapper around a coding agent's "done": work is
finished when the checks say so, not when the agent does. The repository's owner names the checks
that must pass; soz-guard runs them itself on exactly the agent's change, keeps the agent from
deleting tests, removing assertions or editing its rules to get accepted, and finds the gaps it did
not mention (a `TODO`, an empty handler, a swallowed error, made-up data). It works as a Claude Code
hook while the agent works and as a CI check on the pull request, and can replay past commits to
measure what it would have caught. One command sets it up in a project.

## Prior art

None of the ideas is new on its own, and soz owes them:

- **CaMeL** (Debenedetti et al., *Defeating Prompt Injections by Design*, 2025) has a model write a
  plan in restricted Python whose interpreter tracks where data came from and applies policies
  before tool calls. Its target is injected content from outside; soz's target is the model's own
  invention, checked against what the user actually said, plus effects, bounds and (in 0.2) preview
  and idempotency.
- **Information-flow control and taint tracking** (decades of work, and agent systems such as
  Microsoft's FIDES) for the provenance rules.
- **Effect systems** (Koka, Eff, algebraic effects) for declaring what code may do.
- **Total, restricted configuration languages** (Dhall, Starlark, CUE) for "small, terminating,
  safe to evaluate".

What soz adds is the combination, aimed at one narrow place: the plan a model hands over before
anything with side effects runs.

## License

Apache-2.0, see [LICENSE](LICENSE).
