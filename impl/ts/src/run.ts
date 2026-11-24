// run.ts — Preview, approval, execution, journal and audit record (SPEC 10), and the policy applied
// with argument values (SPEC 12).

import { type Profile } from "./profile.ts";
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import {
  Rational, type Json, type HostValue, isObject, newObject, canonicalJson, compareCodePoints, sha256Hex, fold, nameFold, parseJson, visible,
} from "./exact.ts";
import {
  type Node, type Operation, type Operations, type Type, type Rule, type Actor, type CheckResult, type Call,
  readPlan, checkPlan, typeName, isSideEffect, ruleConcerns, ruleArgsMatch, UNKNOWN, limits, isPlanRule, conditionHolds,
} from "./checker.ts";

// --- Run-time values ----------------------------------------------------------------------------------

export const NONE = { canonical: () => "null", toString: () => "nothing" } as const;

export class ListV {
  items: Value[];
  constructor(items: Value[]) { this.items = items; }
  canonical(): string { return canonicalJson(this.items); }
}

export class RecordV {
  fields: [string, Value][];
  constructor(fields: [string, Value][]) { this.fields = [...fields].sort((a, b) => compareCodePoints(a[0], b[0])); }
  get(name: string): Value | undefined { return this.fields.find(f => f[0] === name)?.[1]; }
  canonical(): string {
    return "{" + this.fields.map(([k, v]) => canonicalJson(k) + ":" + canonicalJson(v)).join(",") + "}";
  }
}

export class Pending {
  step: number; path: string[];
  constructor(step: number, path: string[] = []) { this.step = step; this.path = path; }
  canonical(): string { return canonicalJson(this.path.length ? { pending: Rational.of(this.step), path: this.path } : { pending: Rational.of(this.step) }); }
}

export type Value = string | Rational | boolean | typeof NONE | ListV | RecordV | Pending;

export function valueText(v: Value): string {
  if (typeof v === "string") return v;
  if (v instanceof Rational) return v.toString();
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === NONE) return "nothing";
  if (v instanceof Pending) return `(result of step ${v.step})` + v.path.map(p => "." + p).join("");
  return canonicalJson(v);
}

// --- Implementations ------------------------------------------------------------------------------------

export class OperationFailed extends Error {}
export class OperationUnknown extends Error {}

/** An implementation gets the arguments as a JSON object and returns JSON (or throws one of the above). */
export type Implementation = (args: { [k: string]: Json }) => HostValue | Promise<HostValue>;
export type Implementations = Map<string, Implementation>;

class RunProblem extends Error { code: string; constructor(code: string, m: string) { super(m); this.code = code; } }
class PlanStopped extends Error { reason: string; constructor(r: string) { super(r); this.reason = r; } }
class PlanHalted extends Error { outcome: string; constructor(o: string, m: string) { super(m); this.outcome = o; } }
const problem = (code: string, m: string): never => { throw new RunProblem(code, m); };

export function toHost(v: Value): Json {
  if (v instanceof RecordV) { const o = newObject(); for (const [k, x] of v.fields) o[k] = toHost(x); return o; }
  if (v instanceof ListV) return v.items.map(toHost);
  if (v === NONE) return null;
  if (v instanceof Pending) return null;
  return v as Json;
}

/** Numbers from a host may be bigint or JS numbers; they become exact (0.1 as written, 1/10). */
function exactHost(x: HostValue): Json {
  if (typeof x === "bigint") return Rational.of(x);
  if (typeof x === "number") return Number.isInteger(x) ? Rational.of(BigInt(x)) : Rational.parse(String(x)) ?? (x as never);
  return x as Json;
}

export function fromHost(x0: HostValue, t: Type, where: string): Value {
  const x = exactHost(x0);
  const bad = (): never => problem("bad-result", `${where} returned ${canonicalJson(x)} where ${typeName(t)} was declared`);
  if (t === "any") {
    if (isObject(x)) return new RecordV(Object.entries(x).map(([k, y]) => [nameFold(k), fromHost(y, "any", where)]));
    if (Array.isArray(x)) return fromHostList(x, "any", where);
    if (x === null) return NONE;
    return x;
  }
  if (t === "text") return typeof x === "string" ? x : bad();
  if (t === "number") return x instanceof Rational ? x : bad();
  if (t === "bool") return typeof x === "boolean" ? x : bad();
  if (t.kind === "enum") {
    const v = fromHost(x, t.base, where);
    const ok = t.values.some(e => typeof e === "string" && typeof v === "string" ? fold(e) === fold(v)
      : e instanceof Rational && v instanceof Rational && e.eq(v));
    return ok ? v : bad();
  }
  if (t.kind === "list") return Array.isArray(x) ? fromHostList(x, t.item, where) : bad();
  if (!isObject(x)) return bad();
  return new RecordV(t.fields.map(([f, ft]) => {
    const k = Object.keys(x).find(k => nameFold(k) === f);
    return [f, k === undefined ? bad() : fromHost(x[k], ft, where)];
  }));
}

