// review.test.ts — What the second full review found, each closed and kept closed: a change judged by the rules
// before it, the gate's checks in a CI checkout, the hook's state, init in a team, and soz-guard's own hooks.
// Sample lines below are unfinished work on purpose; each says so to soz-guard itself.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { criteriaFingerprint } from "../src/verdict.ts";
import { canonicalCommand } from "../src/guard.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : "\n          " + detail}`);
  if (!ok) failed++;
};

const repo = mkdtempSync(join(tmpdir(), "soz-guard-review-"));
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                                { cwd, encoding: "utf8" }).trim();
const git = (...args: string[]) => gitIn(repo, ...args);
const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const runIn = (cwd: string, args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd, encoding: "utf8", input });
const run = (args: string[], input?: string) => runIn(repo, args, input);
const json = (args: string[]) => JSON.parse(run(args).stdout) as {
  state: string; change: string; criteriaAccepted: unknown; findings: { rule: string }[]; criteria: { file: string; kind: string; evidence: string; detail: string }[];
  checks: { name: string; status: string }[] };
const owner = (config: object) => { write(".soz-guard.json", JSON.stringify(config, null, 2)); git("add", "-A"); git("commit", "-q", "-m", "rules"); };
const node = JSON.stringify(process.execPath);
const TODO = "// TODO: finish the release\n";   // soz-guard: ignore (test data)

git("init", "-q", "-b", "main");
git("config", "core.autocrlf", "false");   // line endings as they are on disk, for soz-guard's git too
write(".gitignore", ".soz-guard/\n");
write("src/stock.ts", "export const reserve = (n: number) => n;\n");
write("test/stock.test.ts", "expect(reserve(1)).toBe(1);\nexpect(reserve(2)).toBe(2);\n");
owner({ checks: [] });

console.log("\nA change is judged by the rules before it, not by the rules it brings");
git("checkout", "-q", "-b", "loosen");
git("rm", "-q", "test/stock.test.ts");
write(".soz-guard.json", JSON.stringify({ checks: [], criteriaChanges: "report" }));
git("add", "-A"); git("commit", "-q", "-m", "drop the test, and stop blocking on that");
const l1 = run(["ci", "--base", "main"]);
check('a branch that deletes a test and sets criteriaChanges "report": ci still fails', l1.status === 1
      && l1.stdout.includes("test/stock.test.ts") && l1.stdout.includes(".soz-guard.json"), l1.stdout + l1.stderr);
git("checkout", "-q", "main"); git("checkout", "-q", "-b", "disable");
write("src/release.ts", TODO);
write(".soz-guard.json", JSON.stringify({ checks: [], disable: ["todo"] }));
git("add", "-A"); git("commit", "-q", "-m", "a TODO, and the rule switched off");
const l2 = JSON.parse(run(["ci", "--base", "main", "--json"]).stdout) as { state: string; findings: { rule: string }[] };
check("a branch that switches the todo rule off and adds a TODO: the TODO is still found", l2.state === "open" && l2.findings.some(f => f.rule === "todo"), JSON.stringify(l2));
git("checkout", "-q", "main"); git("checkout", "-q", "-b", "checks");
owner({ checks: [{ name: "tests", run: `${node} -e "process.exit(1)"` }] });
git("checkout", "-q", "main"); git("merge", "-q", "--ff-only", "checks");
write(".soz-guard.json", JSON.stringify({ checks: [] }));
write("src/stock.ts", "export const reserve = (n: number) => Math.max(0, n);\n");
const l3 = run(["hook"], JSON.stringify({ cwd: repo, session_id: `rv-${Date.now()}-maxblocks`, hook_event_name: "Stop" }));
check("the agent removes the failing check from the config: still stopped (the config change waits for a person)", l3.status === 2
      && l3.stderr.includes(".soz-guard.json"), l3.stderr);
write(".soz-guard.json", JSON.stringify({ checks: [{ name: "tests", run: `${node} -e "process.exit(1)"` }], maxBlocks: 0 }));
write("src/release.ts", TODO);
const l4 = run(["hook"], JSON.stringify({ cwd: repo, session_id: `rv-${Date.now()}-maxblocks0`, hook_event_name: "Stop" }));
check("... or sets maxBlocks 0 and leaves a TODO: still stopped, the rules before the change allow 3", l4.status === 2
      && l4.stderr.includes("src/release.ts"), l4.stdout + l4.stderr);
