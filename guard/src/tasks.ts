// tasks.ts — Tasks and acceptance (SPEC.md): what the user asked for, as items a person approved in words,
// each proved by a test bound to it, run by the gate on the version before the task and on the delivery.
// The model may ask for completion; only the gate, which keeps the approvals where the model cannot write,
// decides it.
//
// A task lives in the repository as acceptance/<task-id>.json:
//
//   { "task": "T1", "title": "The contract is reachable from the Terms menu",
//     "items": [ { "id": "A1", "text": "In the Terms of Use menu, the contract link opens the contract",
//                  "proof": "check", "test": { "file": "e2e/a1.spec.ts", "name": "[A1]", "run": "npx playwright test e2e/a1.spec.ts" } },
//                { "id": "A2", "text": "...", "proof": "person" } ] }
//
// A checked item's test runs with SOZ_GUARD_JUNIT set to a file path, where its runner writes a JUnit XML
// report; the test case whose name contains the item's tag ("[A1]") is the item's result. JUnit tells a
// failure (the behaviour is not there) from an error (nothing is known), which an exit code does not.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

export const ACCEPTANCE_DIR = "acceptance";

export type Item = {
  id: string; text: string; required?: boolean; proof: "check" | "person";
  test?: { file: string; name: string; run: string };
};
export type Task = { task: string; title: string; items: Item[] };

/** What the gate keeps for a task, where the model cannot write. */
export type TaskRecord = {
  /** The person approved these items (and these bound tests), in words, starting from BASE. */
  approval?: { itemsHash: string; base: string; by: string; at: string };
  /** A person confirmed an item: a test that passed from the start is real (bound to the test's hash), or a
   * person-proved item holds on a delivery (bound to that commit, and to the package built of it, if any). */
  confirmed?: Record<string, { binding?: string; delivery?: string; package?: string; by: string; at: string }>;
  /** A person took an item out of the task, or put it off: bound to the item as the person read it (itemContent),
   * so the decision does not carry over to an item that was reworded later. */
  descoped?: Record<string, { item?: string; reason: string; by: string; at: string }>;
};

export type Outcome = "pass" | "fail" | "error";
export type ItemState = "proven" | "missing" | "unproven" | "awaiting-person" | "confirmed" | "descoped";
export type ItemResult = {
  id: string; text: string; required: boolean; proof: "check" | "person"; state: ItemState;
  binding: string | null; onBase: Outcome | null; onDelivery: Outcome | null; detail: string;
  /** passed on the base too: already true before the task; proven only once a person confirmed the test */
  alreadyTrue?: boolean;
};
export type TaskVerdict = "complete" | "incomplete" | "unverified";
export type TaskEvaluation = {
  task: string; title: string; verdict: TaskVerdict; approved: boolean; itemsHash: string;
  base: string | null; delivery: string; items: ItemResult[]; why: string; at: string;
  /** the digest of the package the tests ran against, when the gate built one: the evidence is for it */
  package?: string;
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const TAG = (id: string) => `[${id}]`;

/** The tasks in a checked-out folder, with what is wrong with any that cannot be read. */
export function readTasks(dir: string): { tasks: Task[]; problems: string[] } {
  const folder = join(dir, ACCEPTANCE_DIR);
  const tasks: Task[] = [], problems: string[] = [];
  if (!existsSync(folder)) return { tasks, problems };
  for (const f of readdirSync(folder).filter(f => f.endsWith(".json")).sort()) {
    try { tasks.push(validTask(JSON.parse(readFileSync(join(folder, f), "utf8")), f)); }
    catch (e) { problems.push(`${ACCEPTANCE_DIR}/${f}: ${(e as Error).message}`); }
  }
  return { tasks, problems };
}

function validTask(j: unknown, file: string): Task {
  const t = j as Partial<Task>;
  if (!t || typeof t.task !== "string" || !t.task.trim()) throw new Error("needs a \"task\" id");
  if (`${t.task}.json` !== file) throw new Error(`its "task" is ${JSON.stringify(t.task)}; the file is named after it (${t.task}.json)`);
  if (!Array.isArray(t.items) || !t.items.length) throw new Error("needs at least one item");
  const ids = new Set<string>();
  for (const i of t.items) {
    if (!i || typeof i.id !== "string" || typeof i.text !== "string" || !i.text.trim()) throw new Error(`an item needs an "id" and a "text": ${JSON.stringify(i)}`);
    if (ids.has(i.id)) throw new Error(`item ${i.id} twice`);
    ids.add(i.id);
    if (i.proof !== "check" && i.proof !== "person") throw new Error(`item ${i.id}: "proof" is "check" or "person"`);
    if (i.proof === "check" && (!i.test || typeof i.test.file !== "string" || typeof i.test.run !== "string" || !i.test.run.trim()))
      throw new Error(`item ${i.id}: a checked item needs "test": {"file", "run"}`);
  }
  return { task: t.task, title: typeof t.title === "string" ? t.title : t.task, items: t.items };
}

/** A checked item's binding: its test file's content, its command and the test it names, together. Any of
 * them changed is another binding. Null when the test file is not there. */
export function bindingOf(dir: string, item: Item): string | null {
  if (item.proof !== "check" || !item.test) return null;
  const p = join(dir, item.test.file);
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  return sha256(JSON.stringify([item.id, item.test.file, item.test.name || TAG(item.id), item.test.run, sha256(content)]));
}

/** An item as a person reads it: what a descope decision is about. Its test is left out; a descoped item is not run. */
export function itemContent(i: { id: string; text: string; required?: boolean; proof: string }): string {
  return sha256(JSON.stringify([i.id, i.text, i.required !== false, i.proof]));
}

/** What the person approves: the items in words and, for checked ones, their bindings. A change to any of it
 * (an item reworded, removed, its test or command changed) voids the approval. */
export function itemsHash(dir: string, task: Task): string {
  return sha256(JSON.stringify([task.task, task.items.map(i => [i.id, i.text, i.required !== false, i.proof, bindingOf(dir, i)])]));
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The outcome of the test cases named with TAG in a JUnit XML report: a failure, an error or a skip are told
 * apart; several cases with the tag count as their worst. Null if no case has the tag. */
export function junitOutcome(xml: string, tag: string): { outcome: Outcome; message: string } | null {
  let worst: { outcome: Outcome; message: string } | null = null;
  const rank = { pass: 0, fail: 1, error: 2 } as const;
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = decode(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? "");
    const cls = decode(/\bclassname="([^"]*)"/.exec(m[1])?.[1] ?? "");
    if (!name.includes(tag) && !cls.includes(tag)) continue;
    const body = m[2] ?? "";
    const msg = (re: RegExp) => decode(re.exec(body)?.[1] ?? "").trim().slice(0, 300);
    const r: { outcome: Outcome; message: string } = /<failure\b/.test(body) ? { outcome: "fail", message: msg(/<failure\b[^>]*message="([^"]*)"/) || "the test failed" }
      : /<error\b/.test(body) ? { outcome: "error", message: msg(/<error\b[^>]*message="([^"]*)"/) || "the test could not run" }
      : /<skipped\b/.test(body) ? { outcome: "error", message: "the test was skipped" }
      : { outcome: "pass", message: "" };
    if (!worst || rank[r.outcome] > rank[worst.outcome]) worst = r;
  }
  return worst;
}

