// checker.ts — The soz reader and checker (SPEC 2 to 9) and the policy rules decided from the text
// (SPEC 12). Nothing in a plan is ever evaluated here.

import {
  Rational, type Json, isObject, fold, nameFold, isAlphanumeric, compareCodePoints,
} from "./exact.ts";

export const limits = { maxLength: 20000, maxDepth: 32, maxTokens: 5000, maxList: 50, maxCalls: 500 };

// --- Reader (SPEC 2) ---------------------------------------------------------------------------------

export type Node =
  | { kind: "list"; items: Node[]; line: number; column: number }
  | { kind: "text"; value: string; line: number; column: number }
  | { kind: "number"; value: Rational; text: string; line: number; column: number }
  | { kind: "name"; value: string; line: number; column: number };

export class SyntaxError_ extends Error {
  code: string; line: number; column: number;
  constructor(code: string, line: number, column: number, message: string) {
    super(message);
    this.code = code; this.line = line; this.column = column;
  }
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isAtomChar = (c: string) => isAlphanumeric(c) || "-_.?!<>=+*/".includes(c);
const isDecimalDigit = (c: string) => /^\p{Nd}$/u.test(c);

/** -?[0-9]+(\.[0-9]+)? as an exact number, or null. */
export function parseNumber(s: string): Rational | null {
  return /^-?[0-9]+(\.[0-9]+)?$/.test(s) ? Rational.parse(s) : null;
}

export function readPlan(text: string): Node {
  const cs = Array.from(text);
  let i = 0, line = 1, col = 1, tokens = 0;
  const failAt = (code: string, l: number, c: number, m: string): never => { throw new SyntaxError_(code, l, c, m); };
  const fail = (code: string, m: string): never => failAt(code, line, col, m);
  const peek = (): string | undefined => cs[i];
  const next = (): string => {
    const c = cs[i++];
    if (c === "\n") { line++; col = 1; } else col++;
    return c;
  };
  const skip = () => {
    for (;;) {
      const c = peek();
      if (c === undefined) return;
      if (isSpace(c)) next();
      else if (c === ";") { while (peek() !== undefined && peek() !== "\n") next(); }
      else return;
    }
  };
  const item = (depth: number): Node => {
    skip();
    const c = peek(), l = line, cl = col;
    if (c !== undefined && c !== ")" && ++tokens > limits.maxTokens)
      fail("too-large", `the plan has more than ${limits.maxTokens} tokens`);
    if (c === undefined) return fail("unexpected-end", "the plan ended early; is a parenthesis missing?");
    if (c === "(") {
      if (depth >= limits.maxDepth) fail("too-deep", `lists nested deeper than ${limits.maxDepth}`);
      next();
      const items: Node[] = [];
      for (;;) {
        skip();
        const c2 = peek();
        if (c2 === undefined) failAt("unclosed-list", l, cl, "this list is not closed");
        if (c2 === ")") { next(); return { kind: "list", items, line: l, column: cl }; }
        items.push(item(depth + 1));
      }
    }
    if (c === ")") return fail("unexpected-close", "unexpected closing parenthesis");
    if (c === '"') {
      next();
      let s = "";
      for (;;) {
        const c2 = peek();
        if (c2 === undefined) failAt("unclosed-text", l, cl, "this text is not closed");
        if (c2 === '"') { next(); return { kind: "text", value: s, line: l, column: cl }; }
        if (c2 === "\\") {
          next();
          const e = peek();
          if (e === undefined || !'"\\'.includes(e)) fail("bad-escape", 'only \\" and \\\\ are allowed after a backslash');
          s += next();
        } else s += next();
      }
    }
    if (isAtomChar(c)) {
      let s = "";
      while (peek() !== undefined && isAtomChar(peek()!)) s += next();
      const p = peek();
      if (p !== undefined && !isSpace(p) && !"();".includes(p)) fail("illegal-character", `character ${JSON.stringify(p)} is not allowed here`);
      const v = parseNumber(s);
      if (v) return { kind: "number", value: v, text: s, line: l, column: cl };
      if (isDecimalDigit(Array.from(s)[0])) return failAt("bad-token", l, cl, `${s} is neither a number nor a name`);
      return { kind: "name", value: s, line: l, column: cl };
    }
    return fail("illegal-character", `character ${JSON.stringify(c)} is not allowed (a plan has only parentheses, "texts", numbers and names)`);
  };
  if (cs.length > limits.maxLength) fail("too-long", `the plan is longer than ${limits.maxLength} characters`);
  const root = item(0);
  skip();
  if (peek() !== undefined) fail("trailing-content", "there is content after the plan; a plan is a single (plan ...) list");
  return root;
}

// --- Operations and types (SPEC 6) -------------------------------------------------------------------

export type Type =
  | "text" | "number" | "bool" | "any"
  | { kind: "list"; item: Type }
  | { kind: "record"; fields: [string, Type][] }
  | { kind: "enum"; base: "text" | "number"; values: (string | Rational)[] };

export type Param = { name: string; type: Type; required: boolean; modelAllowed: boolean };
export type Operation = { name: string; effect: string; params: Param[]; returns: Type; key: string[] | null };
export type Operations = Map<string, Operation>;

export const builtinEffects = ["read", "write", "external", "money"];
export const isSideEffect = (effect: string) => effect !== "read";

export function typeFromJson(j: Json | undefined): Type {
  if (!isObject(j)) return "any";
  const ty = j.type;
  if ((ty === "text" || ty === "number") && Array.isArray(j.enum))
    return { kind: "enum", base: ty, values: j.enum as (string | Rational)[] };
  if (ty === "text" || ty === "number" || ty === "bool" || ty === "any") return ty;
  if (ty === "list") return { kind: "list", item: typeFromJson(j.items) };
  if (ty === "record") {
    const fields: [string, Type][] = isObject(j.fields)
      ? Object.entries(j.fields).map(([k, v]) => [nameFold(k), typeFromJson(v)]) : [];
    return { kind: "record", fields: fields.sort((a, b) => compareCodePoints(a[0], b[0])) };
  }
  throw new Error(`unknown type in operation declaration: ${JSON.stringify(ty)}`);
}

export function operationFromJson(j: Json): Operation {
  if (!isObject(j) || typeof j.name !== "string") throw new Error("an operation needs a name");
  const effect = j.effect === undefined ? "write" : j.effect;
  if (typeof effect !== "string" || !/^[a-z][a-z0-9._-]*$/.test(effect)) throw new Error(`bad effect name ${JSON.stringify(effect)} in operation ${j.name}`);
  const params: Param[] = isObject(j.params) ? Object.entries(j.params).map(([name, p]) => ({
    name, type: typeFromJson(p),
    required: !(isObject(p) && p.required === false),
    modelAllowed: isObject(p) && p.model_allowed === true,
  })) : [];
  return {
    name: j.name, effect, params, returns: typeFromJson(j.returns),
    key: Array.isArray(j.key) ? (j.key as string[]) : null,
  };
}

export function operationsFromJson(list: Json): Operations {
  const ops: Operations = new Map();
  for (const j of list as Json[]) { const op = operationFromJson(j); ops.set(nameFold(op.name), op); }
  return ops;
}

/** A type in the declaration format of SPEC 6 (the inverse of typeFromJson). */
export function typeToJson(t: Type): { [k: string]: unknown } {
  if (typeof t === "string") return { type: t };
  if (t.kind === "enum") return { type: t.base, enum: t.values };
  if (t.kind === "list") return { type: "list", items: typeToJson(t.item) };
  return { type: "record", fields: Object.fromEntries(t.fields.map(([k, ft]) => [k, typeToJson(ft)])) };
}

/** An operation in the declaration format of SPEC 6 (the inverse of operationFromJson). */
export function operationToJson(op: Operation): { [k: string]: unknown } {
  const params = Object.fromEntries(op.params.map(p => [p.name, {
    ...typeToJson(p.type), ...(p.required ? {} : { required: false }), ...(p.modelAllowed ? { model_allowed: true } : {}),
  }]));
  return { name: op.name, effect: op.effect, params, returns: typeToJson(op.returns), ...(op.key ? { key: op.key } : {}) };
}

export function typeName(t: Type): string {
  if (typeof t === "string") return t;
  if (t.kind === "enum") return `${t.base}, one of ${t.values.map(v => typeof v === "string" ? JSON.stringify(v) : v.toString()).join(", ")}`;
  if (t.kind === "list") return `list of ${typeName(t.item)}`;
  return `record (${t.fields.map(f => f[0]).join(", ")})`;
}

// --- Policy (SPEC 12) ----------------------------------------------------------------------------------

export type Actor = { id: string; roles: string[] };
export type Source = "message" | "tool" | "model" | "schema";
export type Decision =
  | { deny: string | null }
  | { approve: string; fourEyes: boolean }
  | { argsFrom: [string, Source[]][] };
export type Rule = {
  name: string; operations: string[]; effects: string[]; actorRoles: string[]; actorNotRoles: string[];
  args: [string, string, Json][]; decision: Decision;
};

const conditionOps = ["=", "!=", "<", "<=", ">", ">=", "in", "not_in"];
const sourceNames: Source[] = ["message", "tool", "model", "schema"];
const asList = (x: Json | undefined): Json[] => x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];

