# Conformance suite

Language-neutral test cases for soz checkers. An implementation conforms to a version of the
specification when it passes every case here.

## Files

- `operations.json`: the operations every case may call, in the declaration format of SPEC 6.
- `cases/*.json`: one file per area of the specification.
  `13-json-equivalents.json` is generated (`impl/ts/test/make-json-cases.ts`): the checker cases of
  files 01 to 08 in the JSON syntax (SPEC 2.1), expecting what the s-expression gives, positions left
  out. `14-json.json` has the JSON syntax's own cases, with positions.
- A file or a case may set `"profile"`: the name of a language profile in `profiles/` (next to this
  folder), for SPEC 5.4; a case's own value wins, and `null` means none (`15-profiles.json`).

```json
{
  "description": "...",
  "message": "default message for the cases of this file",
  "cases": [
    {
      "name": "an invented quantity",
      "message": "optional; overrides the file's message; null means no message",
      "plan": "a string, or an array of lines joined with LF",
      "expect": {
        "valid": false,
        "errors": [{"code": "invented-value", "line": 3, "column": 63}],
        "only": true,
        "effects": ["read", "write"],
        "requires_approval": true,
        "max_calls": 3,
        "may_stop": false,
        "calls": [{"operation": "erp.add_order_line", "effect": "write", "line": 5,
                   "max_count": 2, "conditional": false}]
      }
    }
  ]
}
```

## Execution cases (SPEC 10)

A case with a `tools` field is an execution case. Instead of `expect` it has:

```json
{
  "tools": {"erp.find_customer": [{"result": {"code": "C1"}}], "erp.add_order_line": [{"result": null}]},
  "execute_tools": {"...": "optional; the scripts for the execution pass (default: tools again)"},
  "journal": [{"operation": "erp.add_order_line", "args": {"customer": "C1", "product": "tomatoes", "quantity": 20}}],
  "journal_after_preview": [{"operation": "...", "args": {}}],
  "approve": false,
  "expect_preview": {"status": "ready", "hash": "...", "stop_reason": null, "problems": ["duplicate-step"],
                     "steps": [{"operation": "...", "args": {}, "already_done": false}]},
  "expect_execute": {"outcome": "done", "stop_reason": null,
                     "steps": [{"index": 1, "status": "done"}],
                     "calls": ["erp.find_customer", {"operation": "erp.add_order_line", "args": {}}]},
  "expect_execute_again": {"outcome": "not-approved"}
}
```

- Each operation in `tools` answers its calls in order from its script: `{"result": X}`,
  `{"failed": "why"}` or `{"unknown": "why"}`; when the script runs out, the last answer repeats.
  An operation without a script has no implementation.
- `journal` entries are keys in the journal before the case starts: `done`, or with `"status"` `pending` or `unknown`.
  The entry's key is made from `args` as SPEC 10.3 says, and the entry keeps `args` as its arguments
  (SPEC 10.8), so a step with the same key and other arguments is a `key-conflict`.
- `journal_after_preview` entries are added the same way after the preview and before execution (another
  execution wrote them in between).
- The preview runs with `tools`; then, if `expect_execute` is present, execution runs with
  `execute_tools` (or fresh copies of `tools`) and the preview's hash as the approval, or a wrong
  approval when `"approve": false`. `expect_execute_again` executes the same preview once more.
- `calls` lists every implementation called during execution, in order (reads too): a name, or an
  object with the exact arguments.
- `problems` is the list of problem codes, in order. Arguments are compared as canonical JSON
  (SPEC 10.6), so `{"pending": 1, "path": ["id"]}` stands for a step's pending result.

## Policy (SPEC 12)

A file or a case may set `"policy"` (`{"rules": [...]}`) and `"actor"` (`{"id", "roles"}`); a case's
own value wins over the file's, and `"actor": null` means no actor. In execution cases,
`"approvers"` lists who approved (`[{"id", "roles"}]`; by default the actor alone), and a step in
`expect_preview` may list its `"requires"` (`[{"role", "four_eyes", "rule"}]`).

## Comparing

Only the fields present in `expect` are compared.

- `valid`, `requires_approval`, `may_stop`, `max_calls`: equal.
- `errors`: every listed error must be reported, with the same `code` and, when given, the same
  `line` and `column`. With `"only": true` no other error may be reported. Messages are never
  compared.
- `effects`: the same list in the same order.
- `calls`: the same number of entries; in each entry, every listed field is equal.

## Not covered here

The `too-long` (20000 code points) and `too-large` (5000 tokens) limits need very large inputs.
Implementations should test them on their own.
