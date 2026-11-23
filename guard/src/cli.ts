#!/usr/bin/env node
// cli.ts — soz-guard: work is finished when the checks say so, not when the agent does.
//
//   soz-guard hook                     a Claude Code Stop hook (reads the hook's JSON on stdin)
//   soz-guard check [--json]           the verdict on what changed since HEAD, checks run; exit 1 unless finished
//   soz-guard ci --base REF [--checks] [--criteria block|report] [--json]
//                                      the same verdict in CI, on a pull request against its base
//   soz-guard replay COMMIT|FROM..TO   past commits, judged as soz-guard would have (for a pilot)
//   soz-guard accept "<why>"           a person accepts changes to the tests or rules (in a terminal)
//   soz-guard scan [--json] [--base REF]   only the static scan, as in 0.1
//   soz-guard init [DIR]               installs the hook, a .soz-guard.json and a CLAUDE.md section

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { scan, report, repoRoot, CONFIG_FILE, OWN_DIR } from "./scan.ts";
import { evaluate, verdictReport, criteriaFingerprint, writeOwn } from "./verdict.ts";

const self = fileURLToPath(import.meta.url);
const here = dirname(self);
const MARK = "<!-- soz-guard -->";

/** How to run this very file again from anywhere: this Node, by full path (a desktop app's PATH may
 * not have node), with type stripping only when running the TypeScript source rather than the
 * compiled package. */
const selfCommand = (sub: string) =>
  `"${process.execPath}" ${self.endsWith(".ts") ? "--experimental-strip-types --disable-warning=ExperimentalWarning " : ""}"${self}" ${sub}`;
const isOurHook = (command: string | undefined) =>
  !!command && (command.includes(self) || /soz-guard/.test(command) || /cli\.(ts|js)" hook$/.test(command));

const finished = (state: string) => state === "verified" || state === "unchecked";

/** Claude Code Stop hook. Exit 2 with a message on stderr makes Claude continue instead of stopping.
 * The agent may finish only when the verdict is verified or unchecked (see verdict.ts). */
function hook(): number {
  let input: { cwd?: string; session_id?: string } = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no input: use the current folder */ }
  const dir = input.cwd ?? process.cwd();
  if (!repoRoot(dir)) return 0;                                   // not a git repository: nothing to compare
  const { verdict, config } = evaluate(dir);
  const stateFile = join(tmpdir(), `soz-guard-${(input.session_id ?? "default").replace(/[^\w-]/g, "")}.json`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) as { blocks: number } : { blocks: 0 };
  if (finished(verdict.state)) { writeFileSync(stateFile, JSON.stringify({ blocks: 0 })); return 0; }
  state.blocks++;
  writeFileSync(stateFile, JSON.stringify(state));
  if (state.blocks <= config.maxBlocks) {
    process.stderr.write(`soz-guard: you are about to finish, but the work is not finished yet.\n${verdictReport(verdict, true)}\n(check ${state.blocks} of ${config.maxBlocks})\n`);
    return 2;
  }
  // Stopped enough times: let the agent finish, but tell the person, plainly, that it is not finished.
  writeFileSync(stateFile, JSON.stringify({ blocks: 0 }));
  process.stdout.write(JSON.stringify({
    systemMessage: `soz-guard: the agent stopped after ${config.maxBlocks} checks, but the work is ${verdict.state}, not finished:\n${verdictReport(verdict, false)}`,
  }) + "\n");
  return 0;
}

const gitOut = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The verdict here and now: what changed since HEAD (or --base), checks run. Exit 0 only when finished. */
function check(args: string[]): number {
  const { verdict } = evaluate(process.cwd(), { range: { base: flag(args, "--base") ?? "HEAD" }, checks: !args.includes("--no-checks") });
  if (args.includes("--json")) process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
  else process.stdout.write(`soz-guard: ${verdict.state}${args.includes("--no-checks") ? " (checks not run: --no-checks)" : ""}\n`
    + `${args.includes("--no-checks") && verdict.state === "unchecked" ? "Nothing open in what changed." : verdictReport(verdict, false)}\n`);
  return finished(verdict.state) ? 0 : 1;
}