function fromHostList(x: Json[], item: Type, where: string): ListV {
  if (x.length > limits.maxList) problem("list-too-long", `${where} returned ${x.length} items; a plan loops over at most ${limits.maxList}`);
  return new ListV(x.map(y => fromHost(y, item, where)));
}

// --- Journal and audit record (SPEC 10.8) -----------------------------------------------------------------

export type JournalStatus = "pending" | "done" | "unknown";
/** `args`: all the step's arguments, not only the key's (SPEC 10.8); absent in entries older versions wrote. */
export type JournalEntry = { key: string; status: JournalStatus; result: Json; args?: Json };
type Maybe<T> = T | Promise<T>;

/** Where step keys are kept. Implement it on a database to share it between hosts. */
export interface JournalStore {
  get(key: string): Maybe<JournalEntry | undefined>;
  /** Atomically: if the key has no entry, record it as pending and return null (claimed); otherwise
   * return the entry that is there (someone else claimed it first, or it was done before). Keep
   * `args` with the entry: a later step with the same key and other arguments is then a conflict. */
  claim(key: string, args?: Json): Maybe<JournalEntry | null>;
  /** `args` as given to claim; an entry keeps the ones it has when they are not given. */
  complete(key: string, status: "done" | "unknown", result: Json, args?: Json): Maybe<void>;
  /** The call did not happen: the step may run again. Also how a person resolves "it did not happen". */
  release(key: string): Maybe<void>;
}

/** Where the audit record goes. Appends from several executions must be serialized (one chain). */
export interface AuditSink {
  append(type: string, data: unknown): Maybe<void>;
}

const entryOf = (key: string, status: JournalStatus, result: unknown, args?: Json): JournalEntry =>
  parseJson(canonicalJson(args === undefined ? { key, status, result: result ?? null } : { key, status, result: result ?? null, args })) as JournalEntry;

/**
 * The journal in memory (no path) or in files (with a path). On disk, each key has a file of its own
 * in PATH.d/, created with the exclusive flag, so a claim is atomic between processes on one
 * machine; PATH itself is a log of every change, one JSON object per line.
 */
export class Journal implements JournalStore {
  private memory = new Map<string, JournalEntry>();
  readonly path: string | null;
  private dir: string | null;
  constructor(path: string | null = null) {
    this.path = path;
    this.dir = path ? path + ".d" : null;
    if (this.dir) mkdirSync(this.dir, { recursive: true });
  }
  /** A journal kept in files, with entries an older version wrote to PATH carried over. */
  static open(path: string): Journal {
    const j = new Journal(path);
    if (existsSync(path))
      for (const line of readFileSync(path, "utf8").split("\n")) if (line.trim()) {
        const e = parseJson(line) as { key: string; status: string; result: Json };
        if (e.status === "released") j.memory.delete(e.key); else j.memory.set(e.key, e as JournalEntry);
      }
    return j;
  }
  private file(key: string) { return `${this.dir}/${sha256Hex(key)}.json`; }
  private log(entry: unknown) { if (this.path) appendFileSync(this.path, canonicalJson(entry) + "\n", "utf8"); }

  get(key: string): JournalEntry | undefined {
    if (this.dir && existsSync(this.file(key))) return parseJson(readFileSync(this.file(key), "utf8")) as JournalEntry;
    return this.memory.get(key);
  }
  claim(key: string, args?: Json): JournalEntry | null {
    const existing = this.get(key);
    if (existing) return existing;
    const entry = entryOf(key, "pending", null, args);
    if (this.dir) {
      for (let tries = 0; ; tries++) {
        try { writeFileSync(this.file(key), canonicalJson(entry), { flag: "wx" }); break; }
        catch (e) {
          if ((e as { code?: string }).code === "EEXIST") return this.get(key)!;
          // Windows: a file another process is deleting (a release) cannot be created for a moment
          if (!busy(e) || tries >= 400) throw e;
          spin(5);
          const now = this.get(key);
          if (now) return now;
        }
      }
    }
    this.memory.set(key, entry);
    this.log(entry);
    return null;
  }
  complete(key: string, status: "done" | "unknown", result: Json, args?: Json) {
    const entry = entryOf(key, status, result, args ?? this.get(key)?.args);
    if (this.dir) writeFileSync(this.file(key), canonicalJson(entry));
    this.memory.set(key, entry);
    this.log(entry);
  }
  release(key: string) {
    if (this.dir && existsSync(this.file(key))) unlinkSync(this.file(key));
    this.memory.delete(key);
    this.log({ key, status: "released", result: null });
  }
  /** Writes an entry directly (preloading, and what a person records when resolving). */
  put(key: string, status: JournalStatus, result: unknown, args?: Json) { this.complete(key, status as "done", entryOf(key, status, result).result, args); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(() => r(null), ms));
const spin = (ms: number) => { const t = Date.now() + ms; while (Date.now() < t) { /* a few milliseconds, synchronously */ } };
/** On Windows, creating a file that another process is deleting fails with EPERM (or EACCES, EBUSY) for a moment. */
const busy = (e: unknown) => ["EEXIST", "EPERM", "EACCES", "EBUSY"].includes((e as { code?: string }).code ?? "");

/**
 * The audit record in memory (no path) or in a file. Writers on one machine take turns through a lock
 * file created with the exclusive flag, and each append continues from the file's actual last line,
 * so several gateways writing to one record still make one chain.
 */
export class Audit implements AuditSink {
  readonly path: string | null;
  seq = 0; prev = "0".repeat(64); lines: string[] = [];
  constructor(path: string | null = null) { this.path = path; }
  static open(path: string): Audit { return new Audit(path); }

