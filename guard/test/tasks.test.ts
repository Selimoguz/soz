// tasks.test.ts — Tasks and acceptance (SPEC.md §6), end to end on a server repository with the gate: the
// person approves items in words, the gate runs each item's test on the base and on the delivery, and only
// the gate's verdict says "complete". The site here is a menu file and pages; each item's "browser test"
// is a script that reads them and writes a JUnit report, as a real runner would.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { itemsHash, readTasks, junitOutcome } from "../src/tasks.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : "\n          " + detail}`);
  if (!ok) failed++;
};

const top = mkdtempSync(join(tmpdir(), "soz-tasks-test-"));
const server = join(top, "server.git"), dev = join(top, "dev");
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                                { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const g = (...args: string[]) => gitIn(dev, ...args);
const write = (path: string, text: string) => { mkdirSync(dirname(join(dev, path)), { recursive: true }); writeFileSync(join(dev, path), text); };
const commit = (msg: string) => { g("add", "-A"); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
const push = (...args: string[]) => spawnSync("git", ["push", ...args], { cwd: dev, encoding: "utf8" });
const serverMain = () => gitIn(server, "rev-parse", "main");
const gate = (args: string[]) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, "gate", ...args], { cwd: server, encoding: "utf8" });
const back = () => { g("fetch", "-q", "origin"); g("reset", "-q", "--hard", "origin/main"); };
const store = (task: string) => join(server, ".soz-guard", "gate", "tasks", `${task}.json`);
const record = (task: string) => existsSync(store(task)) ? JSON.parse(readFileSync(store(task), "utf8")) : {};
/** What a person's "yes" in a terminal writes (the commands refuse without one, as tested below). */
const personWrites = (task: string, change: (r: Record<string, unknown>) => void) => {
  const r = record(task); change(r); mkdirSync(dirname(store(task)), { recursive: true }); writeFileSync(store(task), JSON.stringify(r, null, 2));
};
const approve = (task: string) => personWrites(task, r => {
  r.approval = { itemsHash: itemsHash(dev, readTasks(dev).tasks.find(t => t.task === task)!), base: serverMain(), by: "boss", at: "now" };
});
const evaluation = (task: string, commit: string) =>
  JSON.parse(readFileSync(join(server, ".soz-guard", "gate", "tasks", task, `${commit}.json`), "utf8")) as { verdict: string; items: { id: string; state: string; binding: string; detail: string }[] };

/** An item's test: reads the site's menu and pages, writes a JUnit report with one case, named with TAG. */
const menuTest = (tag: string, menu: string, link: string, page: string, heading: string) => `
const fs = require("fs");
const esc = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
let failure = "";
const items = JSON.parse(fs.readFileSync("site/menu.json", "utf8"))[${JSON.stringify(menu)}] || [];
const entry = items.find(i => i.label === ${JSON.stringify(link)});
if (!entry) failure = "the ${menu} menu has no link to ${link}";
else if (!fs.existsSync("site/" + entry.page) || !fs.readFileSync("site/" + entry.page, "utf8").includes(${JSON.stringify(heading)})) failure = "the link does not open ${page}";
fs.writeFileSync(process.env.SOZ_GUARD_JUNIT, '<testsuites><testsuite name="e2e"><testcase name="${tag} ${link} from the ${menu} menu">'
  + (failure ? '<failure message="' + esc(failure) + '"/>' : "") + "</testcase></testsuite></testsuites>");
`;

execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", server], { encoding: "utf8" });
gitIn(top, "clone", "-q", server.replace(/\\/g, "/"), "dev");
g("config", "core.autocrlf", "false");
gate(["install", "--branches", "main"]);
write(".gitignore", ".soz-guard/\n");
write(".soz-guard.json", JSON.stringify({ checks: [] }, null, 2));
write("site/menu.json", JSON.stringify({ terms: [{ label: "KVKK", page: "kvkk.html" }] }, null, 2));
write("site/kvkk.html", "<h1>KVKK Aydinlatma Metni</h1>\n");
commit("the site as it is live");
push("-q", "origin", "main");
const live = serverMain();