export function actorFromJson(j: Json | undefined): Actor | null {
  return isObject(j) ? { id: j.id as string, roles: asList(j.roles) as string[] } : null;
}

export function policyFromJson(j: Json | undefined): Rule[] {
  const rules = isObject(j) ? j.rules : j;
  return asList(rules ?? []).map(r => {
    if (!isObject(r)) throw new Error("policy: a rule must be an object");
    const name = typeof r.name === "string" ? r.name : "unnamed rule";
    const w = isObject(r.when) ? r.when : {};
    const then = r.then;
    const args: [string, string, Json][] = [];
    if (isObject(w.args)) for (const [param, conds] of Object.entries(w.args)) {
      if (!isObject(conds)) throw new Error(`policy: ${name}: conditions on ${param} must be an object`);
      for (const [op, value] of Object.entries(conds)) {
        if (!conditionOps.includes(op)) throw new Error(`policy: ${name}: unknown comparison ${JSON.stringify(op)}`);
        args.push([param, op, value]);
      }
    }
    let decision: Decision;
    if (then === "deny") decision = { deny: null };
    else if (isObject(then) && then.deny !== undefined) decision = { deny: then.deny as string };
    else if (isObject(then) && then.approve_by !== undefined) decision = { approve: then.approve_by as string, fourEyes: then.four_eyes === true };
    else if (isObject(then) && isObject(then.args_from)) {
      if (args.length) throw new Error(`policy: ${name}: args_from is decided from the plan's text; it cannot depend on argument values`);
      decision = { argsFrom: Object.entries(then.args_from).map(([p, srcs]) => [p, asList(srcs).map(s => {
        if (!sourceNames.includes(s as Source)) throw new Error(`policy: ${name}: unknown source ${JSON.stringify(s)}`);
        return s as Source;
      })]) };
    } else throw new Error(`policy: ${name}: then must be "deny", {"deny": ...}, {"approve_by": ...} or {"args_from": ...}`);
    return {
      name, operations: (asList(w.operation) as string[]).map(nameFold), effects: asList(w.effect) as string[],
      actorRoles: asList(w.actor_role) as string[], actorNotRoles: asList(w.actor_not_role) as string[], args, decision,
    };
  });
}