  private lastLine(): string | undefined {
    return this.path && existsSync(this.path) ? readFileSync(this.path, "utf8").split("\n").filter(l => l.trim()).pop() : undefined;
  }
  private async lock(): Promise<() => void> {
    const lockFile = this.path + ".lock";
    for (let waited = 0; ; waited += 5) {
      try { writeFileSync(lockFile, String(Date.now()), { flag: "wx" }); return () => { try { unlinkSync(lockFile); } catch { /* already gone */ } }; }
      catch (e) {
        if (!busy(e)) throw e;
        // a writer that died holding the lock: older than 10 s is stale
        try { if (Date.now() - statSync(lockFile).mtimeMs > 10000) unlinkSync(lockFile); } catch { /* it moved on */ }
        if (waited > 30000) throw new Error(`could not lock the audit record ${this.path}`);
        await sleep(5);
      }
    }
  }
  async append(type: string, data: unknown) {
    const unlock = this.path ? await this.lock() : () => {};
    try {
      const last = this.lastLine();
      if (last) { this.seq = Number(((parseJson(last) as { seq: Rational }).seq).n); this.prev = sha256Hex(last); }
      const line = canonicalJson({ seq: Rational.of(++this.seq), type, time: new Date().toISOString().replace(/\.\d+Z$/, "Z"), prev: this.prev, data });
      this.prev = sha256Hex(line);
      this.lines.push(line);
      if (this.path) appendFileSync(this.path, line + "\n", "utf8");
    } finally { unlock(); }
  }
}

/** True if every line's prev is the SHA-256 of the line before it; else the first bad line number. */
export function verifyAudit(path: string): true | number {
  let prev = "0".repeat(64), n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    n++;
    if ((parseJson(line) as { prev: string }).prev !== prev) return n;
    prev = sha256Hex(line);
  }
  return true;
}

// --- Policy with values --------------------------------------------------------------------------------

export type Requirement = { role: string; fourEyes: boolean; rule: string };

function stepPolicy(c: Ctx, op: Operation, argv: [string, Value][]): { denials: [string, string | null][]; requires: Requirement[] } {
  const args: [string, unknown][] = argv.map(([k, v]) => [k, v instanceof Pending ? UNKNOWN : v]);
  const denials: [string, string | null][] = [], requires: Requirement[] = [];
  for (const r of c.policy) {
    if (isPlanRule(r) || !ruleConcerns(r, op, c.actor) || !ruleArgsMatch(r, args)) continue;
    const d = r.decision;
    if ("deny" in d) denials.push([r.name, d.deny]);
    else if ("approve" in d && isSideEffect(op.effect)
             && !requires.some(x => x.role === d.approve && x.fourEyes === d.fourEyes && x.rule === r.name))
      requires.push({ role: d.approve, fourEyes: d.fourEyes, rule: r.name });
  }
  return { denials, requires };
}

/** The rules on the whole plan (SPEC 12.3), once its steps are known: each selects the steps it concerns
 * (not those already done, which will not run), and holds if their count and the sums of its parameters
 * meet its conditions. A value not known yet makes a sum unknown, and the rule is assumed to hold. A deny
 * stops the preview; an approve_by is required of every step the rule selected. Execution runs exactly the
 * previewed arguments (10.4), so what the preview decided stands. */
