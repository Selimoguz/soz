// run.ts — Preview, approval, execution, journal and audit record (SPEC 10), and the policy applied
// with argument values (SPEC 12).

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import {
  Rational, type Json, type HostValue, isObject, newObject, canonicalJson, compareCodePoints, sha256Hex, fold, nameFold, parseJson,
} from "./exact.ts";
import {
  type Node, type Operation, type Operations, type Type, type Rule, type Actor, type CheckResult,
  readPlan, checkPlan, typeName, isSideEffect, ruleConcerns, ruleArgsMatch, UNKNOWN, limits, errorReport,
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

// --- Journal and audit record ------------------------------------------------------------------------------

type JournalEntry = { key: string; status: string; result: Json };

export class Journal {
  entries = new Map<string, JournalEntry>();
  path: string | null;
  constructor(path: string | null = null) { this.path = path; }
  /** A journal kept in a file (one JSON object per line), loaded if it exists. */
  static open(path: string): Journal {
    const j = new Journal(path);
    if (existsSync(path))
      for (const line of readFileSync(path, "utf8").split("\n")) if (line.trim()) {
        const e = parseJson(line) as { key: string; status: string; result: Json };
        j.entries.set(e.key, e);
      }
    return j;
  }
  get(key: string): JournalEntry | undefined { return this.entries.get(key); }
  put(key: string, status: string, result: unknown) {
    const line = canonicalJson({ key, status, result: result ?? null });
    this.entries.set(key, parseJson(line) as JournalEntry);
    if (this.path) appendFileSync(this.path, line + "\n", "utf8");
  }
}

export class Audit {
  path: string | null; seq = 0; prev = "0".repeat(64); lines: string[] = [];
  constructor(path: string | null = null) { this.path = path; }
  /** Continues the chain from the file's last line, so a restart never starts a second chain. */
  static open(path: string): Audit {
    const a = new Audit(path);
    if (existsSync(path)) {
      const last = readFileSync(path, "utf8").split("\n").filter(l => l.trim()).pop();
      if (last) { a.seq = Number(((parseJson(last) as { seq: Rational }).seq).n); a.prev = sha256Hex(last); }
    }
    return a;
  }
  append(type: string, data: unknown) {
    const line = canonicalJson({ seq: Rational.of(++this.seq), type, time: new Date().toISOString().replace(/\.\d+Z$/, "Z"), prev: this.prev, data });
    this.prev = sha256Hex(line);
    this.lines.push(line);
    if (this.path) appendFileSync(this.path, line + "\n", "utf8");
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
    if (!ruleConcerns(r, op, c.actor) || !ruleArgsMatch(r, args)) continue;
    const d = r.decision;
    if ("deny" in d) denials.push([r.name, d.deny]);
    else if ("approve" in d && isSideEffect(op.effect)
             && !requires.some(x => x.role === d.approve && x.fourEyes === d.fourEyes && x.rule === r.name))
      requires.push({ role: d.approve, fourEyes: d.fourEyes, rule: r.name });
  }
  return { denials, requires };
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
  index: number; operation: Operation; args: RecordV; key: string; alreadyDone: boolean;
  status?: string; result?: Value; requires: Requirement[];
};

type Ctx = {
  mode: "preview" | "execute"; steps: Step[]; ops: Operations; impls: Implementations;
  journal: Journal; audit: Audit | null; previewed: Step[]; policy: Rule[]; actor: Actor | null; approvers: Actor[];
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
  return evalCall(c, c.ops.get(k)!, args, env);
}

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

async function evalCall(c: Ctx, op: Operation, args: Node[], env: Env): Promise<Value> {
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
  const done = c.journal.get(key);
  const st: Step = { index, operation: op, args: new RecordV(argv), key, alreadyDone: !!done, requires: [] };
  c.steps.push(st);

  if (c.mode === "preview") {
    const { denials, requires } = stepPolicy(c, op, argv);
    st.requires = requires;
    if (denials.length) problem("policy-denied", `step ${index}: ${denialText(op, denials)}`);
    if (c.steps.slice(0, -1).some(s => s.key === key))
      problem("duplicate-step", `step ${index} (${op.name}) is the same as an earlier step: same operation, same key ${key}`);
    return new Pending(index);
  }

  const p = c.previewed.find(s => s.index === index);
  if (!(p && p.operation.name === op.name && argsMatch(p.args, st.args))) {
    st.status = "not_run";
    throw new PlanHalted("changed", p
      ? `step ${index}: approved ${p.operation.name} ${canonicalJson(p.args)}, now ${op.name} ${canonicalJson(st.args)}`
      : `step ${index} (${op.name}) was not in the approved preview`);
  }
  const { denials, requires } = stepPolicy(c, op, argv);
  st.requires = requires;
  if (denials.length) { st.status = "not_run"; throw new PlanHalted("denied", `step ${index}: ${denialText(op, denials)}`); }
  const unmet = done ? [] : unmetRequirements(requires, c.approvers, c.actor);
  if (unmet.length) {
    st.status = "not_run";
    throw new PlanHalted("not-approved", `step ${index} (${op.name}) needs ${requirementsText(unmet, c.actor)}`);
  }
  if (done) { st.status = "already_done"; return fromHostOrAny(done.result, op); }
  let raw: HostValue;
  try { raw = await callImplementation(c, op, argv); }
  catch (e) {
    if (e instanceof OperationFailed) {
      st.status = "failed";
      c.audit?.append("call", { step: Rational.of(index), operation: op.name, args: st.args, status: "failed", message: e.message });
      throw new PlanHalted("failed", `step ${index} (${op.name}) failed: ${e.message}`);
    }
    if (e instanceof OperationUnknown) {
      st.status = "unknown";
      c.journal.put(key, "unknown", null);
      c.audit?.append("call", { step: Rational.of(index), operation: op.name, args: st.args, status: "unknown", message: e.message });
      throw new PlanHalted("unknown", `step ${index} (${op.name}): the outcome is unknown (${e.message}); it will not be run again by itself`);
    }
    throw e;
  }
  const v = fromHost(raw!, op.returns, op.name);
  st.status = "done"; st.result = v;
  c.journal.put(key, "done", v);
  c.audit?.append("call", { step: Rational.of(index), operation: op.name, args: st.args, status: "done", result: v });
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
  journal?: Journal; audit?: Audit | null; policy?: Rule[]; actor?: Actor | null;
};

const planBody = (text: string): Node[] => (readPlan(text) as { items: Node[] }).items.slice(2);

const requiresJson = (rs: Requirement[]) => rs.map(r => ({ role: r.role, four_eyes: r.fourEyes, rule: r.rule }));
export const stepsJson = (steps: Step[]) => steps.map(s => ({
  index: Rational.of(s.index), operation: s.operation.name, effect: s.operation.effect, args: s.args, key: s.key,
  already_done: s.alreadyDone, requires: requiresJson(s.requires),
}));

/** Dry run (SPEC 10.3): reads run, side effects become steps, the policy applies (SPEC 12). */
export async function preview(text: string, o: RunOptions): Promise<Preview> {
  const message = o.message ?? null, policy = o.policy ?? [], actor = o.actor ?? null, journal = o.journal ?? new Journal();
  const check = checkPlan(text, { message, operations: o.operations, policy, actor });
  const c: Ctx = { mode: "preview", steps: [], ops: o.operations, impls: o.implementations, journal, audit: o.audit ?? null,
                   previewed: [], policy, actor, approvers: [] };
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
  }
  const steps = c.steps;
  const hash = status === "ready" || status === "stopped"
    ? sha256Hex(canonicalJson({ plan: text, message, steps: steps.map(s => ({ operation: s.operation.name, args: s.args, key: s.key })) }))
    : null;
  c.audit?.append("preview", { plan: text, message, valid: check.valid, actor, status, steps: stepsJson(steps), hash, stop_reason: reason });
  return { text, message, check, status, steps, problems, stopReason: reason, hash, used: false, actor, policy, operations: o.operations };
}

