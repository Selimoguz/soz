// delivery.test.ts — What goes live, end to end on a server repository with the gate:
//   - a branch that takes only task deliveries (gate install --require-task): no task, no entry; a task named in a
//     commit message counts; a person can let one urgent commit in without a task, with a reason;
//   - the package (--build, --package): built once, the task tests run against it, its digest recorded with the
//     verdict and the files kept; a live copy is compared with it file by file.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { itemsHash, readTasks } from "../src/tasks.ts";
import { criteriaFingerprint } from "../src/verdict.ts";
import { tasksNamed } from "../src/gate.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : "\n          " + detail}`);
  if (!ok) failed++;
};

const top = mkdtempSync(join(tmpdir(), "soz-delivery-test-"));
const server = join(top, "server.git"), dev = join(top, "dev");
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                                { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const g = (...args: string[]) => gitIn(dev, ...args);
const write = (path: string, text: string) => { mkdirSync(dirname(join(dev, path)), { recursive: true }); writeFileSync(join(dev, path), text); };
const commit = (msg: string) => { g("add", "-A"); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
const push = (...args: string[]) => spawnSync("git", ["push", ...args], { cwd: dev, encoding: "utf8" });
const serverMain = () => gitIn(server, "rev-parse", "main");
const run = (cwd: string, args: string[]) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd, encoding: "utf8" });
const gate = (args: string[]) => run(server, ["gate", ...args]);
const back = () => { g("fetch", "-q", "origin"); g("reset", "-q", "--hard", "origin/main"); };
const gateFile = (...p: string[]) => join(server, ".soz-guard", "gate", ...p);
const report = (c: string) => JSON.parse(readFileSync(gateFile("reports", `${c}.json`), "utf8")) as
  { state: string; package?: { digest: string; files: number }; tasks?: { task: string; verdict: string; package?: string }[] };
/** What a person's "yes" in a terminal writes (the commands refuse without one, as tested below). */
const personApproves = (task: string) => {
  const store = gateFile("tasks", `${task}.json`);
  const r = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {};
  r.approval = { itemsHash: itemsHash(dev, readTasks(dev).tasks.find(t => t.task === task)!), base: serverMain(), by: "boss", at: "now" };
  mkdirSync(dirname(store), { recursive: true }); writeFileSync(store, JSON.stringify(r, null, 2));
};
const personLetsInWithoutTask = (c: string, reason: string) => {
  mkdirSync(gateFile("approved"), { recursive: true });
  writeFileSync(gateFile("approved", `${c}.json`), JSON.stringify({ commit: c, criteria: criteriaFingerprint([]), reason, by: "boss", at: "now", noTask: true }));
};

console.log("Commit messages name tasks");
check("\"Task: T1\" lines, any case, each once, not inside a sentence",
      JSON.stringify(tasksNamed("Fix\n\nTask: T1\n\x00More\ntask: T1\nTask:B-2 \nsee Task: T3 later\n\x00")) === JSON.stringify(["T1", "B-2"]));

// the site: pages in site/, built into out/ by a build that copies them (the package the gate judges)
execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", server], { encoding: "utf8" });
gitIn(top, "clone", "-q", server.replace(/\\/g, "/"), "dev");
g("config", "core.autocrlf", "false");
write("build.js", `const fs = require("fs"), path = require("path");
const copy = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const n of fs.readdirSync(a)) { const f = path.join(a, n);
  fs.statSync(f).isDirectory() ? copy(f, path.join(b, n)) : fs.copyFileSync(f, path.join(b, n)); } };
copy("site", "out");
`);
write("site/menu.json", JSON.stringify({ main: [{ label: "Home", page: "index.html" }] }));
write("site/index.html", "<h1>Home</h1>\n");
commit("the site");
push("-q", "origin", "HEAD:main");
const inst = gate(["install", "--branches", "main", "--require-task", "--build", "node build.js", "--package", "out"]);
check("install: only task deliveries, the package built with the build", inst.status === 0
      && inst.stdout.includes("only the delivery of an approved task") && inst.stdout.includes("package: out, built with: node build.js"), inst.stdout + inst.stderr);
