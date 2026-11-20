// conformance.ts — Runs the language-neutral conformance suite (../../conformance) against this
// implementation. npm run conformance  (or: node --experimental-strip-types test/conformance.ts [folder])

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Rational, type Json, isObject, canonicalJson, nameFold, parseJson } from "../src/exact.ts";
import {
  type CheckResult, type Operations, type Rule, type Actor,
  checkPlan, operationsFromJson, policyFromJson, actorFromJson,
} from "../src/checker.ts";
import {
  type Implementations, type Preview, type Execution, type Step,
  preview, execute, Journal, OperationFailed, OperationUnknown, fromHost, stepKeyText,
} from "../src/run.ts";
import { profileFromJson } from "../src/profile.ts";

const here = dirname(fileURLToPath(import.meta.url));
const folder = process.argv[2] ?? join(here, "../../../conformance");
const read = (p: string) => parseJson(readFileSync(p, "utf8"));
/** A case's "profile": a name in the repository's profiles/ folder, next to conformance/. */
const profileOf = (name: Json | undefined) => typeof name === "string" ? profileFromJson(read(join(folder, "..", "profiles", `${name}.json`))) : null;
const ops: Operations = operationsFromJson(read(join(folder, "operations.json")));

let problems: string[] = [];
const problem = (m: string) => problems.push(m);
const get = (o: Json, k: string): Json | undefined => isObject(o) && k in o ? o[k] : undefined;
const has = (o: Json, k: string) => isObject(o) && k in o;
const planText = (p: Json) => typeof p === "string" ? p : (p as string[]).join("\n");
const errs = (r: CheckResult) => r.errors.map(e => `${e.code}@${e.line}:${e.column}`).join(", ");
const num = (x: Json | undefined) => x instanceof Rational ? Number(x.n) : NaN;

function compareCheck(expect: Json, r: CheckResult) {
  if (has(expect, "valid") && get(expect, "valid") !== r.valid) problem(`valid: expected ${get(expect, "valid")}, got ${r.valid} (errors: ${errs(r)})`);
  const want = (get(expect, "errors") ?? []) as Json[];
  for (const w of want) {
    const ok = r.errors.some(g => g.code === get(w, "code") && (get(w, "line") === undefined
      || (num(get(w, "line")) === g.line && num(get(w, "column")) === g.column)));
    if (!ok) problem(`missing error ${get(w, "code")}${get(w, "line") !== undefined ? ` at ${num(get(w, "line"))}:${num(get(w, "column"))}` : ""} (got: ${errs(r)})`);
  }
  if (get(expect, "only") === true && want.length !== r.errors.length) problem(`expected exactly ${want.length} error(s), got ${r.errors.length}: ${errs(r)}`);
  if (has(expect, "effects") && canonicalJson(get(expect, "effects")) !== canonicalJson(r.effects)) problem(`effects: expected ${canonicalJson(get(expect, "effects"))}, got ${canonicalJson(r.effects)}`);
  if (has(expect, "requires_approval") && get(expect, "requires_approval") !== r.requiresApproval) problem("requires_approval differs");
  if (has(expect, "may_stop") && get(expect, "may_stop") !== r.mayStop) problem(`may_stop: expected ${get(expect, "may_stop")}, got ${r.mayStop}`);
  if (has(expect, "max_calls") && num(get(expect, "max_calls")) !== r.maxCalls) problem(`max_calls: expected ${num(get(expect, "max_calls"))}, got ${r.maxCalls}`);
  if (has(expect, "calls")) {
    const want = get(expect, "calls") as Json[];
    const got = r.calls.map(c => ({ operation: c.operation.name, effect: c.operation.effect, line: Rational.of(c.line),
                                    max_count: Rational.of(c.maxCount), conditional: c.conditional }));
    if (want.length !== got.length) problem(`calls: expected ${want.length}, got ${got.length}`);
    else want.forEach((w, i) => { for (const [k, v] of Object.entries(w as object))
      if (canonicalJson(v) !== canonicalJson((got[i] as Record<string, unknown>)[k])) problem(`call ${i + 1} ${k}: expected ${canonicalJson(v)}, got ${canonicalJson((got[i] as Record<string, unknown>)[k])}`); });
  }
}

const stepField: Record<string, (s: Step) => unknown> = {
  operation: s => s.operation.name,
  args: s => s.args,
  already_done: s => s.alreadyDone,
  index: s => Rational.of(s.index),
  status: s => s.status,
  requires: s => s.requires.map(r => ({ role: r.role, four_eyes: r.fourEyes, rule: r.rule })),
};

function compareSteps(want: Json[], got: Step[]) {
  if (want.length !== got.length) { problem(`steps: expected ${want.length}, got ${got.length}`); return; }
  want.forEach((w, i) => { for (const [k, v] of Object.entries(w as object)) {
    const g = stepField[k](got[i]);
    if (canonicalJson(v) !== canonicalJson(g)) problem(`step ${i + 1} ${k}: expected ${canonicalJson(v)}, got ${canonicalJson(g)}`);
  } });
}

function same(expect: Json, key: string, got: unknown, note = "") {
  if (has(expect, key) && canonicalJson(get(expect, key)) !== canonicalJson(got ?? null))
    problem(`${key}: expected ${canonicalJson(get(expect, key))}, got ${canonicalJson(got ?? null)}${note}`);
}

