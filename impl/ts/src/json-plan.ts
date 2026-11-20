// json-plan.ts — The JSON syntax of a plan (SPEC 2.1), for models with structured output.
//
// A JSON plan is read into the same tree as the s-expression it stands for, so the checker, the
// preview and execution do not know which one the model wrote. Every object has fixed keys (no
// argument or field names as keys), so the whole syntax fits a strict JSON Schema; planJsonSchema()
// returns one. planToJson() writes an s-expression plan in this syntax.

import { type Json, nameFold } from "./exact.ts";
import { type Node, SyntaxError_, limits, parseNumber, isNameAtom } from "./checker.ts";

// --- A JSON reader that keeps positions --------------------------------------------------------------

type At = { line: number; column: number };
type J =
  | (At & { t: "object"; entries: { key: string; keyAt: At; value: J }[] })
  | (At & { t: "array"; items: J[] })
  | (At & { t: "string"; value: string })
  | (At & { t: "number"; text: string })
  | (At & { t: "literal"; value: "true" | "false" | "null" });

const MAX_JSON_DEPTH = 100;

function readJson(text: string): J {
  const cs = Array.from(text);
  let i = 0, line = 1, col = 1;
  const fail = (code: string, m: string, at: At = { line, column: col }): never => { throw new SyntaxError_(code, at.line, at.column, m); };
  const peek = () => cs[i];
  const next = () => { const c = cs[i++]; if (c === "\n") { line++; col = 1; } else col++; return c; };
  const ws = () => { while (peek() !== undefined && " \t\n\r".includes(peek()!)) next(); };
  const end = () => fail("unexpected-end", "the plan ended early; is a } or ] missing?");
  const value = (depth: number): J => {
    ws();
    const at = { line, column: col }, c = peek();
    if (c === undefined) return end();
    if ((c === "{" || c === "[") && depth >= MAX_JSON_DEPTH) fail("too-deep", `JSON nested deeper than ${MAX_JSON_DEPTH}`);
    if (c === "{") {
      next(); ws();
      const entries: { key: string; keyAt: At; value: J }[] = [];
      if (peek() === "}") { next(); return { t: "object", entries, ...at }; }
      for (;;) {
        ws();
        if (peek() === undefined) end();
        if (peek() !== '"') fail("bad-json", "a key in quotes was expected");
        const keyAt = { line, column: col }, key = str();
        if (entries.some(e => e.key === key)) fail("bad-json", `the key ${JSON.stringify(key)} appears twice`, keyAt);
        ws();
        if (peek() === undefined) end();
        if (peek() !== ":") fail("bad-json", "':' was expected");
        next();
        entries.push({ key, keyAt, value: value(depth + 1) });
        ws();
        if (peek() === undefined) end();
        if (peek() === ",") { next(); continue; }
        if (peek() === "}") { next(); return { t: "object", entries, ...at }; }
        fail("bad-json", "',' or '}' was expected");
      }
    }
    if (c === "[") {
      next(); ws();
      const items: J[] = [];
      if (peek() === "]") { next(); return { t: "array", items, ...at }; }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (peek() === undefined) end();
        if (peek() === ",") { next(); continue; }
        if (peek() === "]") { next(); return { t: "array", items, ...at }; }
        fail("bad-json", "',' or ']' was expected");
      }
    }
    if (c === '"') return { t: "string", value: str(), ...at };
    for (const w of ["true", "false", "null"] as const)
      if (cs.slice(i, i + w.length).join("") === w) { for (const _ of w) next(); return { t: "literal", value: w, ...at }; }
    let s = "";
    while (peek() !== undefined && /[-+.eE0-9]/.test(peek()!)) s += next();
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(s))
      fail("bad-json", s ? `${s} is not a JSON number` : `character ${JSON.stringify(c)} is not allowed here`, at);
    return { t: "number", text: s, ...at };
  };
  const str = (): string => {
    const at = { line, column: col };
    next();
    let out = "";
    for (;;) {
      const c = peek();
      if (c === undefined) fail("unclosed-text", "this text is not closed", at);
      if (c === '"') { next(); return out; }
      if (c.codePointAt(0)! < 0x20) fail("bad-json", "a control character must be escaped inside a JSON string");
      if (c !== "\\") { out += next(); continue; }
      next();
      const e = peek();
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (e !== undefined && e in simple) { next(); out += simple[e]; continue; }
      if (e !== "u") fail("bad-escape", "not a JSON escape");
      next();
      let h = "";
      for (let k = 0; k < 4; k++) h += peek() !== undefined && /[0-9a-fA-F]/.test(peek()!) ? next() : fail("bad-escape", "\\u needs four hex digits");
      out += String.fromCharCode(parseInt(h, 16));   // surrogate pairs combine in the string
    }
  };
  if (cs.length > limits.maxLength) fail("too-long", `the plan is longer than ${limits.maxLength} characters`, { line: 1, column: 1 });
  const root = value(0);
  ws();
  if (peek() !== undefined) fail("trailing-content", "there is content after the plan; a JSON plan is a single object");
  return root;
}

