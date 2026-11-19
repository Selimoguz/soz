# soz specification, version 0.2 (draft)

This document defines the soz plan language and its **checker**: the program that decides, before
anything runs, whether a plan written by a language model may run, what it touches and how many
operations it can call (sections 1 to 9), and how a valid plan is previewed, approved and executed
(section 10).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. The conformance suite in
`conformance/` is normative where it is more specific than this text.

## 1. Overview

A model does not call tools one at a time. It writes the whole job as a small plan:

```lisp
(plan "Order for Yilmaz Market"
  (let ((customer (erp.find_customer name "Yilmaz Market")))
    (for-each (line (list (record product "tomatoes" quantity 20)
                          (record product "peppers" quantity 5)))
      (erp.add_order_line customer (get customer code)
                          product (get line product)
                          quantity (get line quantity)))))
```

The checker receives the plan text, the **message** (what the user actually wrote, or nothing) and
the **operations** the host offers. It proves four things without running anything:

1. **Provenance.** Every value carries where it came from: the message, a tool, or the model
   itself. A value the model made up cannot reach an operation that changes something, and an
   operation that changes something cannot depend on a condition that contains such a value.
2. **Effects.** What the plan touches (`read`, `write`, `external`, `money`) and whether it needs
   approval are known from the text.
3. **Bounds.** Loops run only over finite lists; the largest number of operation calls is known in
   advance. There are no user-defined functions, no recursion and no unbounded loops.
4. **Isolation.** The plan is data. Reading it never evaluates anything of the host language.

## 2. Lexical syntax

A plan is a sequence of Unicode code points. Positions are reported as 1-based **line** and
**column**; a line ends at LF (U+000A), and columns count code points.

| Token | Rule |
|---|---|
| whitespace | space, tab, CR, LF |
| comment | `;` up to the end of the line |
| `(` `)` | list delimiters |
| text | `"` … `"`; inside, `\"` is a quote and `\\` a backslash; any other `\` is `bad-escape` at the character after it; LF is allowed |
| atom | a maximal run of *atom characters*: Unicode letters and digits and `- _ . ? ! < > = + * /` |

An atom is a **number** if it matches `-?[0-9]+(\.[0-9]+)?`, and its value is the exact decimal
(implementations MUST NOT use binary floating point: `12.5` is 25/2). An atom that starts with a
digit and is not a number is `bad-token`. Every other atom is a **name**.

Any other character (for example `#`, `'`, `` ` ``, `,`, `|`, `:`, `@`, `[`, `{`) is
`illegal-character` at its position. An atom immediately followed by a character that is neither
whitespace, `(`, `)` nor `;` is `illegal-character` at that character.

A plan is exactly one list. Anything but whitespace or comments after it is `trailing-content`.

Limits (defaults; a host MAY lower them):

| Limit | Default | Error |
|---|---|---|
| plan length in code points | 20000 | `too-long` at 1:1 |
| list nesting depth | 32 | `too-deep` at the `(` that exceeds it |
| tokens (lists, texts, atoms) | 5000 | `too-large` |

Other syntax errors: `unclosed-list` (at its `(`), `unclosed-text` (at its `"`), `unexpected-close`
(at the `)`), `unexpected-end` (at the end of the input).

A syntax error stops the check: it is the only error reported.

## 3. Folding

Names are compared after **name folding**, texts against the message after **text folding**.

`fold(s)`: decompose to Unicode NFD; remove code points U+0300 to U+036F; lowercase each code point
with the Unicode simple lowercase mapping; replace `ı` (U+0131) with `i`.
So `Şişli`, `sisli` and `ŞİŞLİ` fold to `sisli`, `Café` to `cafe`, and `Größe` to `große`.

`name-fold(s)`: `fold(s)` with every `_` replaced by `-`. So `erp.add_order_line`,
`erp.add-order-line` and `ERP.Add_Order_Line` are the same name.

## 4. Structure

The single list MUST have the form `(plan TITLE EXPR+)` where `plan` is the name and `TITLE` a
text; otherwise `not-a-plan` (at the list), or `empty-plan` when there is no `EXPR`.

The body's expressions are checked in order with an empty environment.

### 4.1 Expressions

