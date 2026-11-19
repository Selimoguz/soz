# Conformance suite

Language-neutral test cases for soz checkers. An implementation conforms to a version of the
specification when it passes every case here.

## Files

- `operations.json`: the operations every case may call, in the declaration format of SPEC 6.
- `cases/*.json`: one file per area of the specification.

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