// --- From JSON to the plan's tree ---------------------------------------------------------------------

const OPERATORS = ["+", "-", "*", "/", "=", "!=", "<", ">", "<=", ">=", "and", "or", "not"];
const EXPRESSION_KEYS = ["var", "call", "let", "for_each", "if", "do", "stop", "list", "record", "get", "op"];
const FORMS = new Set(["plan", "let", "for-each", "if", "do", "stop", "list", "record", "get", ...OPERATORS]);

/** Reads a plan written in the JSON syntax into the tree of the s-expression it stands for. */
export function readJsonPlan(text: string): Node {
  const root = readJson(text);
  let tokens = 0;
  const count = () => { if (++tokens > limits.maxTokens) throw new SyntaxError_("too-large", 1, 1, `the plan has more than ${limits.maxTokens} tokens`); };
  const bad = (at: At, m: string): never => { throw new SyntaxError_("bad-form", at.line, at.column, m); };
  const list = (at: At, items: Node[], depth: number): Node => {
    if (depth >= limits.maxDepth) throw new SyntaxError_("too-deep", at.line, at.column, `lists nested deeper than ${limits.maxDepth}`);
    count();
    return { kind: "list", items, line: at.line, column: at.column };
  };
  const name = (j: J, what: string): Node => {
    if (j.t !== "string") return bad(j, `${what} is a name in quotes`);
    if (!isNameAtom(j.value)) throw new SyntaxError_("bad-token", j.line, j.column, `${JSON.stringify(j.value)} is not a name`);
    count();
    return { kind: "name", value: j.value, line: j.line, column: j.column };
  };
  const head = (value: string, at: At): Node => { count(); return { kind: "name", value, line: at.line, column: at.column }; };
  const keys = (o: J & { t: "object" }, required: string[], optional: string[] = []) => {
    for (const e of o.entries) if (!required.includes(e.key) && !optional.includes(e.key))
      bad(e.keyAt, `${JSON.stringify(e.key)} does not belong here; this object has ${[...required, ...optional].map(k => JSON.stringify(k)).join(", ")}`);
    for (const k of required) if (!o.entries.some(e => e.key === k)) bad(o, `this object needs ${JSON.stringify(k)}`);
    const get = (k: string) => o.entries.find(e => e.key === k);
    return get;
  };
  const array = (j: J | undefined, what: string, at: At): J[] => {
    if (!j) return [];
    if (j.t !== "array") return bad(j, `${what} is a list [...]`);
    return j.items;
  };
  /** [{"name": NAME, "value": EXPR}, ...] as NAME EXPR ... */
  const pair = (j: J, depth: number): [Node, Node] => {
    if (j.t !== "object") return bad(j, 'this is {"name": ..., "value": ...}');
    const get = keys(j, ["name", "value"]);
    return [name(get("name")!.value, "name"), expr(get("value")!.value, depth)];
  };
  const expr = (j: J, depth: number): Node => {
    if (j.t === "string") { count(); return { kind: "text", value: j.value, line: j.line, column: j.column }; }
    if (j.t === "number") {
      const v = parseNumber(j.text);
      if (!v) throw new SyntaxError_("bad-token", j.line, j.column, `${j.text}: a number is written with digits and at most one decimal point, no exponent`);
      count();
      return { kind: "number", value: v, text: j.text, line: j.line, column: j.column };
    }
    if (j.t === "literal") return bad(j, `${j.value} is not part of a plan; conditions are comparisons, and an absent value is left out`);
    if (j.t === "array") return bad(j, 'a list of values is {"list": [...]}');
    // the object's own list sits at DEPTH, its parts at D
    const form = j.entries.map(e => e.key).find(k => EXPRESSION_KEYS.includes(k)) ?? j.entries[0]?.key;
    const d = depth + 1;
    switch (form) {
      case "var": {
        const get = keys(j, ["var"]);
        return name(get("var")!.value, "var");
      }
      case "call": {
        const get = keys(j, ["call"], ["args"]);
        const op = name(get("call")!.value, "call") as { value: string };
        if (FORMS.has(nameFold(op.value)))
          bad(get("call")!.value, `${op.value} is not an operation; write it as {"${op.value}": ...}`);
        const args = array(get("args")?.value, "args", j).flatMap(a => pair(a, d));
        return list(j, [op as Node, ...args], depth);
      }
      case "let": {
        const get = keys(j, ["let", "body"]);
        const bindings = array(get("let")!.value, "let", j).map(b => { const [n, v] = pair(b, d + 2); return list(b, [n, v], d + 1); });
        return list(j, [head("let", get("let")!.keyAt), list(get("let")!.value, bindings, d), ...body(get("body")!.value, d)], depth);
      }
      case "for_each": {
        const get = keys(j, ["for_each", "body"]);
        const [n, v] = pair(get("for_each")!.value, d + 1);
        return list(j, [head("for-each", get("for_each")!.keyAt), list(get("for_each")!.value, [n, v], d), ...body(get("body")!.value, d)], depth);
      }
      case "if": {
        const get = keys(j, ["if", "then"], ["else"]);
        const e = get("else");
        const parts = [head("if", get("if")!.keyAt), expr(get("if")!.value, d), expr(get("then")!.value, d)];
        if (e && !(e.value.t === "literal" && e.value.value === "null")) parts.push(expr(e.value, d));
        return list(j, parts, depth);
      }
      case "do": case "stop": case "list": {
        const get = keys(j, [form]);
        return list(j, [head(form, get(form)!.keyAt), ...array(get(form)!.value, form, j).map(x => expr(x, d))], depth);
      }
      case "record": {
        const get = keys(j, ["record"]);
        return list(j, [head("record", get("record")!.keyAt), ...array(get("record")!.value, "record", j).flatMap(f => pair(f, d))], depth);
      }
      case "get": {
        const get = keys(j, ["get", "field"]);
        return list(j, [head("get", get("get")!.keyAt), expr(get("get")!.value, d), name(get("field")!.value, "field")], depth);
      }
      case "op": {
        const get = keys(j, ["op", "args"]);
        const op = get("op")!.value;
        if (op.t !== "string" || !OPERATORS.includes(op.value)) return bad(op, `op is one of ${OPERATORS.join(" ")}`);
        return list(j, [head(op.value, op), ...array(get("args")!.value, "args", j).map(x => expr(x, d))], depth);
      }
      default:
        return bad(j, form === undefined ? "an empty object is not an expression"
          : `${JSON.stringify(form)} is not an expression; an object starts with one of "var", "call", "let", "for_each", "if", "do", "stop", "list", "record", "get", "op"`);
    }
  };
  const body = (j: J, depth: number): Node[] => array(j, "body", j).map(x => expr(x, depth));
  if (root.t !== "object" || !root.entries.some(e => e.key === "plan")) return bad(root, 'a JSON plan is {"plan": "title", "body": [...]}');
  const get = keys(root, ["plan", "body"]);
  const title = get("plan")!.value;
  if (title.t !== "string") return bad(title, "the plan's title is a text");
  count(); count(); count();
  return { kind: "list", line: root.line, column: root.column, items: [
    { kind: "name", value: "plan", ...get("plan")!.keyAt },
    { kind: "text", value: title.value, line: title.line, column: title.column },
    ...body(get("body")!.value, 1),
  ] };
}