const hasAnyRole = (actor: Actor | null, roles: string[]) => !!actor && roles.some(r => actor.roles.includes(r));

export function ruleConcerns(rule: Rule, op: Operation, actor: Actor | null): boolean {
  return (rule.operations.length === 0 || rule.operations.includes(nameFold(op.name)))
    && (rule.effects.length === 0 || rule.effects.includes(op.effect))
    && (rule.actorRoles.length === 0 || hasAnyRole(actor, rule.actorRoles))
    && (rule.actorNotRoles.length === 0 || !hasAnyRole(actor, rule.actorNotRoles));
}

export const UNKNOWN = Symbol("unknown");
export const ABSENT = Symbol("absent");

function policyEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return fold(a) === fold(b);
  if (a instanceof Rational && b instanceof Rational) return a.eq(b);
  return a === b;
}

function conditionHolds(op: string, actual: unknown, expected: Json): boolean {
  if (actual === UNKNOWN) return true;
  if (actual === ABSENT) return false;
  switch (op) {
    case "=": return policyEqual(actual, expected);
    case "!=": return !policyEqual(actual, expected);
    case "in": return asList(expected).some(e => policyEqual(actual, e));
    case "not_in": return !asList(expected).some(e => policyEqual(actual, e));
  }
  if (actual instanceof Rational && expected instanceof Rational) {
    const c = actual.cmp(expected);
    return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
  }
  return false;
}