/** The same decision in CI, on a pull request's change against its base. */
function ci(args: string[]): number {
  const root = repoRoot(process.cwd());
  if (!root) throw new Error("not in a git repository");
  const baseRef = flag(args, "--base") ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined);
  if (!baseRef) throw new Error("which base? soz-guard ci --base origin/main (on GitHub Actions, GITHUB_BASE_REF is used)");
  const base = gitOut(root, ["merge-base", baseRef, "HEAD"]);
  const criteriaMode = flag(args, "--criteria");
  if (criteriaMode && criteriaMode !== "block" && criteriaMode !== "report") throw new Error("--criteria is block or report");
  const { verdict } = evaluate(root, { range: { base }, checks: args.includes("--checks"), reuse: false, record: false });
  // "--criteria report": for a team that reviews changes to the tests in the pull request itself
  if (criteriaMode === "report" && verdict.state === "open" && !verdict.findings.length && !verdict.checks.some(c => c.status === "failed"))
    verdict.state = verdict.checks.length ? "verified" : "unchecked";
  if (args.includes("--json")) process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
  else process.stdout.write(`soz-guard ci (against ${baseRef}): ${verdict.state}\n${verdictReport(verdict, false)}\n`);
  return finished(verdict.state) ? 0 : 1;
}

/** Past commits, judged as soz-guard would have: for a pilot, how much it catches, and how often it would
 * have stopped a change that was fine. Static rules and criteria only; checks are not run on the past. */
function replay(args: string[]): number {
  const root = repoRoot(process.cwd());
  if (!root) throw new Error("not in a git repository");
  const spec = args.find(a => !a.startsWith("--"));
  if (!spec) throw new Error("usage: soz-guard replay COMMIT | FROM..TO [--json]");
  const commits = spec.includes("..") ? gitOut(root, ["rev-list", "--reverse", spec]).split("\n").filter(Boolean) : [gitOut(root, ["rev-parse", spec])];
  const rows = commits.map(c => {
    let parent: string;
    try { parent = gitOut(root, ["rev-parse", "--verify", "--quiet", `${c}^`]); } catch { parent = EMPTY_TREE; }
    const { verdict } = evaluate(root, { range: { base: parent, head: c }, checks: false, record: false });
    return { commit: c.slice(0, 10), subject: gitOut(root, ["log", "-1", "--format=%s", c]), state: verdict.state,
             unfinished: verdict.findings.length, criteria: verdict.criteria.length, findings: verdict.findings, criteriaChanges: verdict.criteria };
  });
  if (args.includes("--json")) { process.stdout.write(JSON.stringify(rows, null, 2) + "\n"); return 0; }
  for (const r of rows)
    process.stdout.write(`${r.commit}  ${r.state.padEnd(9)}  ${String(r.unfinished).padStart(3)} unfinished  ${String(r.criteria).padStart(2)} criteria  ${r.subject.slice(0, 60)}\n`);
  const stopped = rows.filter(r => r.state === "open").length;
  process.stdout.write(`\n${rows.length} commit(s); soz-guard would have stopped ${stopped}. For each: a real gap it caught, or a change it stopped for nothing?\n`);
  return 0;
}

/** A person accepts the current changes to what counts as finished. Typed in a terminal, never piped:
 * an agent runs commands without one. (On one machine this slows an agent down rather than stops it;
 * CI is where the rule is enforced.) */
