// verdict.test.ts — soz-guard 0.2 on real git repositories: checks the owner requires, run by soz-guard
// itself; the verdict (verified, unchecked, unverified, open); guarding the criteria; CI; replay.
// Sample lines below are unfinished work on purpose; each says so to soz-guard itself.

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

const repo = mkdtempSync(join(tmpdir(), "soz-guard-v2-"));
const counter = join(mkdtempSync(join(tmpdir(), "soz-guard-count-")), "runs.txt");
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                 { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const run = (args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd: repo, encoding: "utf8", input });
const node = JSON.stringify(process.execPath);
const script = (js: string) => `${node} -e "${js}"`;
const runs = () => existsSync(counter) ? readFileSync(counter, "utf8").length : 0;
let session = 0;
const hook = () => run(["hook"], JSON.stringify({ cwd: repo, session_id: `v2-${Date.now()}-${++session}`, hook_event_name: "Stop" }));
const last = () => JSON.parse(readFileSync(join(repo, ".soz-guard", "last.json"), "utf8")) as {
  state: string; change: string; checks: { name: string; status: string; reused?: boolean }[]; criteria: { kind: string; file: string }[] };
/** The owner sets the rules and commits them, as a repository's owner would. */
const owner = (config: object) => { write(".soz-guard.json", JSON.stringify(config, null, 2)); git("add", "-A"); git("commit", "-q", "-m", "rules"); };

git("init", "-q", "-b", "main");
write(".gitignore", ".soz-guard/\n");
write("src/stock.ts", "export function reserve(n: number) {\n  return n;\n}\n");
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\nexpect(reserve(2)).toBe(2);\nexpect(reserve(0)).toBe(0);\n');
write("docs/notes.txt", "notes\n");
git("add", "-A"); git("commit", "-q", "-m", "base");

console.log("\nChecks the owner requires, run by soz-guard itself");
owner({ checks: [{ name: "tests", run: script(`require('fs').appendFileSync(process.argv[1], 'x')`) + ` "${counter}"`, when: ["src/**", "test/**"] }] });
write("src/stock.ts", "export function reserve(n: number) {\n  return Math.max(0, n);\n}\n");
const h1 = hook();
check("a passing check: the agent may finish", h1.status === 0, h1.stderr);
check("... the verdict is verified, and recorded with the check", last().state === "verified" && last().checks[0]?.status === "passed");
check("... the check really ran (soz-guard ran it, not the agent)", runs() === 1);
hook();
check("the same change again: the result is reused, the check does not run twice", runs() === 1 && last().checks[0]?.reused === true);
write("src/stock.ts", "export function reserve(n: number) {\n  return Math.max(0, Math.floor(n));\n}\n");
hook();
check("another change: the check runs again", runs() === 2);
const a = JSON.parse(run(["check", "--json", "--no-checks"]).stdout), b = JSON.parse(run(["check", "--json", "--no-checks"]).stdout);
check("the same change gives the same fingerprint and verdict (deterministic)", a.change === b.change && a.state === b.state);
git("add", "-A"); git("commit", "-q", "-m", "floor");
write("docs/notes.txt", "notes, longer\n");
hook();
check("a change the check does not cover (when): unchecked, the check does not run", last().state === "unchecked" && runs() === 2);
git("checkout", "-q", "--", "docs/notes.txt");

owner({ checks: [{ name: "tests", run: script(`console.log('stock: 1 failing'); console.log('expected 0, got -1'); process.exit(1)`) }] });
write("src/stock.ts", "export function reserve(n: number) {\n  return n - 1;\n}\n");
const h2 = hook();
check("a failing check: the agent may not finish", h2.status === 2);
check("... it sees which check, the exit code and the output", h2.stderr.includes('Check "tests"') && h2.stderr.includes("failed (exit 1)") && h2.stderr.includes("expected 0, got -1"), h2.stderr);
check("... and is told to fix the code, not the check", h2.stderr.includes("not the check"));
check("... the verdict is open", last().state === "open");

owner({ checks: [{ name: "slow", run: script(`setTimeout(() => {}, 8000)`), timeoutSeconds: 1 }] });
write("src/stock.ts", "export function reserve(n: number) {\n  return n * 1;\n}\n");
const h3 = hook();
check("a check that does not finish in time: unverified, the agent may not finish", h3.status === 2 && last().state === "unverified" && h3.stderr.includes("did not finish in time"), h3.stderr);
git("checkout", "-q", "--", "src/stock.ts");