An expression is a number, a text, a name, or a list. A name evaluates to its binding in the
environment, else `unknown-name`. An empty list is `empty-form`; a list whose first element is not a
name is `bad-form`. Otherwise the first name selects a **form** (by `name-fold`) or, if it is not a
form, an **operation** (section 6), else `unknown-operation` at the name.

| Form | Shape | Result |
|---|---|---|
| `let` | `(let ((NAME EXPR) ...) BODY+)` | bindings are sequential; value of the last body expression |
| `for-each` | `(for-each (NAME LIST-EXPR) BODY+)` | `none` |
| `if` | `(if COND THEN)` or `(if COND THEN ELSE)` | join of both branches (`none` when ELSE is absent) |
| `do` | `(do BODY+)` | value of the last expression |
| `stop` | `(stop EXPR+)` | `none`; the plan *may stop* |
| `list` | `(list EXPR*)` | list |
| `record` | `(record NAME EXPR ...)` | record; field names unique (`duplicate-field`) |
| `get` | `(get RECORD-EXPR NAME)` | the field's value; `unknown-field`, `not-a-record` |
| arithmetic | `(+ N+)`, `(- N+)`, `(* N+)`, `(/ N N)` | number |
| comparison | `(= A B)`, `(!= A B)`, `(< N N)`, `(> N N)`, `(<= N N)`, `(>= N N)` | bool |
| logic | `(and B+)`, `(or B+)`, `(not B)` | bool |

`plan` anywhere but the top is `bad-form`. A form with the wrong number or kind of parts is
`bad-form` at the form. `(/ N 0)` with a literal zero is `division-by-zero` at the zero.

### 4.2 Types

`text`, `number`, `bool`, `list` (of one element type), `record` (named fields), `none`, and
`any`. A value of type `any` (from an operation that returns `any`) is accepted wherever a type is
expected; `get` on it yields `any`, and `for-each` over it is `not-a-list`.

An argument whose type does not match is `type-mismatch` at the argument. Arithmetic and ordering
comparisons need numbers, `and`/`or`/`not`/`if` conditions need bools, `for-each` needs a list
(`not-a-list`). All elements of a list must have the same type, and records the same field names
(`mixed-list` at the `list`). The two branches of an `if` are joined the same way; if they cannot
be joined the result is `any` (no error).

## 5. Provenance

Every value has a **source set**, a subset of `{message, tool, model}`, and a set of **invented
literals**: the literal tokens it was made from that are not in the message.

### 5.1 Literals

A number or text literal has source `message` if it is **in the message**, else source `model`, and
then it is its own invented literal. With no message, every literal is invented.

A **text** literal `L` is in the message if `f = fold(trim(L))` has at least 2 code points and
occurs in `fold(message)` at a position that is the start of the message or follows a code point
that is not a letter or digit. (`"Yilmaz Market"` is in "Send it to Yılmaz Market'e"; `"ali"` is
not in "talimat".)

A **number** literal `N` is in the message if `N ≥ 0` and `N` is one of the **message numbers**.
Message numbers come from each maximal run in the message matching `[0-9]+([.,][0-9]+)*`; each run
gives every value it has under these readings, where a reading applies only if the result is a
valid decimal:

- digits only: the integer;
- `.` groups thousands, one `,` is the decimal point (`1.250,50` → 1250.5);
- `,` groups thousands, one `.` is the decimal point (`1,250.50` → 1250.5);
- the separators are removed (`1.250` → 1250, `12,5` → 125).

So `1.250` gives {1.25, 1250}, `12,5` gives {12.5, 125} and `20` gives {20}. A negative literal is
never in the message.

### 5.2 Derived values

Arithmetic, comparisons, logic, `list` and `record` have the union of their parts' sources and
invented literals. `get` yields the field's own value. A value returned by an operation has source
`tool` and no invented literals, and so does every part of it. The loop variable of `for-each` has
the list's element value. An `if` result is the join of its branches.

### 5.3 Rules

A **side-effect operation** is one whose effect is not `read`.

- **invented-value.** In a call to a side-effect operation, for every parameter that does not
  declare `model_allowed`, every invented literal of the argument is an error `invented-value` at
  the literal's position.