rmSync(join(repo, "src", "release.ts"));
write(".soz-guard.json", JSON.stringify({ checks: [] }));
const proposed = json(["check", "--json", "--no-checks"]);
mkdirSync(join(repo, ".soz-guard"), { recursive: true });
writeFileSync(join(repo, ".soz-guard", "accepted.json"), JSON.stringify({ criteria: criteriaFingerprint(proposed.criteria as never), reason: "the check is obsolete", at: "now" }));
const accepted = json(["check", "--json"]);
check("once a person accepts the new config, it is the rules: the removed check no longer runs", accepted.state === "unchecked"
      && accepted.checks.length === 0 && accepted.criteriaAccepted === "the check is obsolete", JSON.stringify(accepted));
rmSync(join(repo, ".soz-guard", "accepted.json"));
write(".soz-guard.json", '{ "assertions": ');
const broken = run(["check", "--no-checks"]);
check("a config the change broke is still said at once, naming the file", broken.status !== 0 && broken.stderr.includes(".soz-guard.json is not valid JSON"), broken.stderr);
git("checkout", "-q", "--", ".soz-guard.json", "src/stock.ts");
owner({ checks: [] });

console.log("\nThe gate's checks in a CI checkout");
owner({ checks: [{ name: "fine", run: `${node} -e "process.exit(0)"` }] });
git("checkout", "-q", "-b", "built");
write("src/more.ts", "export const more = 1;\n");
git("add", "-A"); git("commit", "-q", "-m", "more");
write("coverage/lcov.info", "TN:\n");
write("src/__pycache__/x.pyc", "bytes\n");
const b1 = run(["ci", "--base", "main", "--checks"]);
check("what a test run leaves behind (coverage/, __pycache__/) does not keep the checks from running", b1.status === 0 && b1.stdout.includes("verified"), b1.stdout);
rmSync(join(repo, "coverage"), { recursive: true, force: true }); rmSync(join(repo, "src", "__pycache__"), { recursive: true, force: true });
const nb = run(["ci", "--base", "no-such-branch"]);
check("a base that is not in the clone: said plainly", nb.status === 1 && nb.stderr.includes("is not in this clone"), nb.stderr);
const shallow = mkdtempSync(join(tmpdir(), "soz-guard-shallow-"));
gitIn(shallow, "clone", "-q", "--depth", "1", "--no-single-branch", `file://${repo.replace(/\\/g, "/")}`, "c");
const clone = join(shallow, "c");
gitIn(clone, "checkout", "-q", "built");
const sh = runIn(clone, ["ci", "--base", "origin/main"]);
check("a shallow clone, where the base's history is missing: says to fetch it", sh.status === 1 && sh.stderr.includes("fetch-depth: 0"), sh.stderr + sh.stdout);
rmSync(shallow, { recursive: true, force: true });
git("checkout", "-q", "main");

console.log("\nThe hook's state");
const sid = `rv-${Date.now()}-told`;
const hookAs = () => run(["hook"], JSON.stringify({ cwd: repo, session_id: sid, hook_event_name: "Stop" }));
git("rm", "-q", "test/stock.test.ts");
const t1 = hookAs();
write("src/other.ts", "export const other = 1;\n");
const t2 = hookAs();
check("the agent deletes a test, is told, and goes on working: stopped again", t1.status === 2 && t2.status === 2, t2.stdout + t2.stderr);
const t3 = hookAs();
check("... and once it stops as it was told, it is let go and the person is told", t3.status === 0 && JSON.parse(t3.stdout).systemMessage.includes("still waiting for you"), t3.stdout);
git("checkout", "-q", "HEAD", "--", "test/stock.test.ts"); rmSync(join(repo, "src", "other.ts"));
write("src/release.ts", TODO);
const root = git("rev-parse", "--show-toplevel");
const stateFile = join(tmpdir(), `soz-guard-default-${createHash("sha256").update(root).digest("hex").slice(0, 12)}.json`);
rmSync(stateFile, { force: true });
const d = run(["hook"], JSON.stringify({ cwd: repo, hook_event_name: "Stop" }));
check("without a session id, the count is this repository's own, not shared by every project", d.status === 2 && existsSync(stateFile), d.stderr);
rmSync(stateFile, { force: true }); rmSync(join(repo, "src", "release.ts"));
check("no criteria changed: criteriaAccepted is null, not 0", json(["check", "--json", "--no-checks"]).criteriaAccepted === null);

