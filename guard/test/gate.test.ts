// gate.test.ts — The gate on the server that holds the repository, end to end: a bare repository with the
// pre-receive hook installed, a developer's clone pushing to it with git itself. Sample lines below are
// unfinished work on purpose; each says so to soz-guard itself.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { criteriaFingerprint } from "../src/verdict.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : "\n          " + detail}`);
  if (!ok) failed++;
};

const top = mkdtempSync(join(tmpdir(), "soz-gate-test-"));
const server = join(top, "server.git"), dev = join(top, "dev");
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                                { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const g = (...args: string[]) => gitIn(dev, ...args);
const write = (path: string, text: string) => { mkdirSync(dirname(join(dev, path)), { recursive: true }); writeFileSync(join(dev, path), text); };
const commit = (msg: string) => { g("add", "-A"); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
const push = (...args: string[]) => spawnSync("git", ["push", ...args], { cwd: dev, encoding: "utf8" });
const serverMain = () => gitIn(server, "rev-parse", "main");
const gate = (args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, "gate", ...args], { cwd: server, encoding: "utf8", input });
/** After a push the gate turned down, the developer starts again from what the server has. */
const back = () => { g("fetch", "-q", "origin"); g("reset", "-q", "--hard", "origin/main"); };
type Report = { state: string; approved: string | null; verdict: { criteria: never[]; checks: { name: string; status: string }[] } };
const report = (commit: string) => JSON.parse(readFileSync(join(server, ".soz-guard", "gate", "reports", `${commit}.json`), "utf8")) as Report;

execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", server], { encoding: "utf8" });
gitIn(top, "clone", "-q", server.replace(/\\/g, "/"), "dev");
g("config", "core.autocrlf", "false");

console.log("\nInstalling the gate on the server");
// the setup installs what the checks need (here: a file in node_modules), the check needs it, and fails on a FAIL file
const setup = `node -e "require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/ready','1')"`;
const i = gate(["install", "--branches", "main,production", "--setup", setup]);
check("gate install: the pre-receive hook and the config", i.status === 0 && existsSync(join(server, "hooks", "pre-receive"))
      && i.stdout.includes("a user of its own"), i.stdout + i.stderr);
const testCheck = `node -e "const fs=require('fs');process.exit(fs.existsSync('node_modules/ready')&&!fs.existsSync('FAIL')?0:1)"`;
write(".gitignore", "node_modules/\n.soz-guard/\n");
write(".soz-guard.json", JSON.stringify({ checks: [{ name: "tests", run: testCheck }] }, null, 2));
write("src/stock.ts", "export const reserve = (n: number) => n;\n");
write("test/stock.test.ts", "expect(reserve(1)).toBe(1);\nexpect(reserve(2)).toBe(2);\n");
commit("base");
const p0 = push("-q", "origin", "main");
check("the first push: nothing to compare it with, let in", p0.status === 0 && serverMain() === g("rev-parse", "HEAD"), p0.stderr);

console.log("\nPushes the gate turns down");
const live = serverMain();
write("src/release.ts", "export function release() {\n  // TODO: release the reservation\n}\n");   // soz-guard: ignore (test data)
commit("release, unfinished");
const p1 = push("origin", "main");
check("a TODO pushed to main: turned down, and the pusher is told why", p1.status !== 0 && serverMain() === live
      && p1.stderr.includes("not let in") && p1.stderr.includes("src/release.ts:2"), p1.stderr);
const p2 = push("-q", "origin", "HEAD:refs/heads/feature/release");
check("... the same pushed to a branch that is not protected: let in (an integrator looks at it there)", p2.status === 0, p2.stderr);
const c = gate(["check", "feature/release", "--base", "main"]);
check("gate check on that branch, by hand: the same verdict, for the integrator", c.status === 1 && c.stdout.includes("src/release.ts:2"), c.stdout + c.stderr);
back();
write("FAIL", "1\n");
commit("breaks the tests");
const p3 = push("origin", "main");
check("a failing check: turned down", p3.status !== 0 && serverMain() === live && p3.stderr.includes('Check "tests"'), p3.stderr);
back();
write(".soz-guard.json", JSON.stringify({ checks: [], criteriaChanges: "report" }, null, 2));
g("rm", "-q", "test/stock.test.ts");
commit("drop the test, and the check, and blocking");
const p4 = push("origin", "main");
check("a test deleted and the rules loosened in the same push: turned down, by the rules that are live", p4.status !== 0 && serverMain() === live
      && p4.stderr.includes("test/stock.test.ts"), p4.stderr);
back();
const p5 = push("origin", ":main");
check("main deleted by a push: turned down", p5.status !== 0 && serverMain() === live, p5.stderr);

console.log("\nWhat the gate lets in");
write("src/stock.ts", "export const reserve = (n: number) => Math.max(0, n);\n");
const good = commit("never below zero");
const p6 = push("origin", "main");
check("finished work: let in", p6.status === 0 && serverMain() === good && p6.stderr.includes("verified, let in"), p6.stderr);
check("... after the setup ran and the checks ran on exactly the pushed commit", report(good).state === "verified"
      && report(good).verdict.checks.some(k => k.name === "tests" && k.status === "passed"));

console.log("\nA test that really is obsolete: a person approves it on the server");
g("rm", "-q", "test/stock.test.ts");
write("test/stock2.test.ts", "expect(reserve(1)).toBe(1);\n");
const drop = commit("the old test is replaced");
const p7 = push("origin", "main");
check("turned down, with how a person approves it", p7.status !== 0 && p7.stderr.includes("soz-guard gate approve"), p7.stderr);
const a1 = gate(["approve", drop.slice(0, 12), "the test moved to stock2"]);
check("gate approve, by the start of the hash the gate printed (git dropped the commit itself): found, and without a terminal (an agent) refused",
      a1.status === 2 && a1.stderr.includes("needs a terminal"), a1.stdout + a1.stderr);
// what a person's "yes" in a terminal writes
mkdirSync(join(server, ".soz-guard", "gate", "approved"), { recursive: true });
writeFileSync(join(server, ".soz-guard", "gate", "approved", `${drop}.json`),
  JSON.stringify({ commit: drop, criteria: criteriaFingerprint(report(drop).verdict.criteria), reason: "the test moved to stock2", by: "boss", at: "now" }));
const p8 = push("origin", "main");
check("approved: let in, and the report says so", p8.status === 0 && serverMain() === drop && report(drop).approved === "the test moved to stock2", p8.stderr);
g("rm", "-q", "test/stock2.test.ts");
write("FAIL", "1\n");
const both = commit("drop the other test, and break the code");
writeFileSync(join(server, ".soz-guard", "gate", "approved", `${both}.json`),
  JSON.stringify({ commit: both, criteria: criteriaFingerprint(report(drop).verdict.criteria), reason: "an approval for other changes", by: "boss", at: "now" }));
const p9 = push("origin", "main");
check("an approval for other changes approves nothing", p9.status !== 0 && serverMain() === drop, p9.stderr);
back();

console.log("\nThe gate's log");
const l = gate(["log", "--last", "50"]);
check("every verdict, with who pushed and what it found", l.status === 0 && /main [0-9a-f]{10} open/.test(l.stdout) && /verified/.test(l.stdout)
      && l.stdout.includes("approved"), l.stdout);
check("the log is chained and intact", gate(["log", "--verify"]).stdout.includes("intact"));

console.log("\nAn existing pre-receive hook");
const other = join(top, "other.git");
execFileSync("git", ["init", "-q", "--bare", other], { encoding: "utf8" });
writeFileSync(join(other, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
const io = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, "gate", "install"], { cwd: other, encoding: "utf8" });
check("left as it is, with the line to add", io.status === 0 && readFileSync(join(other, "hooks", "pre-receive"), "utf8") === "#!/bin/sh\nexit 0\n"
      && io.stdout.includes("gate pre-receive || exit 1"), io.stdout);

rmSync(top, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard gate tests passed"}`);
process.exit(failed ? 1 : 0);