- **invented-condition.** A call to a side-effect operation inside the THEN or ELSE of one or more
  `if` forms is an error `invented-condition` at the call if the union of those conditions has an
  invented literal. `stop` is never an error: stopping is always safe.

Reads are not restricted: a model may look things up with values it chose.

Provenance does not catch a model that repeats a line of the message twice; every value of the
second copy is in the message. Execution (0.2) handles that with idempotency keys.

## 6. Operations

The host declares the operations a plan may call. Declaration (JSON):

```json
{
  "name": "erp.add_order_line",
  "effect": "write",
  "params": {
    "customer": {"type": "text"},
    "quantity": {"type": "number"},
    "note":     {"type": "text", "required": false, "model_allowed": true}
  },
  "returns": {"type": "any"}
}
```

- `effect` is one of the built-in effects `read`, `write`, `external` (sends something outside: a
  message, an e-mail) and `money`, or a **custom effect**: a name matching `[a-z][a-z0-9._-]*`
  chosen by the host, such as `erp.post` or `stock.move`. Only `read` is free of side effects;
  every other effect, custom ones included, follows the rules for side effects (section 5.3) and
  needs approval. A domain adds its own effects this way without changing the core.
- **An operation without `effect` is `write`**: one that someone forgot to mark stays on the safe
  side.
- `required` defaults to true, `model_allowed` to false, `returns` to `{"type": "any"}`.
- `key` (0.2) lists the parameters that make up the operation's idempotency key (section 10.3);
  default: all of them.
- Types: `{"type": "text" | "number" | "bool" | "any"}`, `{"type": "list", "items": T}`,
  `{"type": "record", "fields": {"name": T, ...}}`.

A call is `(OPERATION PARAM EXPR PARAM EXPR ...)`; parameter names are compared by `name-fold`.
Errors: an odd number of arguments or a parameter that is not a name is `bad-form`;
`unknown-parameter`, `duplicate-parameter` (at the parameter name); `missing-parameter` (at the
call); `type-mismatch` (at the argument).

## 7. Bounds

- A `list` form has at most 50 elements (`list-too-long` at the form).
- The **length** of a list value is known when it is a `list` form or a name bound to one; otherwise
  (a tool's list, a joined `if`) it is 50.
- A call's **multiplier** is the product of the lengths of the lists of the `for-each` forms around
  it (an empty list counts as 1).
- `max_calls` is the sum of the multipliers of all call sites (both branches of every `if`). If it is
  over 500 the error is `too-many-calls` at the `plan` list.

## 8. Result

The checker's result (the conformance suite compares these fields):

```json
{
  "valid": false,
  "errors": [{"code": "invented-value", "line": 4, "column": 56, "message": "..."}],
  "effects": ["read", "write"],
  "requires_approval": true,
  "max_calls": 3,
  "may_stop": false,
  "calls": [{"operation": "erp.add_order_line", "effect": "write", "line": 5,
             "max_count": 2, "conditional": false}]
}
```

- `valid` is true when there are no errors.
- `errors` are ordered by line, then column; `message` is for people and models and is not
  compared. An implementation SHOULD report every error it finds, not just the first (except syntax
  errors, section 2).
- `effects` lists the effects of all call sites: the built-in ones in the order `read`, `write`,
  `external`, `money`, then custom ones in code point order; `requires_approval` is true if any of
  them is not `read`.
- `calls` has one entry per call site in source order; `conditional` is true inside an `if` branch.
- These fields are filled even when the plan is invalid (from what could be checked), except after a
  syntax error, where they are empty.

## 9. Error codes

`illegal-character`, `bad-escape`, `bad-token`, `unclosed-list`, `unclosed-text`,
`unexpected-close`, `unexpected-end`, `trailing-content`, `too-long`, `too-deep`, `too-large`,
`not-a-plan`, `empty-plan`, `empty-form`, `bad-form`, `unknown-name`, `unknown-operation`,
`unknown-parameter`, `duplicate-parameter`, `missing-parameter`, `duplicate-field`,
`unknown-field`, `type-mismatch`, `not-a-list`, `not-a-record`, `mixed-list`, `division-by-zero`,
`invented-value`, `invented-condition`, `list-too-long`, `too-many-calls`.

## 10. Execution (0.2)

A valid plan runs in two passes over the same text: a **preview** (dry run) that the person
approves, and an **execution** that does exactly what was approved or stops.

### 10.1 Implementations of operations

The host gives every operation an implementation: a function from the arguments (a record of
parameter name to value) to one of

- a **result**, a value of the declared `returns` type;
- **failed**: the operation did not happen (a validation error, a refusal);
- **unknown**: it is not known whether it happened (a timeout, a lost connection).

A result that does not match the declared type is `bad-result`. A list result longer than 50 is
`list-too-long` (the checker assumed at most 50).

### 10.2 Evaluation

Expressions evaluate as their names say: numbers are exact (division that does not terminate stays
an exact fraction), `=` compares texts after `fold`, numbers by value, bools, lists and records
structurally. `(/ x 0)` at run time is `division-by-zero`. Evaluation of the body stops at the first
`stop` reached; its arguments, rendered as text and joined with spaces, are the **stop reason**.

### 10.3 Preview

1. The plan is checked; an invalid plan has no preview.
2. The body is evaluated. A `read` operation is called. A side-effect operation is **not** called:
   it becomes a **step** `{index, operation, effect, args, key}`, numbered from 1 in the order
   reached, with its arguments evaluated.
3. The value of a step is not known yet. It is a **pending** value: it may be passed to a later
   step (or a field of it, with `get`), and is shown as `(result of step N)` or
   `(result of step N).field`. Using a pending value in anything else (arithmetic, a comparison, an
   `if` condition, a `for-each` list, an argument of a `read`) is `depends-on-write`: such a plan
   cannot be previewed.
4. Each step has an **idempotency key**: the operation's name (`name-fold`) and the values of its
   **key parameters**. An operation declares them with `"key": ["customer", "product", "date"]`;
   without `key`, all its parameters are key parameters. A step whose key equals an earlier step's
   key in the same preview is a `duplicate-step` (the model wrote the same thing twice); a preview
   with a duplicate step cannot be approved. A step whose key is already in the host's **journal**
   (a previous plan did it) is marked `already_done` and will not run again.
5. The preview's status is `ready` (it may be approved), `stopped` (a `stop` was reached; the steps
   before it are listed and may still be approved), `nothing` (no steps) or `error` (a run-time
   error, `depends-on-write`, `duplicate-step`, or a failed read).