function planPolicy(c: Ctx) {
  const argsOf = (s: Step): [string, unknown][] => s.args.fields.map(([k, v]) => [k, v instanceof Pending ? UNKNOWN : v]);
  for (const r of c.policy.filter(isPlanRule)) {
    const selected = c.steps.filter(s => !s.alreadyDone && ruleConcerns(r, s.operation, c.actor) && ruleArgsMatch(r, argsOf(s)));
    if (!selected.length) continue;
    const sums = new Map<string, Rational | typeof UNKNOWN>();
    for (const [param] of r.total) {
      let sum: Rational | typeof UNKNOWN = Rational.of(0);
      for (const s of selected) {
        const v = argsOf(s).find(([k]) => nameFold(k) === nameFold(param))?.[1];
        if (v === undefined) continue;                                   // not given: adds nothing
        sum = sum === UNKNOWN || !(v instanceof Rational) ? UNKNOWN : sum.add(v);
      }
      sums.set(param, sum);
    }
    const holds = r.total.every(([param, op, expected]) => conditionHolds(op, sums.get(param), expected))
      && r.count.every(([op, expected]) => conditionHolds(op, Rational.of(selected.length), expected));
    if (!holds) continue;
    const what = [...r.total.map(([param]) => { const v = sums.get(param); return `the ${param}s add up to ${v === UNKNOWN ? "an amount not known yet" : (v as Rational).toString()}`; }),
                  ...(r.count.length ? [`${selected.length} steps`] : [])].join(", ");
    const d = r.decision;
    if ("deny" in d) problem("policy-denied", `the plan is not allowed: rule "${r.name}" (${what}${d.deny ? `; ${d.deny}` : ""}), steps ${selected.map(s => s.index).join(", ")}`);
    else if ("approve" in d)
      for (const s of selected)
        if (isSideEffect(s.operation.effect) && !s.requires.some(x => x.role === d.approve && x.fourEyes === d.fourEyes && x.rule === r.name))
          s.requires.push({ role: d.approve, fourEyes: d.fourEyes, rule: r.name });
  }
}

const denialText = (op: Operation, ds: [string, string | null][]) =>
  `${op.name} is not allowed: ` + ds.map(([n, why]) => `rule "${n}"${why ? ` (${why})` : ""}`).join("; ");

export function unmetRequirements(requires: Requirement[], approvers: Actor[], actor: Actor | null): Requirement[] {
  return requires.filter(r => !approvers.some(a => a.roles.includes(r.role) && !(r.fourEyes && actor && a.id === actor.id)));
}

export function requirementsText(requires: Requirement[], actor: Actor | null): string {
  return requires.map(r => `approval by ${r.role}${r.fourEyes && actor ? ` (someone other than ${actor.id})` : ""} (rule "${r.rule}")`).join("; ");
}

// --- Evaluation -----------------------------------------------------------------------------------------

export type Step = {
  index: number; operation: Operation; args: RecordV; key: string;
  /** Its key is in the journal, with any status: it will not be called. journalStatus says which. */
  alreadyDone: boolean; journalStatus: JournalStatus | null;
  status?: string; result?: Value; requires: Requirement[];
  /** Where each argument comes from, as the checker proved it (SPEC 5): parameter -> sources. */
  sources: [string, string[]][];
};

type Ctx = {
  mode: "preview" | "execute"; steps: Step[]; ops: Operations; impls: Implementations;
  journal: JournalStore; audit: AuditSink | null; previewed: Step[]; policy: Rule[]; actor: Actor | null; approvers: Actor[];
  calls: Call[];
};

type Env = [string, Value][];

const noPending = (v: Value, what: string): Value => v instanceof Pending
  ? problem("depends-on-write", `${what} uses ${valueText(v)}, which is only known after the plan runs`) : v;
const num = (v: Value) => noPending(v, "arithmetic") as Rational;
const truthy = (v: Value) => noPending(v, "a condition") === true;

function valueEqual(a: Value, b: Value): boolean {
  if (typeof a === "string" && typeof b === "string") return fold(a) === fold(b);
  if (a instanceof Rational && b instanceof Rational) return a.eq(b);
  return canonicalJson(a) === canonicalJson(b);
}

async function evalBody(c: Ctx, body: Node[], env: Env): Promise<Value> {
  let last: Value = NONE;
  for (const n of body) last = await evalExpr(c, n, env);
  return last;
}

async function evalExpr(c: Ctx, node: Node, env: Env): Promise<Value> {
  switch (node.kind) {
    case "number": case "text": return node.value;
    case "name": return env.find(e => e[0] === nameFold(node.value))![1];
    case "list": return evalForm(c, node, env);
  }
}