check("--build without --package is refused: the gate would not know what to judge", gate(["install", "--build", "node build.js", "--package", ""]).status !== 0);

console.log("\nA push that carries no task");
write("site/index.html", "<h1>Home</h1><p>news</p>\n");
const c1 = commit("news on the home page");
const p1 = push("origin", "HEAD:main");
check("turned down, and told how to name the task", p1.status !== 0 && serverMain() !== c1
      && p1.stderr.includes("takes only the delivery of an approved task") && p1.stderr.includes('"Task: <task>"'), p1.stderr);
check("... with the way out for an urgent fix: a person approves this one commit", p1.stderr.includes(`gate approve ${c1.slice(0, 12)}`), p1.stderr);
check("approve refuses without a terminal", gate(["approve", c1, "urgent"]).status === 2);
personLetsInWithoutTask(c1, "the home page news is due today");
const p2 = push("origin", "HEAD:main");
check("let in without a task by a person, with the reason shown", p2.status === 0 && serverMain() === c1
      && p2.stderr.includes("Let in without a task by a person: the home page news is due today"), p2.stderr);

console.log("\nA task, proven against the package");
write("acceptance/T1.json", JSON.stringify({ task: "T1", title: "Reports", items: [
  { id: "A1", text: "Reports opens from the main menu", proof: "check", test: { file: "e2e/a1.test.js", name: "[A1]", run: "node e2e/a1.test.js" } }] }, null, 2));
// the test reads the package the gate built, never the sources
write("e2e/a1.test.js", `const fs = require("fs"), path = require("path");
const pkg = process.env.SOZ_GUARD_PACKAGE;
let failure = "";
if (!pkg) failure = "no package to test";
else {
  const menu = JSON.parse(fs.readFileSync(path.join(pkg, "menu.json"), "utf8")).main;
  const e = menu.find(i => i.label === "Reports");
  if (!e || !fs.existsSync(path.join(pkg, e.page))) failure = "the main menu does not open Reports";
}
fs.writeFileSync(process.env.SOZ_GUARD_JUNIT, '<testcase name="[A1] reports">' + (failure ? '<failure message="' + failure + '"/>' : "") + "</testcase>");
`);
commit("T1: the task and its test");
push("-q", "origin", "HEAD:refs/heads/t1");
personApproves("T1");
const p3 = push("origin", "HEAD:main");
check("not done: A1 missing in the package, turned down", p3.status !== 0 && serverMain() === c1 && p3.stderr.includes("MISS"), p3.stderr);
write("site/menu.json", JSON.stringify({ main: [{ label: "Home", page: "index.html" }, { label: "Reports", page: "reports.html" }] }));
write("site/reports.html", "<h1>Reports</h1>\n");
const t1done = commit("Reports in the main menu");
const p4 = push("origin", "HEAD:main");
const r4 = report(t1done);
check("done: A1 proven, let in", p4.status === 0 && serverMain() === t1done && r4.tasks?.[0].verdict === "complete", p4.stderr);
check("... verified, though no check is configured: the task's test ran on this delivery", r4.state === "verified", r4.state);
check("... the evidence is for this package: its digest is in the verdict and in the task's evaluation",
      !!r4.package && r4.package.files === 3 && r4.tasks?.[0].package === r4.package.digest, JSON.stringify(r4.package));
check("... and the person is told how to deploy the same files", p4.stderr.includes(`gate package ${t1done.slice(0, 12)} --to`), p4.stderr);

console.log("\nA task named in a commit message");
write("site/reports.html", "<h1>Reports</h1><p>by month</p>\n");
const t1more = commit("Reports by month\n\nTask: T1");
const p5 = push("origin", "HEAD:main");
check("the code alone, the task named: judged on this delivery, complete, let in", p5.status === 0 && serverMain() === t1more
      && report(t1more).tasks?.[0].task === "T1", p5.stderr);
write("site/index.html", "<h1>Home</h1>\n");
commit("Home page\n\nTask: T9");
const p6 = push("origin", "HEAD:main");
check("a task named that is not there: turned down, said plainly", p6.status !== 0 && p6.stderr.includes('"Task: T9" is in a commit message'), p6.stderr);
g("reset", "-q", "--hard", "HEAD~1");