6. The **preview hash** is the SHA-256, in lower-case hex, of the canonical JSON (10.6) of
   `{"plan": PLAN-TEXT, "message": MESSAGE-OR-NULL, "steps": [{"operation", "args", "key"}...]}`.

### 10.4 Approval and execution

Execution takes the preview and an **approval**: the preview hash, as approved by a person. A
different hash is `not-approved` and nothing runs. **An approval is for one execution:** executing
the same preview a second time is `not-approved` (a double click, a replayed request); running the
plan again needs a new preview and a new approval. Then the body is evaluated again, from scratch,
with live reads. For every step reached, in order:

1. If the preview has no step with that index, or its operation or arguments differ, execution stops
   with `changed` **before** calling it, and says what differs. A pending argument in the preview
   matches any value. (The balance moved, the stock ran out: the person approved something else.)
2. If its key is in the journal, it is not called again; its status is `already_done`.
3. Otherwise it is called:
   - result: the key goes into the journal with the result; status `done`;
   - failed: status `failed`; execution stops with `failed`;
   - unknown: the key goes into the journal as **unknown**, so that nothing runs it again by
     itself; status `unknown`; execution stops with `unknown`. There is no retry.

If evaluation ends with fewer steps than the preview had, the outcome is `changed`, unless a `stop`
was reached, which gives `stopped`. Otherwise the outcome is `done`. Every step has a status:
`done`, `already_done`, `failed`, `unknown` or `not_run`.

### 10.5 Audit record

Every check, preview, approval, call and outcome is appended to an **audit record**, one JSON object
per line:

```json
{"seq": 3, "type": "call", "time": "2026-11-19T10:15:02Z", "prev": "9f2c...", "data": {...}}
```

`type` is `preview`, `approval`, `call` or `outcome`. `prev` is the SHA-256 of the previous line's
exact text (64 zeros for the first line), so that removing or changing a line breaks the chain.
`data` for a preview holds the plan, message, check result and steps; for an approval, the hash and
who approved; for a call, the step, arguments and result or failure; for an outcome, the outcome and
the steps' statuses.