// --- From the s-expression to JSON ---------------------------------------------------------------------

const q = (s: string) => JSON.stringify(s);

/** The JSON text of an expression, or null where it has a shape the JSON syntax cannot write (a malformed form). */
export function nodeToJson(n: Node): string | null {
  if (n.kind === "text") return q(n.value);
  if (n.kind === "number") return n.text;          // as written: 12.50 stays 12.50
  if (n.kind === "name") return `{"var": ${q(n.value)}}`;
  const [h, ...rest] = n.items;
  if (!h || h.kind !== "name") return null;
  const all = (xs: Node[]) => { const out = xs.map(nodeToJson); return out.some(x => x === null) ? null : out as string[]; };
  const pairs = (xs: Node[]): string[] | null => {
    if (xs.length % 2) return null;
    const out: string[] = [];
    for (let k = 0; k < xs.length; k += 2) {
      const v = nodeToJson(xs[k + 1]);
      if (xs[k].kind !== "name" || v === null) return null;
      out.push(`{"name": ${q((xs[k] as { value: string }).value)}, "value": ${v}}`);
    }
    return out;
  };
  const arr = (xs: string[]) => `[${xs.join(", ")}]`;
  const f = nameFold(h.value);
  if (f === "let" || f === "for-each") {
    const b = rest[0], bodyJ = all(rest.slice(1));
    if (!b || b.kind !== "list" || !bodyJ) return null;
    if (f === "for-each") { const p = pairs(b.items); return p && p.length === 1 ? `{"for_each": ${p[0]}, "body": ${arr(bodyJ)}}` : null; }
    const bs: string[] = [];
    for (const x of b.items) { const p = x.kind === "list" ? pairs(x.items) : null; if (!p || p.length !== 1) return null; bs.push(p[0]); }
    return `{"let": ${arr(bs)}, "body": ${arr(bodyJ)}}`;
  }
  if (f === "if") {
    const a = all(rest);
    if (!a || a.length < 2 || a.length > 3) return null;
    return `{"if": ${a[0]}, "then": ${a[1]}${a.length === 3 ? `, "else": ${a[2]}` : ""}}`;
  }
  if (f === "do" || f === "stop" || f === "list") { const a = all(rest); return a && `{${q(f)}: ${arr(a)}}`; }
  if (f === "record") { const p = pairs(rest); return p && `{"record": ${arr(p)}}`; }
  if (f === "get") {
    const r = rest[0] ? nodeToJson(rest[0]) : null;
    return rest.length === 2 && r !== null && rest[1].kind === "name" ? `{"get": ${r}, "field": ${q(rest[1].value)}}` : null;
  }
  if (OPERATORS.includes(f)) { const a = all(rest); return a && `{"op": ${q(f)}, "args": ${arr(a)}}`; }
  if (FORMS.has(f)) return null;
  const p = pairs(rest);
  return p && (p.length ? `{"call": ${q(h.value)}, "args": ${arr(p)}}` : `{"call": ${q(h.value)}}`);
}

