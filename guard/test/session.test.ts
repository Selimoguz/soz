// session.test.ts — Only what the agent changed: a baseline at the session's start, the verdict at its end
// about what changed since. Sample lines are unfinished work on purpose; each says so to soz-guard itself.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : "\n          " + detail}`);
  if (!ok) failed++;
};

const repo = mkdtempSync(join(tmpdir(), "soz-guard-session-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                 { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const run = (args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd: repo, encoding: "utf8", input });
// session ids are unique per run: the hook keeps a per-session block count in the system's temp folder
const RUN = `t${Date.now()}`;
const sid = (name: string) => `${RUN}-${name}`;
const sessionFile = (name: string) => join(repo, ".soz-guard", "sessions", `${sid(name)}.json`);
const event = (sub: string, session: string, source = "startup") =>
  run([sub], JSON.stringify({ cwd: repo, session_id: sid(session), source, hook_event_name: sub === "hook" ? "Stop" : "SessionStart" }));
const last = () => JSON.parse(readFileSync(join(repo, ".soz-guard", "last.json"), "utf8")) as {
  state: string; findings: { file: string }[]; criteria: { file: string; kind: string }[] };

git("init", "-q", "-b", "main");
write(".gitignore", ".soz-guard/\n");
write("src/stock.ts", "export const reserve = (n: number) => n;\n");
write("test/stock.test.ts", "expect(reserve(1)).toBe(1);\nexpect(reserve(2)).toBe(2);\n");
git("add", "-A"); git("commit", "-q", "-m", "base");

console.log("\nBefore the session: someone's uncommitted work, with a gap and a deleted test");
write("src/draft.ts", "// TODO: someone else's unfinished draft\nexport const draft = 1;\n");   // soz-guard: ignore (test data)
write("test/stock.test.ts", "expect(reserve(1)).toBe(1);\n");
const indexBefore = git("diff", "--cached", "--name-only");
const statusBefore = git("status", "--porcelain");
check("without a session baseline, soz-guard judges it all (HEAD): open", event("hook", "no-baseline").status === 2);

console.log("\nA session starts");
check("session-start records a baseline and stays silent", event("session-start", "s1").status === 0
      && existsSync(sessionFile("s1")));
check("... without touching the working tree or the index", git("status", "--porcelain") === statusBefore && git("diff", "--cached", "--name-only") === indexBefore);
check("nothing changed in the session: the earlier work is not this agent's", event("hook", "s1").status === 0 && last().findings.length === 0 && last().criteria.length === 0);

write("src/stock.ts", "export const reserve = (n: number) => Math.max(0, n);\n");
const clean = event("hook", "s1");
check("a clean change in the session: finished, whatever was there before", clean.status === 0, clean.stderr);

write("src/release.ts", "export function release() {\n  // TODO: release the reservation\n}\n");   // soz-guard: ignore (test data)
const gap = event("hook", "s1");
check("a gap the session added: open, and only that one", gap.status === 2 && gap.stderr.includes("src/release.ts:2") && !gap.stderr.includes("src/draft.ts"), gap.stderr);
git("add", "src/release.ts"); git("commit", "-q", "-m", "agent commits its gap");
check("... still open after the agent commits it", event("hook", "s1").status === 2 && last().findings.some(f => f.file === "src/release.ts"));
write("src/release.ts", "export function release(n: number) {\n  return n;\n}\n");
git("add", "src/release.ts"); git("commit", "-q", "-m", "fixed");

rmSync(join(repo, "test", "stock.test.ts"));
event("hook", "s1");
check("a test deleted in the session: a criteria change (the one deleted before was not)", last().state === "open" && last().criteria.some(c => c.file === "test/stock.test.ts" && c.kind === "deleted"));
write("test/stock.test.ts", "expect(reserve(1)).toBe(1);\n");

console.log("\nResuming, and another session");
const before = readFileSync(sessionFile("s1"), "utf8");
event("session-start", "s1", "resume");
check("a resumed session keeps its own baseline", readFileSync(sessionFile("s1"), "utf8") === before);
event("session-start", "s2");
check("a new session starts from now: what s1 left is not s2's", event("hook", "s2").status === 0);

console.log("\ninit installs both hooks");
const i = run(["init"]);
const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
check("SessionStart and Stop", i.status === 0 && settings.hooks.SessionStart[0].hooks[0].command.endsWith(" session-start")
      && settings.hooks.Stop[0].hooks[0].command.endsWith(" hook"), i.stdout + i.stderr);
run(["init"]);
const again = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
check("running init again adds nothing", again.hooks.SessionStart.length === 1 && again.hooks.Stop.length === 1);

rmSync(repo, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard session tests passed"}`);
process.exit(failed ? 1 : 0);
