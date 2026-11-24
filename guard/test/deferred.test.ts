// deferred.test.ts — "Unfinished is allowed; unsaid is not": a line marked "soz-guard: ignore" stays as it is
// only with a reason, and what was left is told to the person by soz-guard itself, not left to the agent's
// final message. Sample lines below are unfinished work on purpose; each says so to soz-guard itself.

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

const repo = mkdtempSync(join(tmpdir(), "soz-guard-deferred-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                 { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const run = (args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd: repo, encoding: "utf8", input });
type V = { state: string; findings: { rule: string; line: number; message: string }[]; deferred?: { file: string; line: number; rule: string | null; reason: string }[] };
const verdict = () => JSON.parse(run(["check", "--json", "--no-checks"]).stdout) as V;
// the mark is assembled, so that this file's own lines carry no bare mark
const MARK = "soz-guard: " + "ignore";
const release = (tail: string) => `export function release(n: number) {\n  // TODO: release the reservation  ${tail}\n  return n;\n}\n`;   // soz-guard: ignore (test data)

git("init", "-q", "-b", "main");
write(".gitignore", ".soz-guard/\n");
write("src/stock.ts", "export const reserve = (n: number) => n;\n");
git("add", "-A"); git("commit", "-q", "-m", "base");

console.log("\nA mark without a reason excuses nothing");
write("src/release.ts", release(MARK));
let v = verdict();
check("a TODO with a bare mark: still reported, and the agent is told the mark needs its reason", v.state === "open"
      && v.findings.some(f => f.rule === "todo" && f.line === 2 && f.message.includes("needs its reason")), JSON.stringify(v.findings));
write("src/release.ts", release(`/* ${MARK} */`));
check("... a bare mark inside a comment's end (*/): likewise", verdict().findings.some(f => f.rule === "todo"));
write("src/release.ts", release(`${MARK} (x)`));
check("... a mark whose reason says nothing (x): likewise", verdict().findings.some(f => f.rule === "todo"));
write("src/release.ts", `// TODO: the mark only named in a sentence: "${MARK}" needs a reason\n`);   // soz-guard: ignore (test data)
check("... the mark only named, in quotes: a mention, not a mark (the TODO is reported)", verdict().findings.some(f => f.rule === "todo"));

console.log("\nA mark with a reason: left as it is, and recorded");
write("src/release.ts", release(`${MARK} the stock API has no release call yet`));
v = verdict();
check("not open", v.state !== "open" && v.findings.length === 0, JSON.stringify(v));
check("... recorded in the verdict: where, what it would have been, and why", v.deferred?.length === 1 && v.deferred[0].file === "src/release.ts"
      && v.deferred[0].line === 2 && v.deferred[0].rule === "todo" && v.deferred[0].reason === "the stock API has no release call yet", JSON.stringify(v.deferred));
const h = run(["hook"], JSON.stringify({ cwd: repo, session_id: `deferred-${Date.now()}`, hook_event_name: "Stop" }));
const msg = (() => { try { return (JSON.parse(h.stdout) as { systemMessage?: string }).systemMessage ?? ""; } catch { return ""; } })();
check("the hook lets the agent stop, and tells the person itself what was left and why", h.status === 0
      && msg.includes("src/release.ts:2") && msg.includes("the stock API has no release call yet"), h.stdout + h.stderr);
check("... in the log too", readFileSync(join(repo, ".soz-guard", "log.jsonl"), "utf8").includes("the stock API has no release call yet"));
const c = run(["check", "--no-checks"]);
check("soz-guard check shows it to a person in a terminal", c.stdout.includes("Left as it is, on the agent's word"), c.stdout);
git("add", "-A"); git("commit", "-q", "-m", "release, waiting for the API");
check("a mark already committed before the change is not told again", (verdict().deferred ?? []).length === 0);

rmSync(repo, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard deferred tests passed"}`);
process.exit(failed ? 1 : 0);