console.log("\nThe package on the live server");
const digestLine = gate(["package", t1more.slice(0, 12)]);
const digest = report(t1more).package!.digest;
check("gate package REV: its digest and where its files are kept", digestLine.status === 0 && digestLine.stdout.includes(digest), digestLine.stdout + digestLine.stderr);
const live = join(top, "live");
const out1 = gate(["package", t1more.slice(0, 12), "--to", live]);
check("--to copies the package the gate judged, and checks the copy", out1.status === 0 && existsSync(join(live, "reports.html")), out1.stdout + out1.stderr);
check("--to refuses a folder that is not empty", gate(["package", t1more.slice(0, 12), "--to", live]).status !== 0);
check("--verify: the live folder is the package, file for file", gate(["package", t1more.slice(0, 12), "--verify", live]).status === 0);
// the files themselves, as the gate built them (its checkout follows the server's git settings, line ends included)
const older = join(top, "older"), pristine = join(top, "pristine");
gate(["package", t1done.slice(0, 12), "--to", older]);
gate(["package", t1more.slice(0, 12), "--to", pristine]);
copyFileSync(join(older, "reports.html"), join(live, "reports.html"));
const v1 =gate(["package", t1more.slice(0, 12), "--verify", live]);
check("an old file copied over it: told, by name", v1.status !== 0 && v1.stdout.includes("changed (1): reports.html"), v1.stdout);
check("the same live folder against the older package it does match", gate(["package", t1done.slice(0, 12), "--verify", live]).status === 0);
copyFileSync(join(pristine, "reports.html"), join(live, "reports.html"));
mkdirSync(join(live, "logs")); writeFileSync(join(live, "logs", "today.log"), "started\n");
const v2 = gate(["package", t1more.slice(0, 12), "--verify", live]);
check("a file the package does not have: told", v2.status !== 0 && v2.stdout.includes("not in the package (1): logs/today.log"), v2.stdout);
check("... unless it is what the live server writes itself (--ignore)", gate(["package", t1more.slice(0, 12), "--verify", live, "--ignore", "logs"]).status === 0);
const d = run(live, ["digest", ".", "--ignore", "logs"]);
check("soz-guard digest, on a machine that is not the gate's: the same digest", d.status === 0 && d.stdout.includes(digest), d.stdout + d.stderr);
const l = gate(["log", "--last", "30"]);
check("each copy and comparison is in the gate's log, with who did it", l.stdout.includes("copied to") && l.stdout.includes("DIFFERENT") && l.stdout.includes("the same files")
      && gate(["log", "--verify"]).stdout.includes("intact"), l.stdout);

console.log("\nA delivery that does not build");
back();
write("build.js", `process.stderr.write("site/menu.json: unexpected token\\n"); process.exit(1);\n`);
const broken = commit("build changes\n\nTask: T1");
const p7 = push("origin", "HEAD:main");
check("not let in, with the build's own words", p7.status !== 0 && p7.stderr.includes("could not be built") && p7.stderr.includes("unexpected token"), p7.stderr);
check("... and no package kept for it", gate(["package", broken.slice(0, 12)]).status !== 0);
g("reset", "-q", "--hard", "HEAD~1");

console.log("\nOld packages");
gate(["install", "--keep-packages", "1"]);
write("site/reports.html", "<h1>Reports</h1><p>by month and year</p>\n");
const newest = commit("Reports by year\n\nTask: T1");
check("let in", push("origin", "HEAD:main").status === 0 && serverMain() === newest);
check("only the newest is kept whole: an older one cannot be copied out any more",
      gate(["package", t1more.slice(0, 12), "--to", join(top, "live2")]).stderr.includes("no longer kept"));
check("... but its digest stays, and a live folder can still be compared with it", gate(["package", t1more.slice(0, 12), "--verify", live, "--ignore", "logs"]).status === 0);

console.log("\nWithout --require-task");
gate(["install", "--no-require-task"]);
write("site/index.html", "<h1>Home</h1><p>hello</p>\n");
const free = commit("hello");
const p8 = push("origin", "HEAD:main");
check("a push with no task goes in as before", p8.status === 0 && serverMain() === free, p8.stderr);

