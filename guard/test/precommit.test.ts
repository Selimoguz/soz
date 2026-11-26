// precommit.test.ts — Beyond Claude Code: a git pre-commit hook that judges exactly what is being committed,
// for any agent and for people; and Codex, whose hooks take the same commands. Sample lines are unfinished
// work on purpose; each says so to soz-guard itself.

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

const repo = mkdtempSync(join(tmpdir(), "soz-guard-precommit-"));
const gitArgs = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false"];
const git = (...args: string[]) => execFileSync("git", [...gitArgs, ...args], { cwd: repo, encoding: "utf8" }).trim();
/** A real `git commit`, through the installed hook. */
const commit = (msg: string) => spawnSync("git", [...gitArgs, "commit", "-q", "-m", msg], { cwd: repo, encoding: "utf8" });
const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
// the hooks as no particular app runs them: run from Claude's desktop app, CLAUDE_CODE_ENTRYPOINT would say it is
// that app, which soz-guard asks to have the session's line written in a reply
const { CLAUDE_CODE_ENTRYPOINT: _app, ...hostless } = process.env;
const run = (args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd: repo, encoding: "utf8", input, env: hostless });
const head = () => git("rev-parse", "HEAD");

git("init", "-q", "-b", "main");
write(".gitignore", ".soz-guard/\n");
write("src/stock.ts", "export const reserve = (n: number) => n;\n");
write("test/stock.test.ts", "expect(reserve(1)).toBe(1);\nexpect(reserve(2)).toBe(2);\n");
git("add", "-A"); git("commit", "-q", "-m", "base");

console.log("\ninit --git");
const i = run(["init", "--git"]);
check("installs a pre-commit hook and an AGENTS.md section, no Claude Code hooks", i.status === 0
      && existsSync(join(repo, ".git", "hooks", "pre-commit")) && readFileSync(join(repo, "AGENTS.md"), "utf8").includes("soz-guard")
      && !existsSync(join(repo, ".claude")), i.stdout + i.stderr);
git("add", "-A");
const setup = commit("soz-guard");
check("the setup's commit is the owner's to make: a new .soz-guard.json is a criteria change", setup.status !== 0
      && setup.stderr.includes(".soz-guard.json") && !setup.stderr.includes("AGENTS.md"), setup.stderr);
git("commit", "-q", "--no-verify", "-m", "soz-guard");   // the owner, deliberately

console.log("\nWhat is being committed, and only that");
write("src/release.ts", "export function release() {\n  // TODO: release the reservation\n}\n");   // soz-guard: ignore (test data)
git("add", "src/release.ts");
let before = head();
const gap = commit("release");
check("a gap in the commit: refused", gap.status !== 0 && head() === before && gap.stderr.includes("src/release.ts:2"), gap.stderr);
write("src/release.ts", "export function release(n: number) {\n  return n;\n}\n");
git("add", "src/release.ts");
write("src/draft.ts", "// TODO: unfinished, but not staged\n");   // soz-guard: ignore (test data)
const clean = commit("release, finished");
check("a finished commit goes through, whatever is left unstaged", clean.status === 0 && head() !== before, clean.stderr);
rmSync(join(repo, "src", "draft.ts"));

rmSync(join(repo, "test", "stock.test.ts"));
git("add", "-A");
before = head();
const del = commit("drop a test");
check("a deleted test in the commit: refused, a person accepts it", del.status !== 0 && head() === before && del.stderr.includes("test/stock.test.ts"), del.stderr);
git("reset", "-q", "--hard");

console.log("\nWith the required checks");
write(".soz-guard.json", JSON.stringify({ checks: [{ name: "tests", run: `${JSON.stringify(process.execPath)} -e "process.exit(require('fs').readFileSync('src/stock.ts','utf8').includes('Math.max')?0:1)"` }] }, null, 2));
git("add", "-A"); git("commit", "-q", "--no-verify", "-m", "owner sets a check");
rmSync(join(repo, ".git", "hooks", "pre-commit"));
check("init --git --checks", run(["init", "--git", "--checks"]).stdout.includes("with the required checks"));
write("src/stock.ts", "export const reserve = (n: number) => n + 0;\n");
git("add", "-A");
before = head();
const failing = commit("stock");
check("a failing check: refused", failing.status !== 0 && head() === before && failing.stderr.includes('Check "tests"'), failing.stderr);
write("src/stock.ts", "export const reserve = (n: number) => Math.max(0, n);\n");
const unstaged = commit("stock, fixed but not staged");
check("checks are not run on files the commit leaves out: refused, says why", unstaged.status !== 0 && unstaged.stderr.includes("differ from what is being committed"), unstaged.stderr);
git("add", "-A");
const passing = commit("stock, fixed");
check("staged and passing: committed", passing.status === 0 && head() !== before, passing.stderr);