function comparePreview(expect: Json, p: Preview) {
  same(expect, "status", p.status);
  same(expect, "hash", p.hash);
  same(expect, "stop_reason", p.stopReason);
  if (has(expect, "problems")) {
    const codes = p.problems.map(x => x.code);
    if (canonicalJson(get(expect, "problems")) !== canonicalJson(codes)) problem(`problems: expected ${canonicalJson(get(expect, "problems"))}, got ${canonicalJson(codes)} ${p.problems.map(x => x.message).join("; ")}`);
  }
  if (has(expect, "steps")) compareSteps(get(expect, "steps") as Json[], p.steps);
}

type Log = [string, Json][];

function compareExecution(expect: Json, e: Execution, log: Log) {
  same(expect, "outcome", e.outcome, e.message ? ` (${e.message})` : "");
  same(expect, "stop_reason", e.stopReason);
  if (has(expect, "steps")) compareSteps(get(expect, "steps") as Json[], e.steps);
  if (has(expect, "calls")) {
    const want = get(expect, "calls") as Json[];
    if (want.length !== log.length) { problem(`calls: expected ${want.length}, got ${log.length}: ${log.map(l => l[0]).join(", ")}`); return; }
    want.forEach((w, i) => {
      const name = typeof w === "string" ? w : get(w, "operation");
      if (name !== log[i][0]) problem(`call ${i + 1}: expected ${name}, got ${log[i][0]}`);
      if (isObject(w) && w.args !== undefined && canonicalJson(w.args) !== canonicalJson(log[i][1]))
        problem(`call ${i + 1} args: expected ${canonicalJson(w.args)}, got ${canonicalJson(log[i][1])}`);
    });
  }
}

function scripts(tools: Json | undefined, log: Log): Implementations {
  const impls: Implementations = new Map();
  if (isObject(tools)) for (const [name, script] of Object.entries(tools)) {
    let i = 0;
    const answers = script as Json[];
    impls.set(nameFold(name), args => {
      log.push([name, args]);
      const r = answers[Math.min(i++, answers.length - 1)];
      if (has(r, "result")) return get(r, "result")!;
      if (has(r, "failed")) throw new OperationFailed(get(r, "failed") as string);
      throw new OperationUnknown(get(r, "unknown") as string);
    });
  }
  return impls;
}

function preloadJournal(entries: Json | undefined): Journal {
  const j = new Journal();
  for (const e of (entries ?? []) as Json[]) {
    const op = ops.get(nameFold(get(e, "operation") as string))!;
    const args = Object.entries(get(e, "args") as object).map(([k, v]) => [k, fromHost(v as Json, "any", "journal")] as [string, never]);
    j.put(stepKeyText(op, args), (get(e, "status") ?? "done") as "done", null);
  }
  return j;
}

async function runExecutionCase(c: Json, message: string | null, policy: Rule[], actor: Actor | null) {
  const journal = preloadJournal(get(c, "journal"));
  const log: Log = [];
  const p = await preview(planText(get(c, "plan")!), { message, operations: ops, implementations: scripts(get(c, "tools"), log),
                                                       journal, policy, actor });
  if (has(c, "expect_preview")) comparePreview(get(c, "expect_preview")!, p);
  if (!has(c, "expect_execute")) return;
  const tools = get(c, "execute_tools") ?? get(c, "tools");
  const log2: Log = [];
  const approvers = ((get(c, "approvers") ?? []) as Json[]).map(a => actorFromJson(a)!);
  const e = await execute(p, get(c, "approve") === false ? "wrong" : p.hash ?? "", { implementations: scripts(tools, log2), journal, approvers });
  compareExecution(get(c, "expect_execute")!, e, log2);
  if (has(c, "expect_execute_again")) {
    const log3: Log = [];
    compareExecution(get(c, "expect_execute_again")!, await execute(p, p.hash ?? "", { implementations: scripts(tools, log3), journal }), log3);
  }
}

let total = 0, failed = 0;
for (const file of readdirSync(join(folder, "cases")).filter(f => f.endsWith(".json")).sort()) {
  const suite = read(join(folder, "cases", file));
  console.log(`\n${file}`);
  for (const c of get(suite, "cases") as Json[]) {
    problems = [];
    const m = has(c, "message") ? get(c, "message") : get(suite, "message");
    const message = typeof m === "string" ? m : null;
    const policy = policyFromJson(get(c, "policy") ?? get(suite, "policy") ?? []);
    const actor = actorFromJson(has(c, "actor") ? get(c, "actor") : get(suite, "actor"));
    try {
      if (has(c, "tools")) await runExecutionCase(c, message, policy, actor);
      else compareCheck(get(c, "expect")!, checkPlan(planText(get(c, "plan")!), { message, operations: ops, policy, actor,
                                                                                  profile: profileOf(has(c, "profile") ? get(c, "profile") : get(suite, "profile")) }));
    } catch (e) { problem(`crashed: ${(e as Error).stack}`); }
    total++;
    if (problems.length) { failed++; console.log(`  FAIL  ${get(c, "name")}\n${problems.map(p => "          " + p).join("\n")}`); }
    else console.log(`  ok    ${get(c, "name")}`);
  }
}
console.log(`\n${total} cases, ${failed} failed`);
process.exit(failed ? 1 : 0);