/** ARGS: [param, value]; a parameter not given is ABSENT, a value not known yet UNKNOWN. */
export function ruleArgsMatch(rule: Rule, args: [string, unknown][]): boolean {
  return rule.args.every(([param, op, expected]) => {
    const a = args.find(x => nameFold(x[0]) === nameFold(param));
    return conditionHolds(op, a ? a[1] : ABSENT, expected);
  });
}

// --- Checker -----------------------------------------------------------------------------------------

type VType = "text" | "number" | "bool" | "list" | "record" | "none" | "any" | "error";
type Val = {
  type: VType; item?: Val; fields?: [string, Val][]; length?: number;
  sources: Source[]; invented: Node[]; allowed?: (string | Rational)[];
};

export type SozError = { code: string; line: number; column: number; message: string };
export type Call = { operation: Operation; line: number; maxCount: number; conditional: boolean };
export type CheckResult = {
  valid: boolean; errors: SozError[]; effects: string[]; requiresApproval: boolean;
  maxCalls: number; mayStop: boolean; calls: Call[]; title: string | null;
};
export type CheckOptions = { message?: string | null; operations: Operations; policy?: Rule[]; actor?: Actor | null };

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const val = (type: VType, extra: Partial<Val> = {}): Val => ({ type, sources: [], invented: [], ...extra });
const errorVal = () => val("error");

function unions(vals: Val[]): [Source[], Node[]] {
  return [uniq(vals.flatMap(v => v.sources)), uniq(vals.flatMap(v => v.invented))];
}
function derived(type: VType, vals: Val[]): Val {
  const [s, i] = unions(vals);
  return val(type, { sources: s, invented: i });
}

function join(a: Val, b: Val): Val | null {
  const [s, i] = unions([a, b]);
  if (a.type === "error" || a.type === "any") return val(a.type, { sources: s, invented: i });
  if (b.type === "error" || b.type === "any") return val(b.type, { sources: s, invented: i });
  if (a.type !== b.type) return null;
  if (a.type === "record") {
    const fa = a.fields!, fb = b.fields!;
    if (fa.length !== fb.length || !fa.every(x => fb.some(y => y[0] === x[0]))) return null;
    const fields: [string, Val][] = [];
    for (const [k, v] of fa) {
      const j = join(v, fb.find(y => y[0] === k)![1]);
      if (!j) return null;
      fields.push([k, j]);
    }
    return val("record", { sources: s, invented: i, fields });
  }
  if (a.type === "list") {
    let item: Val | undefined;
    if (!a.item) item = b.item;
    else if (!b.item) item = a.item;
    else { const j = join(a.item, b.item); if (!j) return null; item = j; }
    return val("list", { sources: s, invented: i, item });
  }
  return val(a.type, { sources: s, invented: i });
}

function valOfType(t: Type): Val {
  const s: Source[] = ["tool"];
  if (typeof t === "string") return val(t, { sources: s });
  if (t.kind === "enum") return val(t.base, { sources: s, allowed: t.values });
  if (t.kind === "list") return val("list", { sources: s, item: valOfType(t.item) });
  return val("record", { sources: s, fields: t.fields.map(([k, ft]) => [k, valOfType(ft)]) });
}

function taint(v: Val, literals: Node[]): Val {
  if (literals.length) {
    v.invented = uniq([...v.invented, ...literals]);
    if (!v.sources.includes("model")) v.sources = [...v.sources, "model"];
    if (v.item) taint(v.item, literals);
    for (const [, f] of v.fields ?? []) taint(f, literals);
  }
  return v;
}

function fits(t: Type, v: Val): boolean {
  const g = v.type;
  if (g === "error" || g === "any" || t === "any") return true;
  if (typeof t === "string") return g === t;
  if (t.kind === "enum") return fits(t.base, v);
  if (t.kind === "list") return g === "list" && (!v.item || fits(t.item, v.item));
  return g === "record" && t.fields.every(([k, ft]) => {
    const x = v.fields!.find(f => f[0] === k);
    return !!x && fits(ft, x[1]);
  });
}