/** Runs ITEM's test in DIR and reads its result from the JUnit report. An exit code alone says nothing about
 * which way a test went: no report, or no case with the item's tag, is an error (nothing is known). */
export function runItem(dir: string, item: Item, env: Record<string, string | undefined>, timeoutSeconds: number): { outcome: Outcome; message: string } {
  // the package the gate built, given relative: this folder's own (the base's tests get the base's package)
  if (env.SOZ_GUARD_PACKAGE && !isAbsolute(env.SOZ_GUARD_PACKAGE)) env = { ...env, SOZ_GUARD_PACKAGE: join(dir, env.SOZ_GUARD_PACKAGE) };
  const out = mkdtempSync(join(tmpdir(), "soz-junit-"));
  const report = join(out, "junit.xml");
  try {
    const r = spawnSync(item.test!.run, { cwd: dir, shell: true, encoding: "utf8", env: { ...env, SOZ_GUARD_JUNIT: report },
                                          timeout: timeoutSeconds * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\r/g, "").trim().split("\n").slice(-8).join("\n");
    if (r.error) return { outcome: "error", message: r.error.message };
    if (!existsSync(report)) return { outcome: "error", message: `no JUnit report was written to $SOZ_GUARD_JUNIT (exit ${r.status})${tail ? `: ${tail}` : ""}` };
    const found = junitOutcome(readFileSync(report, "utf8"), item.test!.name || TAG(item.id));
    if (!found) return { outcome: "error", message: `no test case named with ${item.test!.name || TAG(item.id)} in the report` };
    return found;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Puts the delivery's bound test files into the base's folder: the tests are written during the task, so
 * the base never had them; they run there to show the behaviour was missing (or already there). */
export function bringTests(fromDir: string, toDir: string, task: Task) {
  for (const i of task.items) {
    if (i.proof !== "check" || !i.test) continue;
    const from = join(fromDir, i.test.file);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(toDir, i.test.file)), { recursive: true });
    writeFileSync(join(toDir, i.test.file), readFileSync(from, "utf8"));
  }
}

/** A task's verdict on a delivery (SPEC §5). DELIVERY_DIR is the delivered commit checked out and set up;
 * BASE_DIR, if given, the base the same way, with the delivery's bound tests brought in. */
export function evaluateTask(task: Task, record: TaskRecord, delivery: string, deliveryDir: string, baseDir: string | null,
                             env: Record<string, string | undefined>, timeoutSeconds: number, pkg?: string): TaskEvaluation {
  const at = new Date().toISOString();
  const hash = itemsHash(deliveryDir, task);
  const approved = !!record.approval && record.approval.itemsHash === hash;
  const items: ItemResult[] = task.items.map(i => {
    const required = i.required !== false;
    const binding = bindingOf(deliveryDir, i);
    const base = { id: i.id, text: i.text, required, proof: i.proof, binding, onBase: null, onDelivery: null } as const;
    const descoped = record.descoped?.[i.id];
    if (descoped && descoped.item === itemContent(i)) return { ...base, state: "descoped", detail: `taken out by ${descoped.by}: ${descoped.reason}` };
    const r = judge(i, required, binding, base);
    // a decision about the item as it read before does not take out what it says now
    return descoped && !["proven", "confirmed"].includes(r.state)
      ? { ...r, detail: `${r.detail}; ${descoped.by} took out an earlier wording of this item, so that decision does not apply` } : r;
  });
  function judge(i: Item, required: boolean, binding: string | null, base: Omit<ItemResult, "state" | "detail">): ItemResult {
    if (i.proof === "person") {
      const c = record.confirmed?.[i.id];
      if (c?.delivery === delivery && c.package === pkg) return { ...base, state: "confirmed", detail: `confirmed on this delivery by ${c.by}` };
      return { ...base, state: "awaiting-person", detail: c?.delivery === delivery
        ? `${c.by} confirmed another build of this delivery (package ${(c.package ?? "none").slice(0, 12)}, now ${(pkg ?? "none").slice(0, 12)}): a person confirms it on this package`
        : "a person confirms it on this delivery" };
    }
    if (!binding) return { ...base, state: "unproven", detail: `its test (${i.test!.file}) is not in the delivery` };
    if (!approved) return { ...base, state: "unproven", detail: "not run: the items or their tests are not the ones a person approved" };
    const onDelivery = runItem(deliveryDir, i, env, timeoutSeconds);
    const onBase = baseDir ? runItem(baseDir, i, env, timeoutSeconds) : null;
    const r = { ...base, onBase: onBase?.outcome ?? null, onDelivery: onDelivery.outcome };
    if (onDelivery.outcome === "error") return { ...r, state: "unproven", detail: `on the delivery the test could not give an answer: ${onDelivery.message}` };
    if (onDelivery.outcome === "fail") return { ...r, state: "missing", detail: onDelivery.message };
    if (onBase?.outcome === "pass") {
      const c = record.confirmed?.[i.id];
      return c?.binding === binding ? { ...r, state: "proven", alreadyTrue: true, detail: `already true before the task; a person confirmed the test (${c.by})` }
        : { ...r, state: "unproven", alreadyTrue: true, detail: "already true before the task: a test that passes from the start needs a person to confirm it is real" };
    }
    if (onBase?.outcome === "error") return { ...r, state: "unproven", detail: `on the base the test could not run, so nothing shows the behaviour was missing: ${onBase.message}` };
    // passing now proves the item only if the test was seen failing before the task (SPEC 4.3): a test that was
    // never run on the base could be one that cannot fail
    if (onBase?.outcome !== "fail") return { ...r, state: "unproven", detail: "the base could not be checked out or set up, so nothing shows the test can fail" };
    return { ...r, state: "proven", detail: "failed before the task, passes on the delivery" };
  }
  const open = items.filter(i => i.required && !["proven", "confirmed", "descoped"].includes(i.state));
  const verdict: TaskVerdict = !approved ? "unverified" : items.some(i => i.required && i.state === "missing") ? "incomplete" : open.length ? "unverified" : "complete";
  const why = !record.approval ? "no person has approved its items yet"
    : !approved ? "its items or their tests changed since a person approved them"
    : verdict === "complete" ? completeWhy(items)
    : open.map(i => `${i.id} ${i.state}`).join(", ");
  return { task: task.task, title: task.title, verdict, approved, itemsHash: hash, base: record.approval?.base ?? null, delivery, items, why, at,
           ...(pkg ? { package: pkg } : {}) };
}

/** What a complete task rests on, counted: "3 proven, 1 taken out by a person", never "all proven" when it is not. */
function completeWhy(items: ItemResult[]): string {
  const req = items.filter(i => i.required);
  const n = (s: ItemState) => req.filter(i => i.state === s).length;
  const parts = [`${n("proven")} proven on this delivery`];
  if (n("confirmed")) parts.push(`${n("confirmed")} confirmed by a person`);
  if (n("descoped")) parts.push(`${n("descoped")} taken out by a person`);
  return `of ${req.length} required items: ${parts.join(", ")}`;
}

/** The evaluation in words, for the person. */
export function taskReport(e: TaskEvaluation): string {
  const mark: Record<ItemState, string> = { proven: "ok  ", confirmed: "ok  ", descoped: "out ", missing: "MISS", unproven: "??  ", "awaiting-person": "you " };
  return `Task ${e.task} (${e.title}): ${e.verdict}, ${e.why}\n`
    + e.items.map(i => `  ${mark[i.state]} ${i.id}${i.required ? "" : " (optional)"}  ${i.text}\n         ${i.state}: ${i.detail}`).join("\n");
}