console.log("\nRegression: a check by hand does not replace the package a push released");
const releasedDigest = report(free).package!.digest;
// a build that differs each time: the same commit, another package
gate(["install", "--build", `node build.js && node -e "require('fs').writeFileSync('out/stamp.txt', String(Math.random()))"`]);
const hand = gate(["check", free.slice(0, 12)]);
check("the check by hand passes, on another build, and says it released nothing",
      hand.status === 0 && report(free).package!.digest !== releasedDigest && hand.stdout.includes("nothing is released"), hand.stdout + hand.stderr);
const after = gate(["package", free.slice(0, 12)]);
check("gate package still gives the package the push released", after.status === 0 && after.stdout.includes(releasedDigest), after.stdout + after.stderr);
const deployed = join(top, "deployed");
gate(["package", free.slice(0, 12), "--to", deployed]);
check("... and --to copies those files, not the later build's", !existsSync(join(deployed, "stamp.txt"))
      && run(deployed, ["digest", "."]).stdout.includes(releasedDigest));
check("a commit no push let in has no package to deploy, only a verdict", (() => {
  write("site/index.html", "<h1>Home</h1><p>draft</p>\n");
  const draft = commit("draft");
  push("-q", "origin", "HEAD:refs/heads/draft");
  const c = gate(["check", draft.slice(0, 12)]);
  const p = gate(["package", draft.slice(0, 12)]);
  g("reset", "-q", "--hard", "HEAD~1");
  return c.status === 0 && p.status !== 0 && p.stderr.includes("No push let a package");
})());

console.log("\nRegression: a person's confirmation is for the package they looked at");
gate(["install", "--require-task", "--build", "node build.js"]);
write("acceptance/T2.json", JSON.stringify({ task: "T2", title: "The report reads right", items: [
  { id: "P1", text: "The accountant reads the monthly report and finds it right", proof: "person" }] }, null, 2));
const t2 = commit("T2: a person looks at the report");
push("-q", "origin", "HEAD:refs/heads/t2");
personApproves("T2");
const q1 = push("origin", "HEAD:main");
const evalT2 = () => JSON.parse(readFileSync(gateFile("tasks", "T2", `${t2}.json`), "utf8")) as { package?: string; items: { state: string; detail: string }[] };
check("P1 waits for the person: turned down", q1.status !== 0 && evalT2().items[0].state === "awaiting-person", q1.stderr);
const personConfirms = (pkg: string) => {
  const store = gateFile("tasks", "T2.json");
  const r = JSON.parse(readFileSync(store, "utf8"));
  r.confirmed = { P1: { delivery: t2, package: pkg, by: "accountant", at: "now" } };
  writeFileSync(store, JSON.stringify(r, null, 2));
};
// the build changes between the person's look and the push: the same commit, another package
gate(["install", "--build", `node build.js && node -e "require('fs').writeFileSync('out/stamp.txt', String(Math.random()))"`]);
personConfirms(evalT2().package!);
const q2 = push("origin", "HEAD:main");
check("confirmed on the build they saw; the push built another: P1 waits again, turned down",
      q2.status !== 0 && evalT2().items[0].state === "awaiting-person" && evalT2().items[0].detail.includes("another build"), q2.stderr + JSON.stringify(evalT2().items[0]));
gate(["install", "--build", "node build.js"]);
const q3 = push("origin", "HEAD:main");
check("the build gives the package they looked at again: the confirmation holds, complete, let in", q3.status === 0 && serverMain() === t2, q3.stderr);

console.log("\nRegression: the first push, on a branch that takes only task deliveries");
const server2 = join(top, "empty.git"), dev2 = join(top, "dev2");
execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", server2], { encoding: "utf8" });
run(server2, ["gate", "install", "--branches", "main", "--require-task"]);
gitIn(top, "clone", "-q", server2.replace(/\\/g, "/"), "dev2");
writeFileSync(join(dev2, "a.txt"), "first\n");
gitIn(dev2, "add", "-A"); gitIn(dev2, "commit", "-q", "-m", "first");
const first = gitIn(dev2, "rev-parse", "HEAD");
const f1 = spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: dev2, encoding: "utf8" });
check("the first push with no task is turned down, not let in as unchecked", f1.status !== 0
      && f1.stderr.includes("nothing to compare it with") && f1.stderr.includes(`gate approve ${first.slice(0, 12)}`), f1.stderr);