console.log("\nThe criteria: an agent may add to the tests, not weaken them");
owner({ checks: [] });
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\nexpect(reserve(2)).toBe(2);\nexpect(reserve(0)).toBe(0);\nexpect(reserve(5)).toBe(5);\n');
hook();
check("a new assertion: fine", last().criteria.length === 0 && last().state === "unchecked");
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\nexpect(reserve(2)).toBe(2);\nexpect(reserve(0)).toBe(1);\n');
hook();
check("an assertion changed (one removed, one added): fine", last().criteria.length === 0);
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\nexpect(reserve(2)).toBe(2);\n');
const h4 = hook();
check("an assertion removed: open, a person has to accept it", h4.status === 2 && last().criteria[0]?.kind === "assertions-removed" && h4.stderr.includes("soz-guard accept"), h4.stderr);
git("checkout", "-q", "--", "test/stock.test.ts");
rmSync(join(repo, "test", "stock.test.ts"));
hook();
check("a test file deleted: open", last().state === "open" && last().criteria[0]?.kind === "deleted");
git("checkout", "-q", "--", "test/stock.test.ts");
// found trying a real project: node_modules committed to git, then removed; its packages' own tests are not the criteria
write("node_modules/somepkg/test/index.test.js", 'expect(1).toBe(1);\n');
git("add", "-f", "node_modules"); git("commit", "-q", "-m", "a project that committed node_modules");
rmSync(join(repo, "node_modules"), { recursive: true, force: true });
hook();
check("a package's tests deleted inside node_modules (excluded): not the project's criteria", last().criteria.length === 0);
git("checkout", "-q", "--", "node_modules");
write(".soz-guard.json", JSON.stringify({ checks: [], disable: ["todo"] }));
hook();
check("the agent changes soz-guard's rules: open", last().state === "open" && last().criteria[0]?.kind === "config");
const piped = run(["accept", "the rule is obsolete"], "yes\n");
check("accept from piped input is refused: a person types it in a terminal", piped.status === 2 && piped.stderr.includes("needs a terminal"));
// what a person's acceptance in a terminal writes, for exactly these changes
writeFileSync(join(repo, ".soz-guard", "accepted.json"), JSON.stringify({ criteria: criteriaFingerprint(last().criteria as never), reason: "agreed with the team", at: "now" }));
check("accepted by a person: no longer open", hook().status === 0 && last().state === "unchecked");
write(".soz-guard.json", JSON.stringify({ checks: [], disable: ["todo", "fake-data"] }));
check("... but a further change needs accepting again", hook().status === 2);
git("checkout", "-q", "--", ".soz-guard.json");
owner({ checks: [], criteriaChanges: "report" });
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\n');
check('criteriaChanges "report": reported, not blocking', hook().status === 0 && last().criteria.length === 1);
git("checkout", "-q", "--", "test/stock.test.ts");

console.log('\n"assertions": "any-change": an existing assertion is the owner\'s too');
owner({ checks: [], assertions: "any-change" });
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\nexpect(reserve(2)).toBe(2);\nexpect(reserve(0)).toBe(1);\n');
const h5 = hook();
check("an expected value changed (0 to 1), as many assertions as before: open", h5.status === 2 && last().criteria[0]?.kind === "assertions-changed"
      && h5.stderr.includes("expect(reserve(0)).toBe(0)"), h5.stderr);
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\nexpect(reserve(2)).toBe(2);\nexpect(reserve(0)).toBe(3);\ntest("new", () => { expect(reserve(0)).toBe(0); });\n');
hook();
check("found in the live trial: a value changed in one test, hidden behind an identical line in a new one: still open",
      last().state === "open" && last().criteria[0]?.kind === "assertions-changed");
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\nexpect(reserve(0)).toBe(0);\nexpect(reserve(2)).toBe(2);\n');
hook();
check("an assertion moved unchanged: the diff cannot tell it from a change, so a person accepts it once", last().state === "open");
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\nexpect(reserve(2)).toBe(2);\nexpect(reserve(1)).toBe(1);\nexpect(reserve(0)).toBe(0);\n');
hook();
check("a new assertion between the old ones (what the agent did in the live trial): fine", last().criteria.length === 0);
git("checkout", "-q", "--", "test/stock.test.ts");
check('a bad "assertions" value stops with a clear message', (() => {
  write(".soz-guard.json", JSON.stringify({ assertions: "some" }));
  const r = run(["check", "--no-checks"]);
  git("checkout", "-q", "--", ".soz-guard.json");
  return r.status === 1 && r.stderr.includes('"assertions" is "fewer" or "any-change"');
})());
owner({ checks: [] });

console.log("\nci: the same decision on a pull request");
git("checkout", "-q", "-b", "feature");
write("src/screen.ts", 'export const save = () => {\n  // TODO: call the API\n};\n');   // soz-guard: ignore (test data)
git("add", "-A"); git("commit", "-q", "-m", "screen");
const c1 = run(["ci", "--base", "main"]);
check("unfinished work in the branch: ci fails", c1.status === 1 && c1.stdout.includes("src/screen.ts:2"), c1.stdout + c1.stderr);
write("src/screen.ts", 'export const save = (api: { post(): void }) => {\n  api.post();\n};\n');
git("add", "-A"); git("commit", "-q", "-m", "screen done");
check("finished: ci passes", run(["ci", "--base", "main"]).status === 0);
write("test/stock.test.ts", 'import { reserve } from "../src/stock";\n');
git("add", "-A"); git("commit", "-q", "-m", "drop assertions");
const c3 = run(["ci", "--base", "main"]);
check("assertions removed in the branch: ci fails, and says so", c3.status === 1 && c3.stdout.includes("assertions-removed"));
check("--criteria report: a team that reviews test changes in the PR", run(["ci", "--base", "main", "--criteria", "report"]).status === 0);

console.log("\nreplay: past commits, judged as soz-guard would have");
const rp = run(["replay", "main..feature"]);
check("replay lists each commit with its verdict", rp.status === 0 && rp.stdout.split("\n").filter(l => /^[0-9a-f]{10}  /.test(l)).length === 3, rp.stdout + rp.stderr);
check("... and counts what it would have stopped (the TODO, the dropped assertions)", rp.stdout.includes("would have stopped 2"), rp.stdout);
const rj = JSON.parse(run(["replay", "main..feature", "--json"]).stdout) as { state: string; unfinished: number; criteria: number }[];
check("--json: per commit, for a pilot's numbers", rj.length === 3 && rj[0].unfinished === 1 && rj[2].criteria === 1);
check("a root commit can be replayed too", run(["replay", git("rev-list", "--max-parents=0", "HEAD")]).status === 0);

rmSync(repo, { recursive: true, force: true });
rmSync(dirname(counter), { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard verdict tests passed"}`);
process.exit(failed ? 1 : 0);