console.log("\nJUnit: a failure, an error and a skip are told apart");
check("a failure is a fail, an error and a skip are errors, no case is unknown",
  junitOutcome('<testcase name="[A1] x"><failure message="no link"/></testcase>', "[A1]")?.outcome === "fail"
  && junitOutcome('<testcase name="[A1] x"><error message="no browser"/></testcase>', "[A1]")?.outcome === "error"
  && junitOutcome('<testcase name="[A1] x"><skipped/></testcase>', "[A1]")?.outcome === "error"
  && junitOutcome('<testcase name="[A1] x"/>', "[A1]")?.outcome === "pass"
  && junitOutcome('<testcase name="[A2] x"/>', "[A1]") === null);

console.log("\nT1: the distance sales contract must be reachable from the Terms of Use menu");
write("acceptance/T1.json", JSON.stringify({ task: "T1", title: "Contract reachable from the Terms menu", items: [
  { id: "A1", text: "In the Terms of Use menu, the Distance Sales Contract link opens the contract", proof: "check",
    test: { file: "e2e/a1.test.js", name: "[A1]", run: "node e2e/a1.test.js" } },
  { id: "A2", text: "The contract text is the one the lawyer sent", proof: "person" },
] }, null, 2));
write("e2e/a1.test.js", menuTest("[A1]", "terms", "Mesafeli Satis Sozlesmesi", "the contract", "Mesafeli Satis Sozlesmesi"));
commit("T1: items and the test, no work yet");
push("-q", "origin", "HEAD:refs/heads/t1");

console.log("\nE0: the model says done; nobody ran anything");
const s0 = gate(["task", "status", "T1"]);
check("the task's state on what is live: open, and it says why", s0.status === 1 && s0.stdout.includes("Task T1: open"), s0.stdout + s0.stderr);
const a0 = gate(["task", "approve", "T1", "t1"]);
check("approve shows the items in words, and refuses without a terminal (an agent)", a0.status === 2
      && a0.stdout.includes("opens the contract") && a0.stderr.includes("needs a terminal"), a0.stdout + a0.stderr);
const u0 = gate(["task", "status", "T1", "t1"]);
check("not approved yet: unverified, and the person is told to approve", u0.status === 1 && u0.stdout.includes("unverified")
      && u0.stdout.includes("gate task approve T1"), u0.stdout);
approve("T1");

console.log("\nE1: no work was done");
const e1 = push("origin", "HEAD:main");
check("pushed to main as it is: turned down, A1 missing", e1.status !== 0 && serverMain() === live && e1.stderr.includes("Task T1")
      && e1.stderr.includes("A1") && e1.stderr.includes("no link to Mesafeli Satis Sozlesmesi"), e1.stderr);

console.log("\nE2: code was written, the menu link is missing");
write("site/contract.html", "<h1>Mesafeli Satis Sozlesmesi</h1>\n");
write("site/menu.json", JSON.stringify({ terms: [{ label: "KVKK", page: "kvkk.html" }] }, null, 2)
  + "\n");
write("site/routes.js", "export const routes = { contract: \"/contract\" };   // soz-guard: ignore the menu link is left for later\n");
const e2c = commit("contract page and route, menu not yet");
const e2 = push("origin", "HEAD:main");
check("turned down: the page exists, but A1 is missing (the menu has no link)", e2.status !== 0 && serverMain() === live
      && evaluation("T1", e2c).items.find(i => i.id === "A1")?.state === "missing", e2.stderr);
check("... the ignore mark made it visible but did not close A1", e2.stderr.includes("the menu link is left for later") && e2.stderr.includes("MISS"), e2.stderr);

console.log("\nThe test weakened after approval");
write("e2e/a1.test.js", `require("fs").writeFileSync(process.env.SOZ_GUARD_JUNIT, '<testcase name="[A1] ok"/>');\n`);
commit("a faster test");
const w = push("origin", "HEAD:main");
check("the approval no longer applies: turned down, the test is not run", w.status !== 0 && serverMain() === live
      && w.stderr.includes("changed since a person approved them"), w.stderr);
g("reset", "-q", "--hard", "HEAD~1");

console.log("\nThe work done, and what only a person can say");
write("site/menu.json", JSON.stringify({ terms: [{ label: "KVKK", page: "kvkk.html" }, { label: "Mesafeli Satis Sozlesmesi", page: "contract.html" }] }, null, 2));
const done = commit("the link in the Terms menu");
const p1 = push("origin", "HEAD:main");
const ev = evaluation("T1", done);
check("A1 proven: it failed before the task and passes on the delivery", ev.items.find(i => i.id === "A1")?.state === "proven"
      && ev.items.find(i => i.id === "A1")!.detail.includes("failed before the task"), JSON.stringify(ev.items));