function constantEqual(x: string | Rational, y: string | Rational): boolean {
  if (typeof x === "string" && typeof y === "string") return fold(x) === fold(y);
  return x instanceof Rational && y instanceof Rational && x.eq(y);
}

// Message matching (SPEC 5.1)

export function messageNumbers(message: string): Rational[] {
  const out: Rational[] = [];
  const isDigit = (k: number) => k >= 0 && k < message.length && message[k] >= "0" && message[k] <= "9";
  let i = 0;
  while (i < message.length) {
    if (!isDigit(i)) { i++; continue; }
    const start = i;
    while (i < message.length && (isDigit(i) || (".,".includes(message[i]) && isDigit(i + 1)))) i++;
    const run = message.slice(start, i);
    const count = (s: string, c: string) => s.split(c).length - 1;
    const readings = [
      /^\d+$/.test(run) ? run : null,
      (() => { const r = run.replaceAll(".", ""); return count(r, ",") <= 1 ? r.replace(",", ".") : null; })(),
      (() => { const r = run.replaceAll(",", ""); return count(r, ".") <= 1 ? r : null; })(),
      run.replace(/[^0-9]/g, ""),
    ];
    for (const r of readings) {
      const v = r === null ? null : parseNumber(r);
      if (v && !out.some(x => x.eq(v))) out.push(v);
    }
  }
  return out;
}

export function textInMessage(literal: string, message: string): boolean {
  const f = Array.from(fold(literal.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "")));
  const m = Array.from(fold(message));
  if (f.length < 2) return false;
  for (let p = 0; p + f.length <= m.length; p++) {
    if (f.every((c, k) => m[p + k] === c) && (p === 0 || !isAlphanumeric(m[p - 1]))) return true;
  }
  return false;
}

const literalText = (n: Node) => n.kind === "text" ? JSON.stringify(n.value) : n.kind === "number" ? n.text : "";

class Checker {
  errors: SozError[] = [];
  multiplier = 1;
  condition: Val | null = null;
  conditional = false;
  calls: Call[] = [];
  mayStop = false;
  message: string | null;
  ops: Operations;
  policy: Rule[];
  actor: Actor | null;

  constructor(o: CheckOptions) {
    this.message = o.message ?? null;
    this.ops = o.operations;
    this.policy = o.policy ?? [];
    this.actor = o.actor ?? null;
  }

  err(node: Node | null, code: string, message: string): Val {
    this.errors.push({ code, line: node ? node.line : 1, column: node ? node.column : 1, message });
    return errorVal();
  }

  want(node: Node, v: Val, t: Type) {
    if (!fits(t, v)) this.err(node, "type-mismatch", `expected ${typeName(t)}, got ${v.type}`);
  }

  literal(node: Node & { kind: "text" | "number" }): Val {
    const type: VType = node.kind;
    const inMessage = this.message !== null && (node.kind === "number"
      ? !node.value.isNegative() && messageNumbers(this.message).some(x => x.eq(node.value))
      : textInMessage(node.value, this.message));
    return inMessage ? val(type, { sources: ["message"] }) : val(type, { sources: ["model"], invented: [node] });
  }

  body(nodes: Node[], env: [string, Val][]): Val {
    let last = val("none");
    for (const n of nodes) last = this.expr(n, env);
    return last;
  }

  expr(node: Node, env: [string, Val][]): Val {
    switch (node.kind) {
      case "number": case "text": return this.literal(node);
      case "name": {
        const b = env.find(e => e[0] === nameFold(node.value));
        if (b) return b[1];
        const names = uniq(env.map(e => e[0])).slice(0, 12);
        return this.err(node, "unknown-name", `${node.value} is not defined${names.length ? "; names defined here: " + names.join(", ") : ""}`);
      }
      case "list": return this.form(node, env);
    }
  }