export type ExecuteOptions = {
  implementations: Implementations; journal?: Journal; audit?: Audit | null; approvers?: Actor[]; approvedBy?: string;
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
    audit?.append("outcome", { outcome: "not-approved", message: requirementsText(unmet, p.actor) });
    return { outcome: "not-approved", steps: [], message: `this plan needs ${requirementsText(unmet, p.actor)}; nothing ran`, stopReason: null };
  }
  if (!p.hash || approval !== p.hash || p.used) {
    audit?.append("outcome", { outcome: "not-approved" });
    return { outcome: "not-approved", steps: [], stopReason: null,
             message: p.used ? "this preview was already executed; an approval is for one execution" : "the approval does not match this preview; nothing ran" };
  }
  p.used = true;
  audit?.append("approval", { hash: approval, by: o.approvedBy ?? "unknown", approvers: approvers.map(a => ({ id: a.id, roles: a.roles })) });
  const c: Ctx = { mode: "execute", steps: [], ops: p.operations, impls: o.implementations, journal, audit,
                   previewed: p.steps, policy: p.policy, actor: p.actor, approvers };
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
  audit?.append("outcome", { outcome, message, stop_reason: reason, steps: all.map(s => ({ index: Rational.of(s.index), status: s.status })) });
  return { outcome, steps: all, message, stopReason: reason };
}

export function previewSummary(p: Preview): string {
  let o = `Plan: ${p.check.title}\n`;
  if (p.status === "invalid") return o + errorReport(p.check);
  if (p.steps.length) {
    o += "If you approve, these will happen:\n";
    for (const s of p.steps) {
      o += `  ${s.index}. ${s.operation.name}` + s.args.fields.map(([k, v]) => ` ${k}=${valueText(v)}`).join("")
        + (s.alreadyDone ? " (already done before; will not run again)" : "") + "\n";
      if (s.requires.length && !s.alreadyDone) o += `     needs ${requirementsText(s.requires, p.actor)}\n`;
    }
  }
  if (p.stopReason) o += `The plan stops: ${p.stopReason}\n`;
  for (const pr of p.problems) o += `Cannot run: ${pr.message}\n`;
  if (p.status === "nothing") o += "Nothing to do.\n";
  if (p.hash) o += `Preview: ${p.hash.slice(0, 12)}\n`;
  return o;
}