async function evalForm(c: Ctx, node: Node & { kind: "list" }, env: Env): Promise<Value> {
  const [head, ...args] = node.items;
  const k = nameFold((head as { value: string }).value);
  const vals = async () => { const out: Value[] = []; for (const a of args) out.push(await evalExpr(c, a, env)); return out; };
  switch (k) {
    case "let": {
      let e = env;
      for (const b of (args[0] as { items: Node[] }).items) {
        const [n, x] = (b as { items: Node[] }).items;
        e = [[nameFold((n as { value: string }).value), await evalExpr(c, x, e)], ...e];
      }
      return evalBody(c, args.slice(1), e);
    }
    case "for-each": {
      const [n, l] = (args[0] as { items: Node[] }).items;
      const list = noPending(await evalExpr(c, l, env), "for-each") as ListV;
      for (const item of list.items) await evalBody(c, args.slice(1), [[nameFold((n as { value: string }).value), item], ...env]);
      return NONE;
    }
    case "if":
      if (truthy(await evalExpr(c, args[0], env))) return evalExpr(c, args[1], env);
      return args[2] ? evalExpr(c, args[2], env) : NONE;
    case "do": return evalBody(c, args, env);
    case "stop": throw new PlanStopped((await vals()).map(valueText).join(" "));
    case "list": return new ListV(await vals());
    case "record": {
      const fields: [string, Value][] = [];
      for (let i = 0; i < args.length; i += 2)
        fields.push([nameFold((args[i] as { value: string }).value), await evalExpr(c, args[i + 1], env)]);
      return new RecordV(fields);
    }
    case "get": {
      const r = await evalExpr(c, args[0], env);
      const f = nameFold((args[1] as { value: string }).value);
      if (r instanceof Pending) return new Pending(r.step, [...r.path, f]);
      if (r instanceof RecordV) { const x = r.get(f); return x === undefined ? problem("bad-result", `the record has no field ${f}`) : x; }
      return problem("bad-result", `get on ${valueText(r)}, which is not a record`);
    }
    case "+": return (await vals()).map(num).reduce((a, b) => a.add(b));
    case "*": return (await vals()).map(num).reduce((a, b) => a.mul(b));
    case "-": { const ns = (await vals()).map(num); return ns.length > 1 ? ns.reduce((a, b) => a.sub(b)) : ns[0].neg(); }
    case "/": {
      const ns = (await vals()).map(num);
      if (ns[1].isZero()) problem("division-by-zero", `division by zero on line ${node.line}`);
      return ns[0].div(ns[1]);
    }
    case "=": case "!=": {
      const vs = (await vals()).map(v => noPending(v, "a comparison"));
      return k === "=" ? valueEqual(vs[0], vs[1]) : !valueEqual(vs[0], vs[1]);
    }
    case "<": case ">": case "<=": case ">=": {
      const [a, b] = (await vals()).map(num);
      const x = a.cmp(b);
      return k === "<" ? x < 0 : k === ">" ? x > 0 : k === "<=" ? x <= 0 : x >= 0;
    }
    case "and": return (await vals()).every(truthy);
    case "or": return (await vals()).some(truthy);
    case "not": return !truthy((await vals())[0]);
  }
  return evalCall(c, c.ops.get(k)!, args, env, node);
}

const hasPending = (v: Value): boolean =>
  v instanceof Pending || (v instanceof RecordV && v.fields.some(f => hasPending(f[1]))) || (v instanceof ListV && v.items.some(hasPending));

export function stepKeyText(op: Operation, argv: [string, Value][]): string {
  const keys = (op.key ?? []).map(nameFold);
  const o = newObject() as { [k: string]: unknown };
  for (const [k, v] of argv) if (keys.length === 0 || keys.includes(nameFold(k))) o[k] = v;
  return canonicalJson([nameFold(op.name), o]);
}

function argsMatch(previewed: Value, actual: Value): boolean {
  if (previewed instanceof Pending) return true;
  if (previewed instanceof RecordV && actual instanceof RecordV)
    return previewed.fields.length === actual.fields.length
      && previewed.fields.every(([k, v], i) => actual.fields[i][0] === k && argsMatch(v, actual.fields[i][1]));
  if (previewed instanceof ListV && actual instanceof ListV)
    return previewed.items.length === actual.items.length && previewed.items.every((v, i) => argsMatch(v, actual.items[i]));
  return canonicalJson(previewed) === canonicalJson(actual);
}

async function callImplementation(c: Ctx, op: Operation, argv: [string, Value][]): Promise<HostValue> {
  const impl = c.impls.get(nameFold(op.name));
  if (!impl) problem("no-implementation", `the host has no implementation of ${op.name}`);
  return await impl!(toHost(new RecordV(argv)) as { [k: string]: Json });
}

const fromHostOrAny = (x: HostValue, op: Operation): Value => {
  try { return fromHost(x, op.returns, op.name); } catch (e) { if (e instanceof RunProblem) return fromHost(x, "any", op.name); throw e; }
};

