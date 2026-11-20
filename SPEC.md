# soz specification, version 0.4 (draft)

This document defines the soz plan language and its **checker**: the program that decides, before
anything runs, whether a plan written by a language model may run, what it touches and how many
operations it can call (sections 1 to 9), how a valid plan is previewed, approved and executed
(section 10), the MCP gateway (section 11), and the policies a host may put in force (section 12).

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

### 2.1 JSON syntax

A plan whose first character other than whitespace is `{` is written in **JSON** (RFC 8259), for
models with structured output. It stands for exactly one s-expression plan and is read into the same
tree; from there on (sections 3 to 12) nothing depends on which syntax was used, except that
positions are those of the JSON text. Every object has fixed keys, so the syntax fits a strict JSON
Schema (the TypeScript implementation's `planJsonSchema()` gives one).

| JSON | Stands for |
|---|---|
| `{"plan": TITLE, "body": [E, ...]}` (the whole plan) | `(plan TITLE E ...)` |
| a string | a text |
| a number | a number; it MUST match the number rule of section 2 (no exponent), else `bad-token` |
| `{"var": NAME}` | the name |
| `{"call": OPERATION, "args": [{"name": P, "value": E}, ...]}` (`args` optional) | `(OPERATION P E ...)` |
| `{"let": [{"name": N, "value": E}, ...], "body": [E, ...]}` | `(let ((N E) ...) E ...)` |
| `{"for_each": {"name": N, "value": E}, "body": [E, ...]}` | `(for-each (N E) E ...)` |
| `{"if": C, "then": E, "else": E}` (`else` optional or `null`) | `(if C E E)` |
| `{"do": [E, ...]}`, `{"stop": [E, ...]}`, `{"list": [E, ...]}` | `(do E ...)`, `(stop E ...)`, `(list E ...)` |
| `{"record": [{"name": F, "value": E}, ...]}` | `(record F E ...)` |
| `{"get": E, "field": F}` | `(get E F)` |
| `{"op": OP, "args": [E, ...]}`, OP one of `+ - * / = != < > <= >= and or not` | `(OP E ...)` |

Names (`NAME`, `OPERATION`, `P`, `N`, `F`) are JSON strings that MUST be names as atoms (section 2),
else `bad-token` at the string. `call` of a form's name is `bad-form`.

Positions: a form is at its object's `{`; a form's name (`let`, `if`, ...) at its key; an operation
or operator at its string; a text, number or name at its token.

Errors of the JSON syntax, which stop the check like syntax errors: `bad-json` (not JSON, a key that
appears twice in one object, a control character in a string), `bad-escape`, `unclosed-text`,
`unexpected-end`, `trailing-content`; `bad-form` at an object or key that is not one of the shapes
above (an unknown or missing key, `true`, `false`, `null` or an array where an expression belongs,
a top that is not `{"plan", "body"}`). The limits of section 2 apply to the tree read (`too-deep`
for its lists, `too-large` for its tokens) and to the text (`too-long`); JSON nested deeper than
100 is `too-deep` too.

The conformance suite runs every checker case it can in both syntaxes (`13-json-equivalents.json`).

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
expected; `get` on it yields `any`, and `for-each` over it is `not-a-list`. A `text` or `number`
declared with `enum` (section 6) is that type, with the list of its values attached.

An argument whose type does not match is `type-mismatch` at the argument. Arithmetic and ordering
comparisons need numbers, `and`/`or`/`not`/`if` conditions need bools, `for-each` needs a list
(`not-a-list`). All elements of a list must have the same type, and records the same field names
(`mixed-list` at the `list`). The two branches of an `if` are joined the same way; if they cannot
be joined the result is `any` (no error).

## 5. Provenance

Every value has a **source set**, a subset of `{message, tool, model, schema}`, and a set of **invented
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

**Schema constants.** In `(= A B)` or `(!= A B)`, if one side is a literal and the other a value
returned by an operation for a field declared with `enum`, and the literal is one of the declared
values (texts compared after `fold`, numbers by value), the literal has source `schema` and is not
invented. Asking whether an order is `"open"` makes nothing up; it asks a question about the tool's
data. This applies only to `=` and `!=`, only when the other side still carries the declared values
(a value from `get` or a name bound to it, not one derived by arithmetic or joined by `if`), and
never to a literal used anywhere else: writing `"cancelled"` as an argument of an operation that
changes something is still a value the model chose.

### 5.2 Derived values

Arithmetic, comparisons, logic, `list` and `record` have the union of their parts' sources and
invented literals. `get` yields the field's own value. A value returned by an operation has source
`tool`, and so does every part of it. **What an operation returns depends on what it was asked:** if
an argument of a parameter that does not declare `model_allowed` has invented literals, the result
and every part of it carry those invented literals too (and source `model`). Looking up a customer,
a server or an invoice the model made up does not turn the answer into trusted data. A parameter
meant for free search (`model_allowed`) does not pass its literals on. The loop variable of
`for-each` has the list's element value. An `if` result is the join of its branches.

### 5.3 Rules

A **side-effect operation** is one whose effect is not `read`.

- **invented-value.** In a call to a side-effect operation, for every parameter that does not
  declare `model_allowed`, every invented literal of the argument is an error `invented-value` at
  the literal's position.
- **invented-condition.** A call to a side-effect operation inside the THEN or ELSE of one or more
  `if` forms is an error `invented-condition` at the call if the union of those conditions has an
  invented literal. `stop` is never an error: stopping is always safe.

Reads are not restricted: a model may look things up with values it chose. What it finds that way
can be shown and reported, but cannot drive a side effect (section 5.2).

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
  `{"type": "record", "fields": {"name": T, ...}}`. A `text` or `number` type may list the only
  values it takes: `{"type": "text", "enum": ["open", "shipped", "cancelled"]}`. For a value an
  operation returns, this is a promise the host checks (section 10.1) and that plans may rely on
  (schema constants, section 5.1).

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
`invented-value`, `invented-condition`, `list-too-long`, `too-many-calls`, in the JSON syntax
`bad-json` (section 2.1), and with a policy `policy-denied`, `policy-source` (section 12).

## 10. Execution (0.2)

A valid plan runs in two passes over the same text: a **preview** (dry run) that the person
approves, and an **execution** that does exactly what was approved or stops.

### 10.1 Implementations of operations

The host gives every operation an implementation: a function from the arguments (a record of
parameter name to value) to one of

- a **result**, a value of the declared `returns` type;
- **failed**: the operation did not happen (a validation error, a refusal);
- **unknown**: it is not known whether it happened (a timeout, a lost connection).

A result that does not match the declared type is `bad-result`; so is a value outside a declared
`enum` (texts compared after `fold`). A list result longer than 50 is
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
2. If its key is in the journal as `done`, it is not called again; its status is `already_done`.
3. If its key is in the journal as `pending` or `unknown`, it is not called either: it may have
   happened. Its status is `unresolved` and execution stops with `unresolved`. A person checks
   and resolves the entry (section 10.8).
4. Otherwise the step is **claimed**: its key goes into the journal as `pending`, atomically (if
   another execution claimed it first, the step is `unresolved` as in 3). Only then is it called:
   - result: the entry becomes `done` with the result; status `done`;
   - failed: the claim is released (the operation did not happen and may run again); status
     `failed`; execution stops with `failed`;
   - unknown: the entry becomes `unknown`; status `unknown`; execution stops with `unknown`. There is
     no retry.

   A host that dies during the call leaves the claim `pending`, so the step is never run twice
   by accident, not even across a crash.

If evaluation ends with fewer steps than the preview had, the outcome is `changed`, unless a `stop`
was reached, which gives `stopped`. Otherwise the outcome is `done`. Every step has a status:
`done`, `already_done`, `failed`, `unknown`, `unresolved` or `not_run`. In a preview, a step whose key
is in the journal with any status has `already_done` set.

### 10.5 Audit record

Every check, preview, approval, call and outcome is appended to an **audit record**, one JSON object
per line:

```json
{"seq": 3, "type": "call", "time": "2026-11-19T10:15:02Z", "prev": "9f2c...", "data": {...}}
```

`type` is `preview`, `approval`, `call` or `outcome`. `prev` is the SHA-256 of the previous line's
exact text (64 zeros for the first line), so that removing or changing a line breaks the chain.
A host that restarts continues the chain from the last line of the existing record (its `seq` and
its hash); it never starts a second chain in the same file.
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
`read-failed`, and with a policy `policy-denied` (section 12). Execution outcomes: `done`, `stopped`,
`changed`, `failed`, `unknown`, `unresolved`, `not-approved`, and with a policy `denied`.

### 10.8 Journal and audit stores

The journal maps a step key to an entry `{key, status, result}`, `status` one of `pending`, `done`,
`unknown`. A host may keep it anywhere (a file, a database) as long as:

- **claim** is atomic: of two executions claiming the same key at the same time, exactly one
  succeeds, and the other sees the winner's entry;
- **release** removes an entry, so the step may run again;
- entries survive a restart.

A person resolves an `unresolved` step by marking its entry `done` (it did happen) or releasing it
(it did not), after checking the system the operation acts on. The host offers a way to do that.

The audit record (10.5) may likewise be kept anywhere, as long as appends from several executions
are serialized so that the hash chain stays one chain.

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

- `auto` (default): `elicitation` if the client declared the elicitation capability, otherwise
  `code`.
- `elicitation`: before executing, the gateway asks the user through MCP elicitation
  (`elicitation/create`) with the preview and the message it was based on; it executes only if the
  user accepts and sets `approve` to true. The model cannot answer an elicitation. If the client
  does not support elicitation, `soz_execute` refuses and nothing runs.
- `code`: `soz_execute` with only a `preview_id` runs nothing; it shows the user, in a window of its
  own outside the chat (a message box on Windows, a dialog on macOS), the steps, the message they
  were based on and a one-time **approval code** (six characters, such as `K7V-XYN`). The model is
  told only that a code was shown. If the user agrees, they tell the model the code, and
  `soz_execute` with `preview_id` and `approval_code` runs the preview. Codes are compared ignoring
  case, spaces and dashes; a code works once and expires after 10 minutes; three wrong codes lock
  the preview. If no window can be shown, nothing runs.
- `client`: the gateway executes when `soz_execute` is called and relies on the client asking the
  user before that tool call. Use it only with clients set to ask every time for `soz_execute`.

The message that provenance is checked against is passed by the agent. In `elicitation` and `code`
mode the user sees that message next to the steps before approving.

What approval protects against: a model that acts without asking, or that was talked into acting by
content it read. It does not protect against an agent that can run arbitrary programs on the same
machine and deliberately reads the user's screen or another process's memory; for that, run the
gateway where the agent has no shell.

### 11.4 Configuration

```json
{
  "servers": {"erp": {"command": "sbcl", "args": ["--script", "fake-erp.lisp"], "env": {}}},
  "operations": {"erp.add_order_line": {"key": ["customer", "product", "quantity"],
                                        "model_allowed": ["note"]}},
  "approval": "auto",
  "expose_reads": true,
  "journal": "soz-journal.jsonl",
  "audit": "soz-audit.jsonl"
}
```

Relative paths are relative to the configuration file, which is also the working directory of the
servers.

### 11.5 Other people's approval

A policy may require approval by someone other than the user (`approve_by`, `four_eyes`, section 12).
A gateway whose configuration lists **approvers** collects their approval as signed tokens:

```json
"approvers": [{"id": "ayse", "roles": ["finance"], "public_key": "<Ed25519 public key, 32 octets, base64url>"}],
"approval_requests": "soz-approval-requests"
```

The roles come from this list, never from a token. Without approvers, a requirement the user cannot
meet alone makes `soz_execute` refuse, as before.

1. When requirements are unmet, `soz_execute` runs nothing; it writes an **approval request** to
   `approval_requests/<first 16 hex digits of the hash>.json`, says which requirements are unmet and
   which approvers can meet each, and asks the model to tell the user to pass the file on.
2. The request is a canonical JSON object `{"soz_approval_request": 1, "hash", "plan", "message",
   "steps", "actor", "requires", "created"}`, where `steps` is the list the preview hash is computed
   from (section 10.3). A tool that shows a request MUST compute the hash again from `plan`,
   `message` and `steps` and refuse a request whose hash differs.
3. An approver who agrees signs, with Ed25519 (RFC 8032), the UTF-8 text
   `"soz approval 1\n" HASH "\n" ID "\n" EXPIRES` (`EXPIRES` in Unix seconds, decimal; `\n` is
   U+000A) and gives back the
   **token** `soz1.ID.EXPIRES.SIGNATURE` (signature: 64 octets, base64url without padding). The id
   has no spaces.
4. The model passes tokens in `soz_execute`'s `approvals`. The gateway accepts a token only if the id
   is an approver's, the signature verifies with that approver's public key for this preview's hash,
   it has not expired, the approver is not the user (who approves in their own way, section 11.3),
   and the approver has a role some requirement of the preview names. It says why it refuses any
   other. Accepted approvals are kept for the preview.
5. Once no requirement is unmet, the user approves as in section 11.3; the approval they see lists
   who else approved. The execution's approvers are the user and the accepted approvers, and the
   approval record (10.5) carries the tokens under `signatures`.

A token can travel through any channel, the chat included: the model can carry it, but cannot make
one or change what it approves. Approvers keep their private keys on their own machines, protected
by a passphrase; the gateway holds only public keys.

## 12. Policy (0.3)

A **policy** is a list of rules the host puts in force, for an **actor**: the person who asked for the
plan, `{"id": "ali", "roles": ["sales"]}` (the host knows who that is; the model does not say). With
no rules, nothing in this section applies.

### 12.1 Rules

```json
{"rules": [
  {"name": "big payments: finance, four eyes",
   "when": {"operation": "pay", "args": {"amount": {">": 1000}}},
   "then": {"approve_by": "finance", "four_eyes": true}},
  {"name": "field staff do not pay",
   "when": {"effect": "money", "actor_role": "field"},
   "then": "deny"},
  {"name": "amounts come from records",
   "when": {"operation": "pay"},
   "then": {"args_from": {"amount": ["tool"]}}}
]}
```

`when` (every condition present must hold; an absent one always holds):

- `operation`: a name or a list of names (compared by `name-fold`);
- `effect`: an effect or a list of effects;
- `actor_role`: the actor has at least one of these roles (never holds without an actor);
- `actor_not_role`: the actor has none of these roles (always holds without an actor);
- `args`: conditions on argument values, `{"param": {"OP": VALUE, ...}, ...}` with `OP` one of `=`,
  `!=`, `<`, `<=`, `>`, `>=`, `in`, `not_in` (texts compared after `fold`, numbers by value; ordering
  only between numbers). A parameter that was not given satisfies no condition. A value not known
  yet (a pending result, section 10.3) satisfies every condition: the rule is assumed to apply.

`then` is one of:

- `"deny"` or `{"deny": "reason"}`: the call is not allowed;
- `{"approve_by": ROLE, "four_eyes": BOOL}`: the step also needs the approval of someone with ROLE;
  with `four_eyes`, someone other than the actor. It applies to side-effect operations only;
- `{"args_from": {"param": [SOURCE, ...]}}`: the argument's sources (section 5) must all be among
  these (`message`, `tool`, `model`, `schema`). `["tool"]` means: read from a record, never typed,
  not even from the message. It may not be combined with `args` conditions.

A rule a host cannot read (an unknown comparison, source or `then`) is a configuration error; the
host MUST NOT start with it.

### 12.2 When rules apply

- **In the checker**, at every call site: a rule without `args` conditions whose other conditions
  hold is decided from the text. `deny` is the error `policy-denied` at the call; `args_from` is the
  error `policy-source` at each argument that breaks it. The model learns this before anything runs.
- **In the preview**, at every call with its argument values: a matching `deny` is the problem
  `policy-denied` and the preview's status is `denied` (it cannot be approved); a matching
  `approve_by` is listed in the step's `requires`, `[{"role", "four_eyes", "rule"}]`, and shown to
  the person.
- **At execution**: the preview's policy and actor are used. Before anything runs, the
  requirements of all steps not already done must be met by the **approvers** (the people who
  approved; by default the actor alone), or the outcome is `not-approved` and nothing runs; the
  preview is not used up, so the missing approval may be collected. For every step, after the check
  that it is unchanged (section 10.4), the rules are applied again with the actual values; a
  `deny` stops with the outcome `denied`, an unmet requirement with `not-approved`, before the step.

The approval record (section 10.5) lists the approvers. A gateway collects other people's approval as
in section 11.5.

## 13. Planned

- **Source labels:** operations may label their results (`erp`, `crm`) so that policies can say
  which system a value came from, not just that it came from a tool.
- **Language profiles:** optional message matching for number words ("twenty", "yirmi") and
  inflected words.
- **Remote servers:** MCP over streamable HTTP, for downstream servers on another machine (an ERP
  host).