  form(node: Node & { kind: "list" }, env: [string, Val][]): Val {
    const [head, ...args] = node.items;
    if (!head) return this.err(node, "empty-form", "empty list");
    if (head.kind !== "name") return this.err(node, "bad-form", "a list must start with a name (a form or an operation)");
    const k = nameFold(head.value);
    const is = (...names: string[]) => names.includes(k);
    if (is("plan")) return this.err(node, "bad-form", "(plan ...) is only allowed at the top");
    if (is("let")) return this.let_(node, args, env);
    if (is("for-each")) return this.forEach(node, args, env);
    if (is("if")) return this.if_(node, args, env);
    if (is("do")) return args.length ? this.body(args, env) : this.err(node, "bad-form", "(do ...) needs at least one expression");
    if (is("stop")) {
      this.mayStop = true;
      if (!args.length) return this.err(node, "bad-form", '(stop "reason") must tell the user why');
      for (const a of args) this.expr(a, env);
      return val("none");
    }
    if (is("list")) return this.list(node, args, env);
    if (is("record")) return this.record(node, args, env);
    if (is("get")) return this.get(node, args, env);
    if (is("+", "-", "*", "/")) {
      if (!args.length || (k === "/" && args.length !== 2))
        this.err(node, "bad-form", `${k} needs ${k === "/" ? "two numbers" : "at least one number"}`);
      const second = args[1];
      if (k === "/" && second && second.kind === "number" && second.value.isZero())
        this.err(second, "division-by-zero", "division by zero");
      return derived("number", args.map(a => { const v = this.expr(a, env); this.want(a, v, "number"); return v; }));
    }
    if (is("=", "!=", "<", ">", "<=", ">=")) {
      if (args.length !== 2) this.err(node, "bad-form", `${k} compares two values`);
      const vs = args.map(a => this.expr(a, env));
      if (!is("=", "!=")) args.forEach((a, i) => this.want(a, vs[i], "number"));
      if (is("=", "!=") && args.length === 2) {
        // Schema constants (SPEC 5.1)
        for (let i = 0; i < 2; i++) {
          const a = args[i], other = vs[1 - i];
          if (vs[i].invented.length && (a.kind === "text" || a.kind === "number") && other.allowed
              && other.allowed.some(x => constantEqual(a.value, x)))
            vs[i] = val(vs[i].type, { sources: ["schema"] });
        }
      }
      return derived("bool", vs);
    }
    if (is("and", "or", "not")) {
      if (!args.length || (k === "not" && args.length !== 1))
        this.err(node, "bad-form", `${k} needs ${k === "not" ? "exactly one condition" : "at least one condition"}`);
      return derived("bool", args.map(a => { const v = this.expr(a, env); this.want(a, v, "bool"); return v; }));
    }
    const op = this.ops.get(k);
    if (op) return this.call(node, op, args, env);
    this.err(head, "unknown-operation", `unknown operation ${head.value}; available operations: ${[...this.ops.values()].map(o => o.name).sort().join(", ")}`);
    for (const a of args) if (a.kind === "list") this.expr(a, env);
    return errorVal();
  }

  let_(node: Node, args: Node[], env: [string, Val][]): Val {
    const [bindings, ...body] = args;
    if (!bindings || bindings.kind !== "list") return this.err(node, "bad-form", "write (let ((name value) ...) body)");
    let e = env;
    for (const b of bindings.items) {
      if (b.kind === "list" && b.items.length === 2 && b.items[0].kind === "name")
        e = [[nameFold(b.items[0].value), this.expr(b.items[1], e)], ...e];
      else this.err(b, "bad-form", "each binding is (name value)");
    }
    return body.length ? this.body(body, e) : this.err(node, "bad-form", "let has no body");
  }

  forEach(node: Node, args: Node[], env: [string, Val][]): Val {
    const spec = args[0];
    const parts = spec && spec.kind === "list" ? spec.items : [];
    if (!(parts.length === 2 && parts[0].kind === "name" && args.length > 1))
      return this.err(node, "bad-form", "write (for-each (name list) body)");
    const l = this.expr(parts[1], env);
    let n: number;
    if (l.type === "error") n = 1;
    else if (l.type === "list") n = l.length ?? limits.maxList;
    else { this.err(parts[1], "not-a-list", `for-each runs only over a list; this is ${l.type}`); n = 1; }
    const item = l.type === "list" ? (l.item ?? val("any", { sources: l.sources })) : errorVal();
    const saved = this.multiplier;
    this.multiplier *= Math.max(n, 1);
    this.body(args.slice(1), [[nameFold((parts[0] as { value: string }).value), item], ...env]);
    this.multiplier = saved;
    return val("none");
  }

