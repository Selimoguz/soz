// sessions.test.ts — Several agent sessions in one folder: each answers for the files it touched, recorded
// by the PreToolUse / PostToolUse tracking hooks. Sample lines are unfinished work on purpose; each says so
// to soz-guard itself.

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
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

const repo = mkdtempSync(join(tmpdir(), "soz-guard-sessions-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                 { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const run = (args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd: repo, encoding: "utf8", input });
const RUN = `m${Date.now()}`;
const sid = (n: string) => `${RUN}-${n}`;
const send = (sub: string, body: object) => run([sub], JSON.stringify({ cwd: repo, ...body }));
const start = (s: string) => send("session-start", { session_id: sid(s), source: "startup", hook_event_name: "SessionStart" });
const stop = (s: string) => send("hook", { session_id: sid(s), hook_event_name: "Stop" });
/** What Claude Code does when session S writes a file with its Write tool: the file changes, then PostToolUse. */
const toolWrite = (s: string, path: string, text: string) => {
  write(path, text);
  send("track", { session_id: sid(s), hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: `w${Math.random()}`, tool_input: { file_path: join(repo, path) } });
};
/** Session S runs a shell command that changes files: PreToolUse, the change, PostToolUse. */
const shell = (s: string, change: () => void) => {
  const id = `b${Math.random()}`.replace(".", "");
  send("track", { session_id: sid(s), hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, tool_input: {} });
  change();
  send("track", { session_id: sid(s), hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: {} });
};
const last = () => JSON.parse(readFileSync(join(repo, ".soz-guard", "last.json"), "utf8")) as {
  state: string; foreign?: string[]; findings: { file: string }[]; criteria: { file: string; kind: string }[] };

git("init", "-q", "-b", "main");
write(".gitignore", ".soz-guard/\n");
write("src/erp.ts", "export const stock = 1;\n");
write("src/crm.ts", "export const lead = 1;\n");
git("add", "-A"); git("commit", "-q", "-m", "base");
const i = run(["init", "--sessions"]);
const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
check("init --sessions: tracking hooks, besides SessionStart and Stop", i.status === 0
      && settings.hooks.PostToolUse[0].hooks[0].command.endsWith(" track") && settings.hooks.PreToolUse[0].matcher.includes("Bash")
      && settings.hooks.Stop.length === 1, i.stdout + i.stderr);
check("running it again adds nothing", run(["init", "--sessions"]).stdout.includes("tracking hook is already there"));
git("add", "-A"); git("commit", "-q", "-m", "soz-guard");

console.log("\nTwo sessions, one folder");
start("erp"); start("crm");
toolWrite("crm", "src/crm.ts", "export function lead() {\n  // TODO: score the lead\n}\n");   // soz-guard: ignore (test data)
toolWrite("erp", "src/erp.ts", "export const stock = (n: number) => Math.max(0, n);\n");
const erp = stop("erp");
check("ERP finishes: CRM's gap is not its own", erp.status === 0 && last().findings.length === 0, erp.stderr);
check("... and the verdict names the files left to other sessions", (last().foreign ?? []).includes("src/crm.ts"), JSON.stringify(last().foreign));
const crm = stop("crm");
check("CRM is stopped for its own gap", crm.status === 2 && crm.stderr.includes("src/crm.ts:2"), crm.stderr);
check("a session that touched nothing answers for nothing", (start("idle"), stop("idle").status === 0));

console.log("\nA shell command");
shell("erp", () => write("src/erp-report.ts", "// TODO: the monthly report\nexport const report = 1;\n"));   // soz-guard: ignore (test data)
const viaShell = stop("erp");
check("a file a shell command made is the session's", viaShell.status === 2 && viaShell.stderr.includes("src/erp-report.ts"), viaShell.stderr);
rmSync(join(repo, "src", "erp-report.ts"));
toolWrite("crm", "src/crm.ts", "export function lead() {\n  return 1;\n}\n");

console.log("\nA check that fails because of another session's work");
write(".soz-guard.json", JSON.stringify({ checks: [{ name: "build", run: `${JSON.stringify(process.execPath)} -e "process.exit(require('fs').readFileSync('src/crm.ts','utf8').includes('broken')?1:0)"` }] }, null, 2));
git("add", "-A"); git("commit", "-q", "-m", "a check");
start("erp2"); start("crm2");
toolWrite("crm2", "src/crm.ts", "export const lead = 'broken';\n");
toolWrite("erp2", "src/erp.ts", "export const stock = (n: number) => Math.max(1, n);\n");
const blamed = stop("erp2");
check("the check runs on the whole folder and fails", blamed.status === 2 && blamed.stderr.includes('Check "build"'), blamed.stderr);
check("... and ERP is told it may be another session's, not to edit their files", blamed.stderr.includes("Other sessions in this folder") && blamed.stderr.includes("src/crm.ts") && blamed.stderr.includes("do not edit them"), blamed.stderr);

console.log("\nIntegrity");
const noTrack = JSON.parse(JSON.stringify(settings)); delete noTrack.hooks.PostToolUse;
start("g");
toolWrite("g", ".claude/settings.json", JSON.stringify(noTrack, null, 2));
stop("g");
check("the tracking hook removed: a guard change a person accepts", last().criteria.some(c => c.file === ".claude/settings.json" && c.kind === "guard"));

rmSync(repo, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard multi-session tests passed"}`);
process.exit(failed ? 1 : 0);