check("... but A2 awaits a person, so the task is unverified and the push turned down", p1.status !== 0 && serverMain() === live
      && ev.verdict === "unverified" && p1.stderr.includes(`gate task confirm T1 A2 ${done.slice(0, 12)}`), p1.stderr);
const c0 = gate(["task", "confirm", "T1", "A2", done.slice(0, 12)]);
check("confirm finds the delivery git dropped, by the gate's record, and refuses without a terminal", c0.status === 2 && c0.stdout.includes("lawyer"), c0.stdout + c0.stderr);
personWrites("T1", r => { r.confirmed = { A2: { delivery: done, by: "boss", at: "now" } }; });
const p2 = push("origin", "HEAD:main");
check("confirmed on this delivery: T1 complete, let in", p2.status === 0 && serverMain() === done && evaluation("T1", done).verdict === "complete", p2.stderr);
const s1 = gate(["task", "status", "T1"]);
check("the task's state on what is live now: complete", s1.status === 0 && s1.stdout.includes("Task T1") && s1.stdout.includes("complete"), s1.stdout);

console.log("\nE3: the behaviour was already there");
write("acceptance/T2.json", JSON.stringify({ task: "T2", title: "KVKK in the Terms menu", items: [
  { id: "B1", text: "In the Terms of Use menu, the KVKK link opens the KVKK text", proof: "check",
    test: { file: "e2e/b1.test.js", name: "[B1]", run: "node e2e/b1.test.js" } }] }, null, 2));
write("e2e/b1.test.js", menuTest("[B1]", "terms", "KVKK", "the KVKK text", "KVKK Aydinlatma Metni"));
const t2 = commit("T2: KVKK link (already there)");
push("-q", "origin", "HEAD:refs/heads/t2");
approve("T2");
const p3 = push("origin", "HEAD:main");
const b1 = evaluation("T2", t2).items[0];
check("B1 passes on the base too: already true, and the agent did not have to break anything", b1.detail.includes("already true before the task"), b1.detail);
check("... a test that passes from the start waits for a person to confirm it: turned down until then", p3.status !== 0 && b1.state === "unproven"
      && p3.stderr.includes(`gate task confirm T2 B1 ${t2.slice(0, 12)}`), p3.stderr);
personWrites("T2", r => { r.confirmed = { B1: { binding: b1.binding, by: "boss", at: "now" } }; });
const p4 = push("origin", "HEAD:main");
check("confirmed: B1 proven, T2 complete, let in", p4.status === 0 && serverMain() === t2 && evaluation("T2", t2).verdict === "complete", p4.stderr);

console.log("\nA required item taken out by the person");
write("acceptance/T3.json", JSON.stringify({ task: "T3", title: "Invoices by e-mail", items: [
  { id: "C1", text: "The invoice is e-mailed after the order", proof: "check", test: { file: "e2e/c1.test.js", name: "[C1]", run: "node e2e/c1.test.js" } }] }, null, 2));
write("e2e/c1.test.js", `require("fs").writeFileSync(process.env.SOZ_GUARD_JUNIT, '<testcase name="[C1] mail"><failure message="no mail sent"/></testcase>');\n`);
const t3 = commit("T3: not done");
push("-q", "origin", "HEAD:refs/heads/t3");
approve("T3");
check("C1 missing: turned down", push("origin", "HEAD:main").status !== 0 && serverMain() === t2);
check("descope refuses without a terminal", gate(["task", "descope", "T3", "C1", "the mail server comes next month"]).status === 2);
personWrites("T3", r => { r.descoped = { C1: { reason: "the mail server comes next month", by: "boss", at: "now" } }; });
const p5 = push("origin", "HEAD:main");
check("taken out by the person, with a reason: the task can be complete without it", p5.status === 0 && serverMain() === t3
      && evaluation("T3", t3).items[0].state === "descoped", p5.stderr);
back();

console.log("\nThe gate's log");
const l = gate(["log", "--last", "100"]);
check("task verdicts are in the gate's chained log", l.stdout.includes("T1") && gate(["log", "--verify"]).stdout.includes("intact"), l.stdout);

rmSync(top, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard task tests passed"}`);
process.exit(failed ? 1 : 0);
