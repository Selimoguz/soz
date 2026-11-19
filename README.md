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
- **Effects.** What the plan touches (`read`, `write`, `external`, `money`, or your own effects such
  as `erp.post`) and whether it needs approval are known from its text.
- **Bounds.** Loops run only over finite lists, and the largest number of operation calls is known
  in advance. No user-defined functions, no recursion, no unbounded loops.
- **Isolation.** A plan is data. Reading it never evaluates anything of the host language.

## Quickstart

The reference checker needs [SBCL](https://www.sbcl.org) and nothing else.

```sh
sbcl --script impl/lisp/soz-check.lisp examples/order/operations.json examples/order/good.soz \
     --message-file examples/order/message.txt
```

```
Plan: Order for Yilmaz Market
Effects: read, write (needs approval)
- erp.find_customer (read)
- erp.add_order_line (write, up to 2 times, conditional)
At most 3 operation calls. The plan may stop on a condition.
```

The same plan with a quantity and a product the user never asked for (`examples/order/invented.soz`):

```
The plan did not run. Fix these and send it again:
1. line 5, column 67 [invented-value]: 25 is not in the message; a value the model wrote cannot go
   to parameter quantity of erp.add_order_line. Use the value from the message or from a read
   operation; if it is unknown, ask the user with (stop "...").
2. line 6, column 47 [invented-value]: "eggplant" is not in the message; ...
```

The error text is written for the model: it says where, why, and what to do instead. Add `--json`
for the machine-readable result.

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
| [Specification](SPEC.md) 0.1: syntax, provenance, effects, bounds, checker result | draft |
| [Conformance suite](conformance/): 86 language-neutral cases in JSON | done |
| Reference checker in Common Lisp (`impl/lisp/`) | passes the suite |
| 0.2: dry run, one approval for the whole preview, idempotency keys from business data, audit record | planned |
| Policies, JSON syntax, language profiles (number words), MCP gateway | planned |

The **MCP gateway** is where this is headed: a server between an agent and its MCP servers that
takes plans instead of single tool calls, so any agent (Claude Desktop, Cursor, your own) gets these
guarantees without changing its code.

## Writing another implementation

Ports are welcome, in any language. An implementation conforms when it passes every case in
[`conformance/`](conformance/README.md): each case gives a plan, a message and the expected result,
and errors are compared by their stable codes (`invented-value`, `too-many-calls`, ...) and
positions, never by their wording.

```sh
sbcl --script impl/lisp/run-conformance.lisp      # the reference checker against the suite
```

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