console.log("\nsoz-guard's own commands");
const stub = join(mkdtempSync(join(tmpdir(), "soz-guard-stub-")), "cli.js");
writeFileSync(stub, "process.exit(0);\n");
const stubCommand = `${node} "${stub}" hook`;
check("a cli.js outside the repository that is not this soz-guard is not soz-guard's hook", canonicalCommand(stubCommand, repo, true) === stubCommand);
rmSync(dirname(stub), { recursive: true, force: true });
check("Node under another name (nodejs) is still soz-guard's command", canonicalCommand(`"/usr/bin/nodejs" "/opt/soz-guard/dist/cli.js" hook`) === "soz-guard hook");
write("test/stock.test.ts", "expect(reserve(1)).toBe(1);\r\nexpect(reserve(2)).toBe(2);\n");
const cr = json(["check", "--json", "--no-checks"]).change;
write("test/stock.test.ts", "expect(reserve(1)).toBe(1);\r\nexpect(reserve(2)).toBe(2);\r\n");
check("only the line endings changed: a different change, so checks are not reused from before", json(["check", "--json", "--no-checks"]).change !== cr);
git("checkout", "-q", "--", "test/stock.test.ts");

console.log("\ninit in a team");
const portable = { hooks: { Stop: [{ hooks: [{ type: "command", command: "npx soz-guard hook" }] }] } };
write(".claude/settings.json", JSON.stringify(portable, null, 2));
const i1 = run(["init"]);
const shared = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
check("init leaves a portable hook written by hand (npx soz-guard hook) as it is", i1.status === 0 && shared.hooks.Stop.length === 1
      && shared.hooks.Stop[0].hooks[0].command === "npx soz-guard hook", JSON.stringify(shared.hooks.Stop));
rmSync(join(repo, ".claude"), { recursive: true, force: true });
run(["init"]);                                       // the shared settings run this very soz-guard
const i2 = run(["init", "--local"]);
const local = existsSync(join(repo, ".claude", "settings.local.json")) ? JSON.parse(readFileSync(join(repo, ".claude", "settings.local.json"), "utf8")) : {};
check("init --local where settings.json already runs this soz-guard: not added twice", i2.status === 0 && !(local.hooks?.Stop ?? []).length
      && i2.stdout.includes("already runs it on this machine"), i2.stdout + JSON.stringify(local));
rmSync(join(repo, ".claude"), { recursive: true, force: true });
write(".claude/settings.local.json", "{}\n");
git("add", "-f", ".claude/settings.local.json"); git("commit", "-q", "-m", "settings.local.json committed by mistake");
const i3 = run(["init", "--local"]);
check("init --local where settings.local.json is in git already: says how to take it out", i3.stdout.includes("git rm --cached .claude/settings.local.json"), i3.stdout);
run(["init", "--local"]);
check("... and .gitignore gets the line once, however often init runs",
      readFileSync(join(repo, ".gitignore"), "utf8").split(/\r?\n/).filter(l => l.trim() === ".claude/settings.local.json").length === 1);

console.log("\naccept");
mkdirSync(join(repo, ".soz-guard"), { recursive: true });
writeFileSync(join(repo, ".soz-guard", "accepted.json"), "{}\n");
git("add", "-f", ".soz-guard/accepted.json"); git("commit", "-q", "-m", "an acceptance in git");
const a1 = run(["accept", "the test is obsolete"]);
check("accept where an acceptance is in git: refuses, instead of saying \"Accepted\" for nothing", a1.status === 1
      && a1.stderr.includes("git rm --cached .soz-guard/accepted.json") && !a1.stdout.includes("Accepted"), a1.stdout + a1.stderr);

rmSync(repo, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard review tests passed"}`);
process.exit(failed ? 1 : 0);