/** The JSON text of an s-expression plan's tree, or null if it has a shape the JSON syntax cannot write. */
export function planToJson(root: Node): string | null {
  if (root.kind !== "list") return null;
  const [p, title, ...rest] = root.items;
  if (!p || p.kind !== "name" || nameFold(p.value) !== "plan" || !title || title.kind !== "text") return null;
  const body: string[] = [];
  for (const x of rest) { const j = nodeToJson(x); if (j === null) return null; body.push(j); }
  return `{"plan": ${q(title.value)}, "body": [${body.join(", ")}]}`;
}

// --- A JSON Schema of the syntax, for structured output ------------------------------------------------

export function planJsonSchema(): Json {
  const ref = { $ref: "#/$defs/expr" };
  const str = { type: "string" };
  const arr = (items: Json) => ({ type: "array", items });
  const obj = (props: { [k: string]: Json }, required = Object.keys(props)) =>
    ({ type: "object", properties: props, required, additionalProperties: false });
  const pair = { $ref: "#/$defs/pair" };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "soz plan (JSON syntax, SPEC 2.1)",
    ...obj({ plan: { type: "string", description: "The plan's title" }, body: arr(ref) }),
    $defs: {
      pair: obj({ name: str, value: ref }),
      expr: { anyOf: [
        { type: "string", description: "a text" },
        { type: "number", description: "a number: digits, at most one decimal point" },
        obj({ var: str }),
        obj({ call: { type: "string", description: "an operation" }, args: arr(pair) }),
        obj({ let: arr(pair), body: arr(ref) }),
        obj({ for_each: pair, body: arr(ref) }),
        obj({ if: ref, then: ref, else: { anyOf: [ref, { type: "null" }] } }, ["if", "then", "else"]),
        obj({ do: arr(ref) }), obj({ stop: arr(ref) }), obj({ list: arr(ref) }),
        obj({ record: arr(pair) }),
        obj({ get: ref, field: str }),
        obj({ op: { enum: OPERATORS }, args: arr(ref) }),
      ] },
    },
  } as unknown as Json;
}