  if_(node: Node, args: Node[], env: [string, Val][]): Val {
    if (args.length < 2 || args.length > 3)
      return this.err(node, "bad-form", "write (if condition then [else]); use (do ...) for several steps");
    const c = this.expr(args[0], env);
    this.want(args[0], c, "bool");
    const [savedCondition, savedConditional] = [this.condition, this.conditional];
    this.condition = this.condition ? derived("bool", [this.condition, c]) : c;
    this.conditional = true;
    const a = this.expr(args[1], env);
    const b = args[2] ? this.expr(args[2], env) : val("none");
    this.condition = savedCondition;
    this.conditional = savedConditional;
    return join(a, b) ?? val("any");
  }

  list(node: Node, args: Node[], env: [string, Val][]): Val {
    if (args.length > limits.maxList) this.err(node, "list-too-long", `the list has ${args.length} elements (at most ${limits.maxList})`);
    const vs = args.map(a => this.expr(a, env));
    let item: Val | undefined;
    if (vs.length) item = vs.reduce((x, y) => join(x, y) ?? this.err(node, "mixed-list", "all elements of a list must have the same type (records the same fields)"));
    const [s, i] = unions(vs);
    return val("list", { item, length: args.length, sources: s, invented: i });
  }

  record(node: Node, args: Node[], env: [string, Val][]): Val {
    if (args.length % 2 !== 0) this.err(node, "bad-form", "a record is written as field value pairs");
    const fields: [string, Val][] = [];
    for (let i = 0; i < args.length; i += 2) {
      const f = args[i], v = args[i + 1];
      if (f.kind !== "name") this.err(f, "bad-form", "a field name was expected");
      else if (fields.some(x => x[0] === nameFold(f.value))) this.err(f, "duplicate-field", `field ${f.value} is written twice`);
      else if (v) fields.push([nameFold(f.value), this.expr(v, env)]);
    }
    fields.sort((a, b) => compareCodePoints(a[0], b[0]));
    const [s, i] = unions(fields.map(f => f[1]));
    return val("record", { fields, sources: s, invented: i });
  }

  get(node: Node, args: Node[], env: [string, Val][]): Val {
    if (!(args.length === 2 && args[1].kind === "name")) return this.err(node, "bad-form", "write (get record field)");
    const r = this.expr(args[0], env);
    const fname = args[1] as Node & { kind: "name" };
    const f = nameFold(fname.value);
    if (r.type === "error") return r;
    if (r.type === "any") return val("any", { sources: r.sources, invented: r.invented });
    if (r.type === "record") {
      const x = r.fields!.find(y => y[0] === f);
      return x ? x[1] : this.err(args[1], "unknown-field", `there is no field ${fname.value}; fields: ${r.fields!.map(y => y[0]).join(", ")}`);
    }
    return this.err(args[0], "not-a-record", `get takes a field of a record; this is ${r.type}`);
  }

  call(node: Node, op: Operation, args: Node[], env: [string, Val][]): Val {
    const given: [string, Val][] = [], givenNodes: [string, Node][] = [];
    const sideEffect = isSideEffect(op.effect);
    if (args.length % 2 !== 0) this.err(node, "bad-form", `${op.name}: arguments are written as name value pairs`);
    for (let i = 0; i < args.length; i += 2) {
      const pn = args[i], pv = args[i + 1];
      if (pn.kind !== "name") { this.err(pn, "bad-form", "a parameter name was expected"); continue; }
      const k = nameFold(pn.value);
      const p = op.params.find(x => nameFold(x.name) === k);
      if (!p) { this.err(pn, "unknown-parameter", `${op.name} has no parameter ${pn.value}; its parameters: ${op.params.map(x => x.name).join(", ")}`); continue; }
      if (given.some(g => g[0] === k)) { this.err(pn, "duplicate-parameter", `${pn.value} is given twice`); continue; }
      if (!pv) continue;
      const v = this.expr(pv, env);
      given.push([k, v]);
      givenNodes.push([k, pv]);
      this.want(pv, v, p.type);
      if (sideEffect && !p.modelAllowed)
        for (const lit of v.invented)
          this.err(lit, "invented-value", `${literalText(lit)} is not in the message; a value the model wrote cannot go to parameter ${p.name} of ${op.name}, directly or through the result of a read that looked it up. Use the value from the message or from a read operation; if it is unknown, ask the user with (stop "...").`);
    }
    for (const p of op.params)
      if (p.required && !given.some(g => g[0] === nameFold(p.name))) this.err(node, "missing-parameter", `${op.name} needs parameter ${p.name}`);
    if (sideEffect && this.condition && this.condition.invented.length)
      this.err(node, "invented-condition", `${op.name} depends on a condition with ${this.condition.invented.map(literalText).join(", ")}, which is not in the message: an operation that changes something cannot depend on a value the model made up`);
    this.checkPolicy(node, op, given, givenNodes);
    this.calls.push({ operation: op, line: node.line, maxCount: this.multiplier, conditional: this.conditional });
    // SPEC 5.2: what an operation returns depends on what it was asked.
    const inherited = uniq(op.params.flatMap(p => {
      const g = given.find(x => x[0] === nameFold(p.name));
      return g && !p.modelAllowed ? g[1].invented : [];
    }));
    return taint(valOfType(op.returns), inherited);
  }