console.log("\nSomeone else's hook");
writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho theirs\n");
const other = run(["init", "--git"]);
check("is left as it is, with the line to add", other.stdout.includes("left as it is") && readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf8").includes("theirs"), other.stdout);
rmSync(join(repo, ".git", "hooks", "pre-commit"));

console.log("\nCodex");
const c = run(["init", "--codex"]);
const hooks = JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8"));
const startCommand: string = hooks.hooks.SessionStart[0].hooks[0].command, stopCommand: string = hooks.hooks.Stop[0].hooks[0].command;
// Codex runs hooks on Windows with PowerShell: a line starting with a quoted path is no command there, and -Command
// turns a native exit code 2 into 1, so the command runs with & and passes its exit code on
const ps = (sub: string) => new RegExp(`^& "[^"]+" .*"[^"]+cli\\.ts" ${sub}; exit \\$LASTEXITCODE$`);
check("init --codex: SessionStart and Stop in .codex/hooks.json" + (process.platform === "win32" ? ", in the form PowerShell runs" : ""),
      c.status === 0 && (process.platform === "win32" ? ps("session-start").test(startCommand) && ps("hook").test(stopCommand)
                                                       : startCommand.endsWith(" session-start") && stopCommand.endsWith(" hook")), startCommand);
const again = run(["init", "--codex"]);
check("running it again adds nothing", again.stdout.includes("already there")
      && JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8")).hooks.Stop.length === 1, again.stdout);
const doctorHooks = (JSON.parse(run(["doctor", "--json"]).stdout) as { hooks: { tool: string; start: string; stop: string }[] }).hooks;
check("doctor sees both Codex hooks on", doctorHooks.some(h => h.tool === "codex" && h.start === "on" && h.stop === "on"), JSON.stringify(doctorHooks));
if (process.platform === "win32") {
  // a .codex/hooks.json from an earlier soz-guard: init's command without the PowerShell form
  const plain = (cmd: string) => cmd.replace(/^& /, "").replace(/; exit \$LASTEXITCODE$/, "");
  write(".codex/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: plain(startCommand) }] }],
                                                       Stop: [{ hooks: [{ type: "command", command: plain(stopCommand) }] }] } }, null, 2) + "\n");
  const doctorText = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, "doctor"],
                               { cwd: repo, encoding: "utf8", env: { ...hostless, SOZ_GUARD_LANG: "en" } }).stdout;
  check("doctor: Codex commands from an earlier soz-guard, not in the PowerShell form: said, with what to run",
        doctorText.includes("not in that form") && doctorText.includes("soz-guard init --codex"), doctorText);
  const upgrade = run(["init", "--codex"]);
  const upgraded = JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8"));
  check("... init --codex brings them to the PowerShell form, in place: no second hook",
        upgrade.stdout.includes("updated") && upgraded.hooks.SessionStart.length === 1 && upgraded.hooks.Stop.length === 1
        && upgraded.hooks.Stop[0].hooks[0].command === stopCommand && upgraded.hooks.SessionStart[0].hooks[0].command === startCommand, upgrade.stdout);
}
git("add", "-A"); git("commit", "-q", "--no-verify", "-m", "codex");
const codexEvent = (name: string, sid: string) => run([name === "Stop" ? "hook" : "session-start"], JSON.stringify({
  session_id: sid, transcript_path: join(repo, "rollout.jsonl"), cwd: repo, hook_event_name: name, model: "m",
  ...(name === "Stop" ? { stop_hook_active: false, last_assistant_message: "done" } : { source: "startup" }) }));
const sid = `codex-${Date.now()}`;
codexEvent("SessionStart", sid);
const done = codexEvent("Stop", sid);
check("a Codex Stop with nothing open: exit 0 and JSON on stdout", done.status === 0 && done.stdout.trim() === "{}", done.stdout + done.stderr);
write("src/cancel.ts", "export function cancel() {\n  // TODO: cancel the order\n}\n");   // soz-guard: ignore (test data)
const open = codexEvent("Stop", sid);
check("a Codex Stop with a gap: exit 2, the reason on stderr", open.status === 2 && open.stderr.includes("src/cancel.ts"), open.stderr);
if (process.platform === "win32") {
  // the Stop command exactly as init wrote it, run the way Codex runs it on Windows: PowerShell -Command, the
  // event's JSON on stdin. Codex's own PowerShell is pwsh; Windows PowerShell where pwsh is not installed.
  const shell = ["pwsh", "powershell"].find(s => spawnSync(s, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0)!;
  const viaShell = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", stopCommand], { cwd: repo, encoding: "utf8", env: hostless,
    input: JSON.stringify({ session_id: sid, transcript_path: join(repo, "rollout.jsonl"), cwd: repo, hook_event_name: "Stop", model: "m", stop_hook_active: false }) });
  check(`the Stop command, run by ${shell} -Command as Codex runs it: exit code 2 kept, the reason on stderr`,
        viaShell.status === 2 && viaShell.stderr.includes("src/cancel.ts"), `${viaShell.status} ${viaShell.stderr}`);
  const without = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", stopCommand.replace(/^& /, "").replace(/; exit \$LASTEXITCODE$/, "")],
                            { cwd: repo, encoding: "utf8", env: hostless, input: "{}" });
  check(`... which the plain command would not do (${shell} does not run it: exit ${without.status})`, without.status !== 2);
}
rmSync(join(repo, "src", "cancel.ts"));
write(".codex/hooks.json", JSON.stringify({ hooks: { SessionStart: hooks.hooks.SessionStart } }, null, 2));
codexEvent("Stop", sid);
const last = JSON.parse(readFileSync(join(repo, ".soz-guard", "last.json"), "utf8")) as { criteria: { file: string; kind: string }[] };
check("the agent removes the Codex Stop hook: a guard change a person accepts", last.criteria.some(x => x.file === ".codex/hooks.json" && x.kind === "guard"));
write(".codex/hooks.json", JSON.stringify(hooks, null, 2) + "\n");
write(".codex/config.toml", "model = \"m\"\n\n[features]\nhooks = false\n");
codexEvent("Stop", sid);
const last2 = JSON.parse(readFileSync(join(repo, ".soz-guard", "last.json"), "utf8")) as { criteria: { file: string; detail: string }[] };
check("hooks switched off in .codex/config.toml: seen", last2.criteria.some(x => x.file === ".codex/config.toml" && /switched off/.test(x.detail)), JSON.stringify(last2.criteria));

rmSync(repo, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard pre-commit and Codex tests passed"}`);
process.exit(failed ? 1 : 0);