check("approving it needs a terminal", run(server2, ["gate", "approve", first, "the repository's first commit"]).status === 2);
mkdirSync(join(server2, ".soz-guard", "gate", "approved"), { recursive: true });
writeFileSync(join(server2, ".soz-guard", "gate", "approved", `${first}.json`),
              JSON.stringify({ commit: first, criteria: criteriaFingerprint([]), reason: "the repository's first commit", by: "boss", at: "now", noTask: true }));
const f2 = spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: dev2, encoding: "utf8" });
check("a person let it in, with a reason, in the gate's log", f2.status === 0
      && run(server2, ["gate", "log"]).stdout.includes("main") && f2.stderr.includes("the repository's first commit"), f2.stderr);

console.log("\nRegression: a package is released only once git has moved the branch");
gate(["install", "--branches", "main,prod", "--no-require-task", "--build", "node build.js"]);
back();
const released = (c: string) => existsSync(gateFile("packages", "released", `${c}.json`));
const mainBefore = serverMain();
write("site/index.html", "<h1>Home</h1><p>for both</p>\n");
const good = commit("for main");
write("build.js", `process.stderr.write("broken build\\n"); process.exit(1);\n`);
const bad = commit("for prod, does not build");
const both = push("origin", `${good}:refs/heads/main`, `${bad}:refs/heads/prod`);
check("one push to two protected branches, prod turned down: the whole push is refused",
      both.status !== 0 && serverMain() === mainBefore && both.stderr.includes("could not be built"), both.stderr);
check("... and main's package, which pre-receive let in, is not released: nothing went in",
      !released(good) && gate(["package", good.slice(0, 12)]).stderr.includes("No push let a package"), JSON.stringify(gate(["package", good.slice(0, 12)])));
const lone = push("origin", `${good}:refs/heads/main`);
check("the same commit pushed to main alone goes in, and is released then",
      lone.status === 0 && serverMain() === good && released(good) && lone.stderr.includes("package released"), lone.stderr);
const rel = JSON.parse(readFileSync(gateFile("packages", "released", `${good}.json`), "utf8")) as { digest: string; ref: string };
check("... with the digest of the package pre-receive judged, not a new build", rel.digest === report(good).package!.digest && rel.ref === "refs/heads/main"
      && (lone.stderr.match(/could not be built|Package out: sha256/g) ?? []).length === 1, JSON.stringify(rel) + lone.stderr);
g("reset", "-q", "--hard", good);

const preHook = join(server, "hooks", "pre-receive");
const gateHook = readFileSync(preHook, "utf8");
const gateLine = gateHook.split("\n").find(l => l.startsWith("exec "))!.slice(5);
writeFileSync(preHook, `#!/bin/sh\n${gateLine} || exit 1\necho "policy: pushes are closed today" >&2\nexit 1\n`);
write("site/index.html", "<h1>Home</h1><p>closed today</p>\n");
const later = commit("after the gate, another check says no");
const closed = push("origin", "HEAD:main");
check("the gate lets it in, a check of the owner's after it refuses: not released",
      closed.status !== 0 && serverMain() === good && closed.stderr.includes("pushes are closed today") && !released(later), closed.stderr);
writeFileSync(preHook, gateHook);

const postHook = join(server, "hooks", "post-receive");
const postText = readFileSync(postHook, "utf8");
rmSync(postHook);
const noPost = push("origin", "HEAD:main");
check("without the post-receive hook: let in, nothing released, and the person is told how to set it up",
      noPost.status === 0 && serverMain() === later && !released(later)
      && noPost.stderr.includes("post-receive hook is not installed") && noPost.stderr.includes("soz-guard gate install"), noPost.stderr);
writeFileSync(postHook, postText);
const reinstall = gate(["install"]);
check("install sets up both hooks", reinstall.stdout.includes("pre-receive: installed") && reinstall.stdout.includes("post-receive: installed"), reinstall.stdout);

rmSync(top, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard delivery tests passed"}`);
process.exit(failed ? 1 : 0);