async function evalCall(c: Ctx, op: Operation, args: Node[], env: Env, node: Node): Promise<Value> {
  const argv: [string, Value][] = [];
  for (let i = 0; i < args.length; i += 2) {
    const p = op.params.find(x => nameFold(x.name) === nameFold((args[i] as { value: string }).value))!;
    argv.push([p.name, await evalExpr(c, args[i + 1], env)]);
  }
  argv.sort((a, b) => compareCodePoints(a[0], b[0]));

  if (!isSideEffect(op.effect)) {
    for (const [, v] of argv) noPending(v, `${op.name} (a read)`);
    const { denials } = stepPolicy(c, op, argv);
    if (denials.length) {
      if (c.mode === "preview") problem("policy-denied", denialText(op, denials));
      throw new PlanHalted("denied", denialText(op, denials));
    }
    let raw: HostValue;
    try { raw = await callImplementation(c, op, argv); }
    catch (e) {
      if (e instanceof OperationFailed) problem("read-failed", `${op.name} failed: ${e.message}`);
      if (e instanceof OperationUnknown) problem("read-failed", `${op.name} did not answer: ${e.message}`);
      throw e;
    }
    return fromHost(raw!, op.returns, op.name);
  }

  const index = c.steps.length + 1;
  const key = stepKeyText(op, argv);
  const done = await c.journal.get(key);
  const sources = c.calls.find(x => x.line === node.line && x.column === node.column)?.sources ?? [];
  const st: Step = { index, operation: op, args: new RecordV(argv), key, alreadyDone: !!done, journalStatus: done?.status ?? null, requires: [], sources };
  c.steps.push(st);
  // The journal keeps every argument of a step, not only its key's (SPEC 10.8). The same key with
  // other arguments names the same thing done differently: neither done already nor new (10.3, 10.4).
  const argsJson = hasPending(st.args) ? undefined : parseJson(canonicalJson(st.args));
  const conflicts = (entry: JournalEntry | null | undefined): boolean =>
    !!entry && entry.args !== undefined && argsJson !== undefined && canonicalJson(entry.args) !== canonicalJson(argsJson);
  const conflictText = (entry: JournalEntry) =>
    `step ${index} (${op.name}) has the key ${key}, which is in the journal (${entry.status}) with other arguments: `
    + `${canonicalJson(entry.args)} there, ${canonicalJson(argsJson)} now. It is neither run again nor taken as done; `
    + "give it a new key (a new order number) if it is a new one, or correct the arguments";

  if (c.mode === "preview") {
    const { denials, requires } = stepPolicy(c, op, argv);
    st.requires = requires;
    if (denials.length) problem("policy-denied", `step ${index}: ${denialText(op, denials)}`);
    if (c.steps.slice(0, -1).some(s => s.key === key))
      problem("duplicate-step", `step ${index} (${op.name}) is the same as an earlier step: same operation, same key ${key}`);
    if (conflicts(done)) { st.alreadyDone = false; problem("key-conflict", conflictText(done!)); }   // neither new nor done
    return new Pending(index);
  }

  const p = c.previewed.find(s => s.index === index);
  if (!(p && p.operation.name === op.name && argsMatch(p.args, st.args))) {
    st.status = "not_run";
    throw new PlanHalted("changed", p
      ? `step ${index}: approved ${p.operation.name} ${canonicalJson(p.args)}, now ${op.name} ${canonicalJson(st.args)}`
      : `step ${index} (${op.name}) was not in the approved preview`);
  }
  if (conflicts(done)) { st.status = "not_run"; throw new PlanHalted("conflict", conflictText(done!)); }
  const { denials, requires } = stepPolicy(c, op, argv);
  st.requires = requires;
  if (denials.length) { st.status = "not_run"; throw new PlanHalted("denied", `step ${index}: ${denialText(op, denials)}`); }
  const unmet = done?.status === "done" ? [] : unmetRequirements(requires, c.approvers, c.actor);
  if (unmet.length) {
    st.status = "not_run";
    throw new PlanHalted("not-approved", `step ${index} (${op.name}) needs ${requirementsText(unmet, c.actor)}`);
  }
  const unresolved = (entry: JournalEntry): never => {
    st.status = "unresolved";
    throw new PlanHalted("unresolved", `step ${index} (${op.name}) is in the journal as ${entry.status}: `
      + (entry.status === "pending" ? "another execution is running it, or one stopped during the call" : "an earlier call's outcome is unknown")
      + "; it may have happened. A person should check and resolve it (done or released); it was not run again");
  };
  if (done?.status === "done") { st.status = "already_done"; return fromHostOrAny(done.result, op); }
  if (done) unresolved(done);
  // Claim, then call (SPEC 10.4): never twice, not even across a crash or two executions at once.
  const other = await c.journal.claim(key, argsJson);
  if (conflicts(other)) { st.status = "not_run"; throw new PlanHalted("conflict", conflictText(other!)); }
  if (other?.status === "done") { st.status = "already_done"; return fromHostOrAny(other.result, op); }
  if (other) unresolved(other);
  const record = (status: string, extra: object) => c.audit?.append("call", { step: Rational.of(index), operation: op.name, args: st.args, status, ...extra });
  let raw: HostValue;
  try { raw = await callImplementation(c, op, argv); }
  catch (e) {
    if (e instanceof RunProblem) { await c.journal.release(key); throw e; }   // no implementation: nothing was called
    if (e instanceof OperationFailed) {
      st.status = "failed";
      await c.journal.release(key);
      await record("failed", { message: e.message });
      throw new PlanHalted("failed", `step ${index} (${op.name}) failed: ${e.message}`);
    }
    st.status = "unknown";
    await c.journal.complete(key, "unknown", null, argsJson);
    await record("unknown", { message: (e as Error).message });
    throw new PlanHalted("unknown", `step ${index} (${op.name}): the outcome is unknown (${(e as Error).message}); it will not be run again by itself`);
  }
  let v: Value;
  try { v = fromHost(raw!, op.returns, op.name); }
  catch (e) {
    // It ran, but answered with something that does not fit its declaration: it happened, in some way.
    st.status = "unknown";
    await c.journal.complete(key, "unknown", null, argsJson);
    await record("unknown", { message: (e as Error).message });
    throw new PlanHalted("unknown", `step ${index} (${op.name}) ran but ${(e as Error).message}; it will not be run again by itself`);
  }
  st.status = "done"; st.result = v;
  await c.journal.complete(key, "done", parseJson(canonicalJson(v)), argsJson);
  await record("done", { result: v });
  return v;
}