### 10.6 Canonical JSON

Objects with keys sorted by code point, no whitespace, strings with only `"` `\` and control
characters escaped (`\u00XX`, lower-case hex), `true`, `false`, `null`. A number is written as an
exact decimal without exponent or trailing zeros (`20`, `12.5`, `-0.25`); a number that has no finite
decimal is written as a string `"n/d"` (`"1/3"`). Records are objects; lists are arrays; a pending
value is `{"pending": N}` or `{"pending": N, "path": ["field", ...]}`.

### 10.7 Error and outcome codes

Preview: `bad-result`, `list-too-long`, `division-by-zero`, `depends-on-write`, `duplicate-step`, `no-implementation`,
`read-failed`. Execution outcomes: `done`, `stopped`, `changed`, `failed`, `unknown`,
`not-approved`.

## 11. MCP gateway

The gateway is an MCP server (protocol 2025-06-18, stdio) that sits between an agent and the MCP
servers it would otherwise use. It is an adapter: everything it guarantees comes from sections 1 to
10.

### 11.1 Operations from tools

Every tool of every configured server becomes the operation `SERVER.TOOL`:

- **parameters** from the tool's `inputSchema`: `string` is `text`, `number` and `integer` are
  `number`, `boolean` is `bool`, anything else `any`; `required` as declared;
- **returns** from its `outputSchema` (objects with `required` properties become records, arrays
  lists), else `any`;
- **effect** `read` only if the tool is annotated `readOnlyHint: true`, otherwise `write`.
  Annotations are hints from the server; the configuration may override them, and a tool without
  annotations is a write.

The configuration may override, per operation, `effect`, `returns`, `key` and `model_allowed` (a
list of parameter names).

A tool call that returns `isError` is **failed**; a server that does not answer in time gives
**unknown**. The value of a result is its `structuredContent`, else its text content parsed as JSON,
else the text.

### 11.2 Tools the gateway offers

- `soz_guide`: the language in brief, the rules the checker enforces, and every operation with its
  parameters and effect.
- `soz_preview {plan, message}`: check and preview (section 10.3). On success the result names the
  steps and a `preview_id` (the preview hash). An invalid plan returns the error report with
  `isError: true`.
- `soz_execute {preview_id}`: execute that preview (section 10.4); a unique prefix of at least 12
  characters is accepted.
- Every `read` operation is also offered directly, as `SERVER_TOOL`, so the agent can look things up
  before it plans. Tools that change something are **never** offered directly.

### 11.3 Approval

`approval` in the configuration is one of:

- `elicitation` (default): before executing, the gateway asks the user through MCP elicitation
  (`elicitation/create`) with the preview and the message it was based on; it executes only if the
  user accepts and sets `approve` to true. The model cannot answer an elicitation. If the client
  does not support elicitation, `soz_execute` refuses and nothing runs.
- `client`: the gateway executes when `soz_execute` is called and relies on the client asking the
  user before that tool call. Use it only with clients set to ask every time for `soz_execute`.

The message that provenance is checked against is passed by the agent. In `elicitation` mode the user
sees that message next to the steps before approving.

### 11.4 Configuration

```json
{
  "servers": {"erp": {"command": "sbcl", "args": ["--script", "fake-erp.lisp"], "env": {}}},
  "operations": {"erp.add_order_line": {"key": ["customer", "product", "quantity"],
                                        "model_allowed": ["note"]}},
  "approval": "elicitation",
  "expose_reads": true,
  "journal": "soz-journal.jsonl",
  "audit": "soz-audit.jsonl"
}
```

Relative paths are relative to the configuration file, which is also the working directory of the
servers.

## 12. Planned

- **Policy:** rules over (person, effect, operation, values), applied to the plan text before
  running and to each call while running.
- **JSON syntax:** the same plan as JSON, for models with structured output.
- **Source labels:** operations may label their results (`erp`, `crm`) so that policies can say
  which system a value came from, not just that it came from a tool.
- **Language profiles:** optional message matching for number words ("twenty", "yirmi") and
  inflected words.
- **Remote servers:** MCP over streamable HTTP, for downstream servers on another machine (an ERP
  host).