  checkPolicy(node: Node, op: Operation, given: [string, Val][], givenNodes: [string, Node][]) {
    for (const r of this.policy) {
      if (r.args.length || !ruleConcerns(r, op, this.actor)) continue;
      const d = r.decision;
      if ("deny" in d) this.err(node, "policy-denied", `${op.name} is not allowed here (rule "${r.name}")${d.deny ? ": " + d.deny : ""}`);
      else if ("argsFrom" in d) for (const [param, allowed] of d.argsFrom) {
        const k = nameFold(param);
        const v = given.find(g => g[0] === k)?.[1];
        if (v && v.sources.some(s => !allowed.includes(s)))
          this.err(givenNodes.find(g => g[0] === k)![1], "policy-source",
            `parameter ${param} of ${op.name} must come from ${allowed.join(" or ")} (rule "${r.name}"); this value comes from ${v.sources.join(" and ")}`);
      }
    }
  }
}

function sortErrors(errors: SozError[]): SozError[] {
  const seen = new Set<string>();
  const unique = errors.filter(e => { const k = `${e.code}@${e.line}:${e.column}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return unique.map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].line - b[0].line || a[0].column - b[0].column || a[1] - b[1]).map(x => x[0]);
}

export function effectOrder(effects: string[]): string[] {
  const custom = uniq(effects.filter(e => !builtinEffects.includes(e))).sort(compareCodePoints);
  return [...builtinEffects.filter(e => effects.includes(e)), ...custom];
}

export function checkPlan(text: string, options: CheckOptions): CheckResult {
  let root: Node;
  try { root = readPlan(text); }
  catch (e) {
    if (!(e instanceof SyntaxError_)) throw e;
    return { valid: false, errors: [{ code: e.code, line: e.line, column: e.column, message: e.message }],
             effects: [], requiresApproval: false, maxCalls: 0, mayStop: false, calls: [], title: null };
  }
  const c = new Checker(options);
  let title: string | null = null;
  const items = root.kind === "list" ? root.items : [];
  if (!(items[0]?.kind === "name" && nameFold(items[0].value) === "plan" && items[1]?.kind === "text"))
    c.err(root, "not-a-plan", 'a plan is written (plan "title" ...)');
  else if (items.length < 3) c.err(root, "empty-plan", "the plan is empty");
  else { title = (items[1] as { value: string }).value; c.body(items.slice(2), []); }
  const maxCalls = c.calls.reduce((s, x) => s + x.maxCount, 0);
  const effects = effectOrder(c.calls.map(x => x.operation.effect));
  if (maxCalls > limits.maxCalls)
    c.err(root, "too-many-calls", `the plan can make up to ${maxCalls} operation calls (at most ${limits.maxCalls}; nested loops?)`);
  const errors = sortErrors(c.errors);
  return { valid: errors.length === 0, errors, title, effects, requiresApproval: effects.some(isSideEffect),
           maxCalls, mayStop: c.mayStop, calls: c.calls };
}

export function errorReport(r: CheckResult, limit = 20): string {
  const lines = r.errors.slice(0, limit).map((e, i) => `${i + 1}. line ${e.line}, column ${e.column} [${e.code}]: ${e.message}`);
  const more = r.errors.length > limit ? `(${r.errors.length - limit} more)\n` : "";
  return `The plan did not run. Fix these and send it again:\n${lines.join("\n")}\n${more}`;
}