// --- Preview and execute ----------------------------------------------------------------------------------

export type Preview = {
  text: string; message: string | null; check: CheckResult; status: string; steps: Step[];
  problems: { code: string; message: string }[]; stopReason: string | null; hash: string | null; used: boolean;
  actor: Actor | null; policy: Rule[]; operations: Operations;
};
export type Execution = { outcome: string; steps: Step[]; message: string | null; stopReason: string | null };

export type RunOptions = {
  message?: string | null; operations: Operations; implementations: Implementations;
  journal?: JournalStore; audit?: AuditSink | null; policy?: Rule[]; actor?: Actor | null;
  /** A language profile: number words in the message count as numbers (SPEC 5.4). */
  profile?: Profile | null;
};

const planBody = (text: string): Node[] => (readPlan(text) as { items: Node[] }).items.slice(2);

const requiresJson = (rs: Requirement[]) => rs.map(r => ({ role: r.role, four_eyes: r.fourEyes, rule: r.rule }));
export const stepsJson = (steps: Step[]) => steps.map(s => ({
  index: Rational.of(s.index), operation: s.operation.name, effect: s.operation.effect, args: s.args, key: s.key,
  already_done: s.alreadyDone, journal_status: s.journalStatus, requires: requiresJson(s.requires),
  sources: Object.fromEntries(s.sources),
}));

/** A step already in the journal, for a person: done, or unresolved (it may or may not have happened). */
export function journalNote(s: Step): string {
  if (!s.alreadyDone) return "";
  return s.journalStatus === "done" ? " (already done before; will not run again)"
    : " (an earlier run may or may not have happened; it will not run until a person resolves it)";
}

/** Where a value comes from, for a person: "from the message", "from erp", "written by the assistant". */
export function sourceText(sources: string[]): string {
  const word = (s: string) => s === "message" ? "the message" : s === "tool" ? "a tool" : s.startsWith("tool:") ? s.slice(5)
    : s === "schema" ? "a declared value" : s === "model" ? "the assistant" : s;
  const from = sources.filter(s => s !== "model").map(word);
  const parts = [...(from.length ? [`from ${from.join(" and ")}`] : []), ...(sources.includes("model") ? ["written by the assistant"] : [])];
  return parts.join(", ");
}

const argWithSource = (s: Step, k: string, v: Value) => {
  const src = s.sources.find(x => x[0] === k)?.[1] ?? [];
  return `${k}=${visible(valueText(v))}${src.length ? ` (${sourceText(src)})` : ""}`;
};

/** Dry run (SPEC 10.3): reads run, side effects become steps, the policy applies (SPEC 12). */
export async function preview(text: string, o: RunOptions): Promise<Preview> {
  const message = o.message ?? null, policy = o.policy ?? [], actor = o.actor ?? null, journal = o.journal ?? new Journal();
  const check = checkPlan(text, { message, operations: o.operations, policy, actor, profile: o.profile ?? null });
  const c: Ctx = { mode: "preview", steps: [], ops: o.operations, impls: o.implementations, journal, audit: o.audit ?? null,
                   previewed: [], policy, actor, approvers: [], calls: check.calls };
  const problems: { code: string; message: string }[] = [];
  let status: string, reason: string | null = null;
  if (!check.valid) status = "invalid";
  else {
    try { await evalBody(c, planBody(text), []); status = c.steps.length ? "ready" : "nothing"; }
    catch (e) {
      if (e instanceof PlanStopped) { status = c.steps.length ? "stopped" : "nothing"; reason = e.reason; }
      else if (e instanceof RunProblem) { status = e.code === "policy-denied" ? "denied" : "error"; problems.push({ code: e.code, message: e.message }); }
      else throw e;
    }
    if (status === "ready" || status === "stopped") {
      try { planPolicy(c); }
      catch (e) { if (!(e instanceof RunProblem)) throw e; status = "denied"; problems.push({ code: e.code, message: e.message }); }
    }
  }
  const steps = c.steps;
  const hash = status === "ready" || status === "stopped"
    ? sha256Hex(canonicalJson({ plan: text, message, steps: steps.map(s => ({ operation: s.operation.name, args: s.args, key: s.key })) }))
    : null;
  await c.audit?.append("preview", { plan: text, message, valid: check.valid, actor, status, steps: stepsJson(steps), hash, stop_reason: reason });
  return { text, message, check, status, steps, problems, stopReason: reason, hash, used: false, actor, policy, operations: o.operations };
}