async function accept(args: string[]): Promise<number> {
  const reason = args.filter(a => !a.startsWith("--")).join(" ").trim();
  if (!reason) throw new Error('why? soz-guard accept "<why these changes to the tests or rules are right>"');
  if (!process.stdin.isTTY) {
    process.stderr.write("soz-guard accept needs a terminal: a person types it, an agent cannot.\n");
    return 2;
  }
  const { root, verdict } = evaluate(process.cwd(), { checks: false, record: false });
  if (!verdict.criteria.length) { process.stdout.write("Nothing to accept: the change does not touch what counts as finished.\n"); return 0; }
  process.stdout.write(`These changes touch what counts as finished:\n${verdict.criteria.map(c => `  ${c.file}  [${c.kind}] ${c.detail}`).join("\n")}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(res => rl.question("Accept them? Type yes: ", a => { rl.close(); res(a); }));
  if (answer.trim().toLowerCase() !== "yes") { process.stdout.write("Not accepted.\n"); return 1; }
  writeOwn(root, "accepted.json", { criteria: criteriaFingerprint(verdict.criteria), reason, at: new Date().toISOString() });
  process.stdout.write("Accepted, for exactly these changes; any further change to the tests or rules needs accepting again.\n");
  return 0;
}

/** The checks a project most likely wants: its own test script, if package.json has one. */
function suggestedChecks(root: string): { name: string; run: string; timeoutSeconds: number }[] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const t = pkg.scripts?.test;
    if (t && !/no test specified/.test(t)) return [{ name: "tests", run: "npm test", timeoutSeconds: 600 }];
  } catch { /* no package.json, or not JSON: no suggestion */ }
  return [];
}

function init(dir: string): number {
  const root = repoRoot(dir);
  if (!root) {
    process.stderr.write(`${dir} is not a git repository.\n`
      + `soz-guard is set up per project and looks at what changed, so run init inside your project's folder:\n`
      + `  cd path/to/your/project\n  ${selfCommand("init")}\n`
      + `(A project that is not under git yet: git init there first.)\n`);
    return 1;
  }
  const done: string[] = [];

  const settingsPath = join(root, ".claude", "settings.json");
  let settings: { hooks?: { Stop?: { hooks: { type: string; command: string }[] }[] } } = {};
  if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf8"));   // a broken file stops here, untouched
  const command = selfCommand("hook");
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  if (settings.hooks.Stop.some(m => m.hooks?.some(h => isOurHook(h.command))))
    done.push(".claude/settings.json: the Stop hook is already there");
  else {
    settings.hooks.Stop.push({ hooks: [{ type: "command", command }] });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    done.push(".claude/settings.json: Stop hook added");
  }

  const configPath = join(root, CONFIG_FILE);
  if (existsSync(configPath)) done.push(`${CONFIG_FILE}: already there`);
  else {
    const checks = suggestedChecks(root);
    writeFileSync(configPath, JSON.stringify({ checks, criteria: [], criteriaChanges: "block", assertions: "fewer", disable: [], exclude: [], maxBlocks: 3, rules: [] }, null, 2) + "\n");
    done.push(`${CONFIG_FILE}: created` + (checks.length ? ` with the check "${checks[0].run}": work is finished only when it passes`
      : `; add the checks that must pass ("checks": [{"name": "tests", "run": "..."}])`));
  }

  const ignorePath = join(root, ".gitignore");
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  if (ignore.split(/\r?\n/).some(l => l.trim() === `${OWN_DIR}/` || l.trim() === OWN_DIR)) done.push(`.gitignore: ${OWN_DIR}/ is already there`);
  else {
    writeFileSync(ignorePath, (ignore ? ignore.replace(/\s*$/, "\n") : "") + `${OWN_DIR}/\n`);
    done.push(`.gitignore: ${OWN_DIR}/ added (verdicts and caches stay local)`);
  }

  const claudeMd = join(root, "CLAUDE.md");
  const current = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
  if (current.includes(MARK)) done.push("CLAUDE.md: the soz-guard section is already there");
  else {
    const section = readFileSync(join(here, "..", "templates", "CLAUDE.md"), "utf8");
    writeFileSync(claudeMd, (current ? current.replace(/\s*$/, "\n\n") : "") + section);
    done.push(current ? "CLAUDE.md: soz-guard section appended" : "CLAUDE.md: created");
  }
  process.stdout.write(`soz-guard set up in ${root}\n${done.map(d => "  " + d).join("\n")}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "hook") return hook();
  if (cmd === "init") return init(rest[0] ?? process.cwd());
  if (cmd === "check") return check(rest);
  if (cmd === "ci") return ci(rest);
  if (cmd === "replay") return replay(rest);
  if (cmd === "accept") return accept(rest);
  if (cmd === "scan" || cmd === undefined) {
    const json = rest.includes("--json");
    const { root, findings } = scan(process.cwd(), flag(rest, "--base") ?? "HEAD");
    if (json) process.stdout.write(JSON.stringify({ root, findings }, null, 2) + "\n");
    else process.stdout.write(findings.length ? `Unfinished work in what changed:\n${report(findings)}\n` : "Nothing unfinished in what changed.\n");
    return findings.length ? 1 : 0;
  }
  process.stderr.write('usage: soz-guard hook | check [--json] | ci --base REF [--checks] [--criteria block|report] | replay COMMIT|FROM..TO | accept "<why>" | scan [--json] | init [DIR]\n');
  return 2;
}

main(process.argv.slice(2)).then(code => process.exit(code), (e: Error) => {
  // Never a silent failure, and never one that traps the agent: report it and exit 1 (a hook error
  // Claude Code shows to the person without blocking).
  process.stderr.write(`soz-guard: ${e.message}\n`);
  process.exit(1);
});
