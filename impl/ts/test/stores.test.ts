// stores.test.ts — The journal and the audit record with real processes: a claim race, several writers
// on one audit record, a host that dies mid-call, a failed step, and a person resolving a step.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  Journal, verifyAudit, preview, execute, previewSummary, operationsFromJson, parseJson, OperationFailed, stepKeyText, Rational,
  type Implementations,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "soz-stores-"));
let failed = 0;
const check = (what: string, ok: unknown) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) failed++; };

function worker(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise(res => {
    const p = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(here, "store-worker.ts"), ...args],
                    { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d: unknown) => { out += String(d); });
    p.on("close", code => res({ code, out }));   // "close", not "exit": by then all output is read
  });
}

console.log("\nA claim race between processes");
{
  const journal = join(dir, "race.jsonl");
  const start = String(Date.now() + 1500);
  const results = await Promise.all(Array.from({ length: 8 }, () => worker("claim", journal, "step-key", start)));
  const won = results.filter(r => r.out === "won").length, lost = results.filter(r => r.out === "lost").length;
  check(`8 processes claim one key at once: exactly one wins (${won} won, ${lost} lost)`, won === 1 && lost === 7);
}

console.log("\nSeveral writers, one audit record");
{
  const audit = join(dir, "audit.jsonl");
  const start = String(Date.now() + 1500);
  await Promise.all([0, 1, 2, 3].map(w => worker("append", audit, "25", start, `w${w}`)));
  const lines = readFileSync(audit, "utf8").split("\n").filter(l => l.trim());
  const seqs = lines.map(l => Number((parseJson(l) as { seq: Rational }).seq.n));
  check("4 processes appending 25 records each make 100 records", lines.length === 100);
  check("... in one chain, intact", verifyAudit(audit) === true);
  check("... numbered 1 to 100 without a gap or a repeat", seqs.every((s, i) => s === i + 1));
}

// A small operation set for the execution checks.
const operations = operationsFromJson(parseJson(`[
  {"name": "erp.add_order_line", "effect": "write", "params": {"customer": {"type": "text"}, "product": {"type": "text"}, "quantity": {"type": "number"}}}
]`));
const message = "Yilmaz: 20 tomatoes";
const plan = `(plan "x" (erp.add_order_line customer "Yilmaz" product "tomatoes" quantity 20))`;
const key = stepKeyText(operations.get("erp.add-order-line")!, [["customer", "Yilmaz"], ["product", "tomatoes"], ["quantity", Rational.of(20)]]);
let calls = 0;
let behaviour: "ok" | "fail" = "ok";
const implementations: Implementations = new Map([["erp.add-order-line", () => {
  calls++;
  if (behaviour === "fail") throw new OperationFailed("the ERP is closed");
  return null;
}]]);
const run = async (journal: Journal) => {
  const p = await preview(plan, { message, operations, implementations, journal });
  return execute(p, p.hash!, { implementations, journal });
};

console.log("\nA host that dies during the call");
{
  const path = join(dir, "crash.jsonl");
  const crashed = await worker("crash", path, key);
  check("the worker claimed the step and died", crashed.code === 3);
  calls = 0;
  const e = await run(Journal.open(path));
  check("the next execution does not call it again: unresolved", e.outcome === "unresolved" && calls === 0 && e.steps[0].status === "unresolved");
  check("... and says why", (e.message ?? "").includes("stopped during the call"));
  const shown = previewSummary(await preview(plan, { message, operations, implementations, journal: Journal.open(path) }));
  check("the preview does not call the left claim 'already done': it may or may not have happened",
        shown.includes("may or may not have happened") && !shown.includes("already done"));
}

console.log("\nA failed step, and a person resolving one");
{
  const path = join(dir, "fail.jsonl");
  calls = 0; behaviour = "fail";
  const e1 = await run(Journal.open(path));
  check("a failed call releases its claim", e1.outcome === "failed" && Journal.open(path).get(key) === undefined);
  behaviour = "ok";
  const e2 = await run(Journal.open(path));
  check("so it may run again, and does", e2.outcome === "done" && calls === 2);

  const pending = join(dir, "resolve.jsonl");
  await Journal.open(pending).claim(key);                     // left pending, as by a crash
  calls = 0;
  Journal.open(pending).put(key, "done", null);               // a person checked: it did happen
  const e3 = await run(Journal.open(pending));
  check("resolved as done: it is not run again", e3.outcome === "done" && e3.steps[0].status === "already_done" && calls === 0);
  const released = join(dir, "release.jsonl");
  await Journal.open(released).claim(key);
  await Journal.open(released).release(key);                  // a person checked: it did not happen
  const e4 = await run(Journal.open(released));
  check("resolved as released: it runs", e4.outcome === "done" && calls === 1);
}

console.log("\nAn older journal file is still read");
{
  const path = join(dir, "old.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify({ key, status: "done", result: null }) + "\n");
  calls = 0;
  const e = await run(Journal.open(path));
  check("a step done in a journal from before 0.4 is already done", e.steps[0].status === "already_done" && calls === 0);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All store tests passed"}`);
process.exit(failed ? 1 : 0);