export type ExecuteOptions = {
  implementations: Implementations; journal?: JournalStore; audit?: AuditSink | null; approvers?: Actor[]; approvedBy?: string;
  /** Signed approvals by other people (SPEC 11.6), kept in the approval record. */
  signatures?: string[];
};

/** Runs the approved preview (SPEC 10.4). APPROVAL must be its hash. */
export async function execute(p: Preview, approval: string, o: ExecuteOptions): Promise<Execution> {
  const audit = o.audit ?? null, journal = o.journal ?? new Journal();
  const approvers = o.approvers && o.approvers.length ? o.approvers : p.actor ? [p.actor] : [];
  const unmet = unmetRequirements(
    p.steps.filter(s => !s.alreadyDone).flatMap(s => s.requires)
      .filter((r, i, all) => all.findIndex(x => x.role === r.role && x.fourEyes === r.fourEyes && x.rule === r.rule) === i),
    approvers, p.actor);
  if (unmet.length && p.hash && approval === p.hash && !p.used) {
    await audit?.append("outcome", { outcome: "not-approved", message: requirementsText(unmet, p.actor) });
    return { outcome: "not-approved", steps: [], message: `this plan needs ${requirementsText(unmet, p.actor)}; nothing ran`, stopReason: null };
  }
  if (!p.hash || approval !== p.hash || p.used) {
    await audit?.append("outcome", { outcome: "not-approved" });
    return { outcome: "not-approved", steps: [], stopReason: null,
             message: p.used ? "this preview was already executed; an approval is for one execution" : "the approval does not match this preview; nothing ran" };
  }
  p.used = true;
  await audit?.append("approval", { hash: approval, by: o.approvedBy ?? "unknown", approvers: approvers.map(a => ({ id: a.id, roles: a.roles })),
                                    ...(o.signatures?.length ? { signatures: o.signatures } : {}) });
  const c: Ctx = { mode: "execute", steps: [], ops: p.operations, impls: o.implementations, journal, audit,
                   previewed: p.steps, policy: p.policy, actor: p.actor, approvers, calls: p.check.calls };
  let outcome: string, message: string | null = null, reason: string | null = null;
  try {
    await evalBody(c, planBody(p.text), []);
    outcome = c.steps.length < p.steps.length ? "changed" : "done";
    if (outcome === "changed") message = `the plan reached ${c.steps.length} of the ${p.steps.length} approved steps`;
  } catch (e) {
    if (e instanceof PlanStopped) { outcome = "stopped"; reason = e.reason; }
    else if (e instanceof PlanHalted) { outcome = e.outcome; message = e.message; }
    else if (e instanceof RunProblem) { outcome = "changed"; message = `${e.code}: ${e.message}`; }
    else throw e;
  }
  const reached = c.steps;
  const all: Step[] = [...reached, ...p.steps.filter(s => !reached.some(r => r.index === s.index))
    .map(s => ({ ...s, status: "not_run", result: undefined }))];
  for (const s of all) s.status ??= "not_run";
  await audit?.append("outcome", { outcome, message, stop_reason: reason, steps: all.map(s => ({ index: Rational.of(s.index), status: s.status })) });
  return { outcome, steps: all, message, stopReason: reason };
}

/** What the person approves. Everything the model or a tool wrote goes through visible(). */
export function previewSummary(p: Preview): string {
  let o = `Plan: ${visible(p.check.title ?? "")}\n`;
  if (p.status === "invalid")
    return o + "The plan did not run:\n" + p.check.errors.map((e, i) =>
      `${i + 1}. line ${e.line}, column ${e.column} [${e.code}]: ${visible(e.message)}\n`).join("");
  if (p.steps.length) {
    o += "If you approve, these will happen:\n";
    for (const s of p.steps) {
      o += `  ${s.index}. ${s.operation.name}` + s.args.fields.map(([k, v]) => ` ${argWithSource(s, k, v)}`).join("")
        + journalNote(s) + "\n";
      if (s.requires.length && !s.alreadyDone) o += `     needs ${requirementsText(s.requires, p.actor)}\n`;
    }
  }
  if (p.stopReason) o += `The plan stops: ${visible(p.stopReason)}\n`;
  for (const pr of p.problems) o += `Cannot run: ${visible(pr.message)}\n`;
  if (p.status === "nothing") o += "Nothing to do.\n";
  if (p.hash) o += `Preview: ${p.hash.slice(0, 12)}\n`;
  return o;
}
