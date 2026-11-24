#!/usr/bin/env node
// cli.ts — soz-guard: work is finished when the checks say so, not when the agent does.
//
//   soz-guard hook                     a Claude Code Stop hook (reads the hook's JSON on stdin)
//   soz-guard session-start            a Claude Code SessionStart hook: records where this session began
//   soz-guard check [--json]           the verdict on what changed since HEAD, checks run; exit 1 unless finished
//   soz-guard ci --base REF [--checks] [--criteria block|report] [--json]
//                                      the same verdict in CI, on a pull request against its base
//   soz-guard replay COMMIT|FROM..TO   past commits, judged as soz-guard would have (for a pilot)
//   soz-guard accept "<why>"           a person accepts changes to the tests or rules (in a terminal)
//   soz-guard log [--verify]           the chained log of verdicts and acceptances
//   soz-guard scan [--json] [--base REF]   only the static scan, as in 0.1
//   soz-guard pre-commit [--checks]    a git pre-commit hook: the verdict on what is being committed
//   soz-guard track                    PreToolUse/PostToolUse: the files this session touched (init --sessions)
//   soz-guard gate install|pre-receive|check|approve|log   on the server that holds the repository (gate.ts)
//   soz-guard init [DIR] [--claude] [--local] [--sessions] [--codex] [--git [--checks]]
//                                      installs the hooks (Claude Code by default), a .soz-guard.json and
//                                      soz-guard's section in CLAUDE.md / AGENTS.md

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { scan, report, repoRoot, loadConfig, configAt, CONFIG_FILE, OWN_DIR, gitIgnored as gitIgnoredPath, gitTracked, gitShow } from "./scan.ts";
import { evaluate, verdictReport, deferredReport, criteriaFingerprint, writeOwn, appendLog, verifyLog, ACCEPTED } from "./verdict.ts";
import { startSession, readBaseline, snapshotTree, readTouched, recordTouched, repoPath, beforeShell, afterShell } from "./session.ts";
import { MARK, machineCommand, isThisSozGuard } from "./guard.ts";
import { gate } from "./gate.ts";

const self = fileURLToPath(import.meta.url);
const here = dirname(self);

/** How to run this very file again from anywhere: this Node, by full path (a desktop app's PATH may
 * not have node), with type stripping only when running the TypeScript source rather than the
 * compiled package. */
const selfCommand = (sub: string) =>
  `"${process.execPath}" ${self.endsWith(".ts") ? "--experimental-strip-types --disable-warning=ExperimentalWarning " : ""}"${self}" ${sub}`;

const finished = (state: string) => state === "verified" || state === "unchecked";

type HookInput = {
  cwd?: string; session_id?: string; source?: string; hook_event_name?: string;
  tool_name?: string; tool_use_id?: string; tool_input?: { file_path?: string; notebook_path?: string };
};

const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const SHELL_TOOLS = ["Bash", "PowerShell"];
const TRACK_MATCHER = [...FILE_TOOLS, ...SHELL_TOOLS].join("|");

/** Whether the project's Claude Code settings run soz-guard's tracking hook (see session.ts). */
function trackingInstalled(root: string): boolean {
  for (const f of [".claude/settings.json", ".claude/settings.local.json"]) {
    try {
      const j = JSON.parse(readFileSync(join(root, f), "utf8")) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
      if ((j.hooks?.PostToolUse ?? []).some(m => m.hooks?.some(h => /soz-guard|cli\.(ts|js)"/.test(h.command ?? "") && (h.command ?? "").trimEnd().endsWith(" track"))))
        return true;
    } catch { /* not there, or not JSON */ }
  }
  return false;
}

/** Claude Code PreToolUse / PostToolUse hook: records the files this session touches, so that with several
 * sessions in one folder each answers for its own (session.ts). Never blocks a tool. */
function track(): number {
  const input = hookInput();
  const root = repoRoot(input.cwd ?? process.cwd());
  const sid = input.session_id;
  const baseline = root && sid ? readBaseline(root, sid) : null;
  if (!root || !sid || !baseline) return 0;                      // no baseline: the verdict is against HEAD anyway
  const tool = input.tool_name ?? "";
  const pre = input.hook_event_name === "PreToolUse";
  if (FILE_TOOLS.includes(tool)) {
    const p = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    const f = p ? repoPath(root, p) : null;
    if (f) recordTouched(root, sid, [f]);
  } else if (SHELL_TOOLS.includes(tool)) {
    const exclude = configAt(root, baseline.tree).config.exclude;
    const key = input.tool_use_id ?? "shell";
    if (pre) beforeShell(root, sid, key, exclude); else afterShell(root, sid, key, exclude);
  }
  return 0;
}
const hookInput = (): HookInput => { try { return JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return {}; } };

/** Claude Code SessionStart hook: records the working tree as it is, so that the verdict at the end is about
 * what this session changed, not about work that was uncommitted before it (see session.ts). */
function sessionStart(): number {
  const input = hookInput();
  const root = repoRoot(input.cwd ?? process.cwd());
  if (!root || !input.session_id) return 0;
  startSession(root, input.session_id, loadConfig(root).exclude, input.source ?? "startup");
  return 0;
}

/** Claude Code Stop hook. Exit 2 with a message on stderr makes Claude continue instead of stopping.
 * The agent may finish only when the verdict is verified or unchecked (see verdict.ts). With a baseline
 * from this session's start, only what changed since then is judged; without one, what changed since HEAD. */
function hook(): number {
  const input = hookInput();
  const dir = input.cwd ?? process.cwd();
  const root = repoRoot(dir);
  if (!root) return 0;                                            // not a git repository: nothing to compare
  const baseline = readBaseline(root, input.session_id);
  // what the snapshot leaves out is for the session's start to say, not for the change
  const range = baseline ? { base: baseline.tree, head: snapshotTree(root, configAt(root, baseline.tree).config.exclude) } : undefined;
  // with the tracking hooks installed, a session answers only for the files it touched (several sessions,
  // one folder); a session that touched nothing answers for nothing
  const only = baseline && input.session_id && trackingInstalled(root) ? (readTouched(root, input.session_id) ?? new Set<string>()) : undefined;
  const { verdict, config } = evaluate(dir, { range, only, guardBase: baseline?.guard, session: input.session_id, source: "hook" });
  // without a session id, one state per repository: two projects do not count each other's stops
  const key = input.session_id ? input.session_id.replace(/[^\w-]/g, "") : `default-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
  const stateFile = join(tmpdir(), `soz-guard-${key}.json`);
  let state: { blocks: number; told?: string } = { blocks: 0 };
  try { if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { state = { blocks: 0 }; }
  const log = (decision: string) => appendLog(root, { event: "hook", session: input.session_id ?? null, decision, state: verdict.state, change: verdict.change });
  if (finished(verdict.state)) {
    writeFileSync(stateFile, JSON.stringify({ blocks: 0 }));
    log(verdict.deferred.length ? `finished, ${verdict.deferred.length} line(s) left as they are on the agent's word` : "finished");
    // Codex expects JSON from a Stop hook that lets the agent stop; what the agent left is told to the person
    // here, by soz-guard, not left to the agent's final message
    process.stdout.write(verdict.deferred.length
      ? JSON.stringify({ systemMessage: `soz-guard: the agent may stop (${verdict.state}), but it left work as it is:\n${deferredReport(verdict)}` }) + "\n"
      : "{}\n");
    return 0;
  }
  // Open only because the tests or rules changed, which a person accepts and the agent cannot. Once told, the
  // agent may stop and hand them to the person, but only as it was told: if it changed anything since (went
  // on working, or changed the criteria further) it is stopped again, within maxBlocks like any other stop.
  const waitsForPerson = verdict.state === "open" && !verdict.findings.length && !verdict.checks.length
    && verdict.criteria.length > 0 && !verdict.criteriaAccepted;
  const told = waitsForPerson ? `${criteriaFingerprint(verdict.criteria)}:${verdict.change}` : undefined;
  if (told && state.told === told) {
    log("let the agent stop: the changes to the criteria it was told about wait for a person");
    process.stdout.write(JSON.stringify({
      systemMessage: `soz-guard: still waiting for you, not for the agent:\n${verdictReport(verdict, false)}\nAccept in a terminal with  soz-guard accept "<why>", or undo the change.`,
    }) + "\n");
    return 0;
  }
  state.blocks++;
  if (state.blocks <= config.maxBlocks) {
    state.told = told;
    writeFileSync(stateFile, JSON.stringify(state));
    log(`stopped the agent (${state.blocks} of ${config.maxBlocks})${told ? ": the criteria changed, a person decides" : ""}`);
    process.stderr.write(`soz-guard: you are about to finish, but the work is not finished yet.\n${verdictReport(verdict, true)}\n`
      + (told ? `If you stop now and change nothing else, you will not be stopped for these same changes again; say plainly\nin your final message that they wait for the user. ` : "")
      + `(check ${state.blocks} of ${config.maxBlocks})\n`);
    return 2;
  }
  // Stopped enough times: let the agent finish, but tell the person, plainly, that it is not finished.
  log("let the agent stop unfinished, after the last check");
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
    + `${args.includes("--no-checks") && verdict.state === "unchecked" ? ["Nothing open in what changed.", deferredReport(verdict)].filter(Boolean).join("\n") : verdictReport(verdict, false)}\n`);
  return finished(verdict.state) ? 0 : 1;
}

/** Files in the working tree that differ from the index (AGAINST omitted) or from a commit (AGAINST "HEAD"),
 * untracked ones included and soz-guard's own folder and the excluded paths left out: checks run on the working
 * tree, so with any of these they would not be running on what is being judged. */
function filesOutside(root: string, rules: string, against?: string): string[] {
  // the excluded paths are those of the rules the change is judged by (RULES, a commit), not of the folder
  const exclude = configAt(root, rules).config.exclude.filter(g => g !== CONFIG_FILE).map(g => `:(exclude,glob)${g}`);
  const changed = gitOut(root, ["-c", "core.quotepath=false", "diff", "--name-only", ...(against ? [against] : []), "--", ".", ...exclude]);
  const untracked = gitOut(root, ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "--", ".", ...exclude]);
  return [...changed.split("\n"), ...untracked.split("\n")].filter(f => f && !f.startsWith(`${OWN_DIR}/`));
}

/** A git pre-commit hook, for any agent and for people: the verdict on exactly what is being committed (the
 * index against HEAD). With --checks the required checks run too, but only when the working tree is what is
 * being committed: tests that pass on files left out of the commit prove nothing about the commit. */
function preCommit(args: string[]): number {
  const root = repoRoot(process.cwd());
  if (!root) return 0;
  let base = "HEAD";
  try { gitOut(root, ["rev-parse", "--verify", "--quiet", "HEAD"]); } catch { base = EMPTY_TREE; }
  const staged = gitOut(root, ["write-tree"]);           // the index as a tree: what this commit will hold
  let runChecks = args.includes("--checks");
  let note = "";
  if (runChecks) {
    const left = filesOutside(root, base);
    if (left.length) {
      runChecks = false;
      note = `The required checks were not run: ${left.length} file(s) differ from what is being committed (${left.slice(0, 5).join(", ")}${left.length > 5 ? ", ..." : ""}),\n`
        + `and checks that pass on files left out of the commit say nothing about it. Stage them, or set them aside\n`
        + `(git stash --keep-index --include-untracked), and commit again.`;
    }
  }
  const { verdict } = evaluate(root, { range: { base, head: staged }, checks: runChecks, source: "pre-commit" });
  const ok = finished(verdict.state) && !note;
  if (ok && !verdict.checks.length) return 0;
  process.stderr.write(`soz-guard (pre-commit): ${ok ? verdict.state : "this commit is not finished"}\n`
    + `${verdict.findings.length || verdict.criteria.length || verdict.checks.length ? verdictReport(verdict, true) + "\n" : ""}${note ? note + "\n" : ""}`);
  return ok ? 0 : 1;
}

/** The same decision in CI, on a pull request's change against its base. */
function ci(args: string[]): number {
  const root = repoRoot(process.cwd());
  if (!root) throw new Error("not in a git repository");
  const baseRef = flag(args, "--base") ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined);
  if (!baseRef) throw new Error("which base? soz-guard ci --base origin/main (on GitHub Actions, GITHUB_BASE_REF is used)");
  let base: string;
  try { base = gitOut(root, ["merge-base", baseRef, "HEAD"]); }
  catch {
    let shallow = false;
    try { shallow = gitOut(root, ["rev-parse", "--is-shallow-repository"]) === "true"; } catch { shallow = false; }
    let known = true;
    try { gitOut(root, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]); } catch { known = false; }
    throw new Error(!known ? `${baseRef} is not in this clone; fetch it first (git fetch origin ${baseRef.replace(/^origin\//, "")})`
      : shallow ? `this clone is shallow, so the branch and ${baseRef} have no common commit in it; fetch the history `
        + `(actions/checkout with fetch-depth: 0, or git fetch --unshallow)`
      : `the branch and ${baseRef} have no commit in common`);
  }
  const criteriaMode = flag(args, "--criteria");
  if (criteriaMode && criteriaMode !== "block" && criteriaMode !== "report") throw new Error("--criteria is block or report");
  // the change is the branch's commits, not whatever else lies in the folder: on a server where someone
  // checked the branch out among other files, those files are not the branch's
  const dirty = args.includes("--checks") ? filesOutside(root, base, "HEAD") : [];
  // "--criteria report": for a team that reviews changes to the tests in the pull request itself; the
  // checks run all the same
  const { verdict } = evaluate(root, { range: { base, head: "HEAD" }, checks: args.includes("--checks") && !dirty.length, reuse: false, record: false,
                                       ...(criteriaMode ? { criteriaChanges: criteriaMode as "block" | "report" } : {}) });
  // the checks were asked for and could not run on exactly the branch: no answer, so not finished
  if (dirty.length && finished(verdict.state)) verdict.state = "unverified";
  const note = dirty.length ? `\nThe required checks were not run: ${dirty.length} file(s) in the folder differ from the branch's last commit `
    + `(${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}),\nand checks run on the folder would not be checking the branch. `
    + `Run soz-guard ci in a clean checkout of the branch; files a build makes (outputs, reports) go in "exclude" in ${CONFIG_FILE}.\n` : "";
  if (args.includes("--json")) process.stdout.write(JSON.stringify(dirty.length ? { ...verdict, notRun: dirty } : verdict, null, 2) + "\n");
  else process.stdout.write(`soz-guard ci (against ${baseRef}): ${verdict.state}\n${verdictReport(verdict, false)}\n${note}`);
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

/** The log of verdicts and acceptances: the last ones, or (--verify) whether its chain is intact. */
function logCommand(args: string[]): number {
  const root = repoRoot(process.cwd());
  if (!root) throw new Error("not in a git repository");
  const v = verifyLog(root);
  if (args.includes("--verify")) {
    process.stdout.write(v.ok ? `The log is intact: ${v.lines} entries, each chained to the one before.\n`
                              : `The log is broken at entry ${v.brokenAt} of ${v.lines}: ${v.why}.\n`);
    return v.ok ? 0 : 1;
  }
  const path = join(root, OWN_DIR, "log.jsonl");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(l => l.trim()) : [];
  for (const l of lines.slice(-Number(flag(args, "--last") ?? 20))) {
    try {
      const e = JSON.parse(l) as { seq: number; at: string; event: string; state?: string; decision?: string; reason?: string; source?: string; findings?: unknown[]; criteria?: unknown[]; deferred?: unknown[]; checks?: { name: string; status: string }[] };
      const what = e.event === "verdict" ? `${e.state} (${e.source}): ${e.findings?.length ?? 0} unfinished, ${e.criteria?.length ?? 0} criteria${e.deferred?.length ? `, ${e.deferred.length} left on the agent's word` : ""}${e.checks?.length ? ", " + e.checks.map(c => `${c.name} ${c.status}`).join(", ") : ""}`
        : e.event === "hook" ? e.decision : e.event === "accept" ? `accepted: ${e.reason}` : e.event;
      process.stdout.write(`${String(e.seq).padStart(4)}  ${e.at}  ${e.event.padEnd(7)}  ${what}\n`);
    } catch { process.stdout.write(`      (unreadable line)\n`); }
  }
  if (!v.ok) process.stdout.write(`\nThe log is broken at entry ${v.brokenAt}: ${v.why}.\n`);
  return 0;
}

/** A person accepts the current changes to what counts as finished. Typed in a terminal, never piped:
 * an agent runs commands without one. (On one machine this slows an agent down rather than stops it;
 * CI is where the rule is enforced.) */
async function accept(args: string[]): Promise<number> {
  const reason = args.filter(a => !a.startsWith("--")).join(" ").trim();
  if (!reason) throw new Error('why? soz-guard accept "<why these changes to the tests or rules are right>"');
  const root = repoRoot(process.cwd());
  if (!root) throw new Error("not in a git repository");
  // an acceptance in git is never honoured (verdict.ts): saying "Accepted" here would be untrue
  if (gitTracked(root, ACCEPTED) || gitShow(root, "HEAD", ACCEPTED) !== null) {
    process.stderr.write(`${ACCEPTED} is in git, and an acceptance that travels with the change accepts nothing.\n`
      + `Take it out of git first (git rm --cached ${ACCEPTED}, and commit that), then accept again.\n`);
    return 1;
  }
  if (!process.stdin.isTTY) {
    process.stderr.write("soz-guard accept needs a terminal: a person types it, an agent cannot.\n");
    return 2;
  }
  // What is accepted is what the last verdict stopped on: the hook judges a session's change, which only
  // the hook's own record knows; recomputing here against HEAD could name other changes.
  const lastPath = join(root, OWN_DIR, "last.json");
  const last = existsSync(lastPath) ? JSON.parse(readFileSync(lastPath, "utf8")) as { criteria: { file: string; kind: string; detail: string; evidence: string }[]; at: string } : null;
  const criteria = last?.criteria ?? [];
  if (!criteria.length) { process.stdout.write("Nothing to accept: the last verdict found no change to what counts as finished.\n"); return 0; }
  process.stdout.write(`The last verdict (${last!.at}) stopped on these changes to what counts as finished:\n${criteria.map(c => `  ${c.file}  [${c.kind}] ${c.detail}`).join("\n")}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(res => rl.question("Accept them? Type the whole word yes: ", a => { rl.close(); res(a); }));
  if (answer.trim().toLowerCase() !== "yes") {
    process.stdout.write(`Not accepted: only the whole word "yes" accepts${answer.trim() ? ` (you typed "${answer.trim()}")` : ""}. Run it again to accept.\n`);
    return 1;
  }
  writeOwn(root, "accepted.json", { criteria: criteriaFingerprint(criteria as never), reason, at: new Date().toISOString() });
  appendLog(root, { event: "accept", reason, criteria: criteria.map(c => `${c.file} ${c.kind}`), fingerprint: criteriaFingerprint(criteria as never) });
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

/** The same command for a POSIX shell (git runs its hooks with sh, Git for Windows too): forward slashes. */
const shellCommand = (sub: string) => selfCommand(sub).replace(/\\/g, "/");

/** A git pre-commit hook that runs soz-guard. Never overwrites a hook that is not soz-guard's own. */
function installGitHook(root: string, checks: boolean): string {
  const hooksDir = gitOut(root, ["rev-parse", "--git-path", "hooks"]);
  const dir = isAbsolute(hooksDir) ? hooksDir : join(root, hooksDir);
  const path = join(dir, "pre-commit");
  const line = `${shellCommand(`pre-commit${checks ? " --checks" : ""}`)} || exit 1`;
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    if (text.includes("soz-guard") || text.includes(self.replace(/\\/g, "/"))) return "git pre-commit hook: already there";
    return `git pre-commit hook: there is one already, left as it is; to add soz-guard, put this line in ${path}:\n      ${line}`;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `#!/bin/sh\n# soz-guard: judges what is being committed\n${line}\n`, { mode: 0o755 });
  return `git pre-commit hook added${checks ? ", with the required checks" : " (static rules and criteria; add --checks to run the checks too)"}\n`
    + `      soz-guard's own setup changes the criteria: commit it yourself with  git commit --no-verify`;
}

type HookList = { matcher?: string; hooks: { type: string; command: string }[] }[];

/** Puts soz-guard's SUB hook in LIST with this machine's command: adds it, or updates one of soz-guard's that
 * runs it from somewhere else (another machine, or Node or soz-guard moved since). OURS tells soz-guard's
 * own command for SUB from the others, which are never touched. */
function upsertHook(list: HookList, sub: string, ours: (command: string) => boolean, matcher?: string): "added" | "updated" | "there" {
  const command = selfCommand(sub);
  for (const m of list) for (const h of m.hooks ?? []) {
    if (!ours(h.command ?? "")) continue;
    // a command written by hand that finds soz-guard itself (npx soz-guard hook, soz-guard hook) works on any
    // machine: it is left as it is. Only init's own commands, with one machine's paths, are brought up to date.
    if (h.command === command || !machineCommand(h.command)) return "there";
    h.command = command;
    return "updated";
  }
  list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
  return "added";
}
/** The hook commands in the project's shared .claude/settings.json. */
function sharedHooks(root: string): string[] {
  try {
    const shared = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")) as { hooks?: Record<string, HookList> };
    return Object.values(shared.hooks ?? {}).flat().flatMap(m => (m.hooks ?? []).map(h => h.command ?? ""));
  } catch { return []; }                                         // no shared settings, or not JSON: none
}
const ourCommand = (sub: string) => (c: string) =>
  (c.includes(self) || /soz-guard/.test(c) || /cli\.(ts|js)"/.test(c)) && c.trimEnd().endsWith(` ${sub}`);
const upsertNote = (r: "added" | "updated" | "there", what: string, where: string) =>
  r === "there" ? `${where}: the ${what} is already there` : r === "added" ? `${where}: ${what} added` : `${where}: ${what} updated to this machine's Node and soz-guard`;

/** Codex: SessionStart and Stop hooks in the project's .codex/hooks.json, the same commands as for Claude
 * Code (Codex sends the same fields and reads exit code 2 with stderr as "continue"). */
function installCodexHooks(root: string): string {
  const path = join(root, ".codex", "hooks.json");
  const j: { hooks?: Record<string, HookList> } = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  j.hooks ??= {};
  const notes: string[] = [];
  for (const [event, sub] of [["SessionStart", "session-start"], ["Stop", "hook"]] as const) {
    const r = upsertHook(j.hooks[event] ??= [], sub, ourCommand(sub));
    if (r !== "there") notes.push(upsertNote(r, `${event} hook`, ".codex/hooks.json"));
  }
  if (!notes.length) return ".codex/hooks.json: the hooks are already there";
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
  return `${notes.join("\n  ")} (Codex asks you to trust them once, in /hooks)`;
}

/** soz-guard's section in an instructions file (CLAUDE.md for Claude Code, AGENTS.md for Codex and others). */
function addSection(root: string, name: string): string {
  const path = join(root, name);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.includes(MARK)) return `${name}: the soz-guard section is already there`;
  const section = readFileSync(join(here, "..", "templates", "CLAUDE.md"), "utf8");
  writeFileSync(path, (current ? current.replace(/\s*$/, "\n\n") : "") + section);
  return current ? `${name}: soz-guard section appended` : `${name}: created`;
}

function init(dir: string, args: string[] = []): number {
  const codex = args.includes("--codex"), gitHook = args.includes("--git");
  const claude = args.includes("--claude") || args.includes("--sessions") || (!codex && !gitHook);
  const root = repoRoot(dir);
  if (!root) {
    process.stderr.write(`${dir} is not a git repository.\n`
      + `soz-guard is set up per project and looks at what changed, so run init inside your project's folder:\n`
      + `  cd path/to/your/project\n  ${selfCommand("init")}\n`
      + `(A project that is not under git yet: git init there first.)\n`);
    return 1;
  }
  const done: string[] = [];

  if (claude) {
  // --local: the hooks go to settings.local.json, which stays on this machine. In a team each person runs
  // init --local on their own machine, and no machine's paths are committed for the others.
  const local = args.includes("--local");
  const settingsName = local ? ".claude/settings.local.json" : ".claude/settings.json";
  const settingsPath = join(root, settingsName);
  let settings: { hooks?: Record<string, HookList> } = {};
  if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf8"));   // a broken file stops here, untouched
  settings.hooks ??= {};
  let changed = false;
  // SessionStart records where the session began; Stop judges what changed since then
  // with --local, a hook the shared settings.json already runs on this machine is not added again: Claude Code
  // would run both, and the two would count the same stops
  const shared = local ? sharedHooks(root) : [];
  const runsHere = (sub: string) => shared.some(c => ourCommand(sub)(c) && (!machineCommand(c) || isThisSozGuard(machineCommand(c)!.script)));
  for (const [event, sub] of [["SessionStart", "session-start"], ["Stop", "hook"]] as const) {
    if (runsHere(sub)) { done.push(`${settingsName}: the ${event} hook is left out, .claude/settings.json already runs it on this machine`); continue; }
    const r = upsertHook(settings.hooks[event] ??= [], sub, ourCommand(sub));
    changed ||= r !== "there";
    done.push(upsertNote(r, `${event} hook`, settingsName));
  }
  // several sessions in one folder: each answers for the files it touched (opt-in: a shell command costs two
  // snapshots, and a change made some way the hooks do not see is then nobody's)
  if (args.includes("--sessions")) {
    for (const event of ["PreToolUse", "PostToolUse"] as const) {
      if (runsHere("track")) { done.push(`${settingsName}: the ${event} tracking hook is left out, .claude/settings.json already runs it on this machine`); continue; }
      const r = upsertHook(settings.hooks[event] ??= [], "track", ourCommand("track"), event === "PreToolUse" ? SHELL_TOOLS.join("|") : TRACK_MATCHER);
      changed ||= r !== "there";
      done.push(upsertNote(r, `${event} tracking hook`, settingsName) + (r === "added" ? " (each session answers for the files it touched)" : ""));
    }
  }
  if (changed) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  if (local) {
    const ignorePath = join(root, ".gitignore");
    const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
    if (!gitIgnoredPath(root, settingsName) && !ignore.split(/\r?\n/).some(l => l.trim() === settingsName)) {
      writeFileSync(ignorePath, (ignore ? ignore.replace(/\s*$/, "\n") : "") + `${settingsName}\n`);
      done.push(`.gitignore: ${settingsName} added (it holds this machine's paths)`);
    }
    // .gitignore does not take a file out of git that is already in it
    if (gitTracked(root, settingsName))
      done.push(`${settingsName} is in git already, so .gitignore does not keep it out: take it out once with\n`
        + `      git rm --cached ${settingsName}   (the file stays on this machine) and commit that`);
    const stale = ["session-start", "hook", "track"].some(sub => shared.some(c => ourCommand(sub)(c) && machineCommand(c) && !isThisSozGuard(machineCommand(c)!.script)));
    if (stale)
      done.push(`.claude/settings.json also runs soz-guard, with the paths of the machine that committed it; on other machines\n`
        + `      that one fails. The repository's owner removes it from there, once everyone has run init --local.`);
  }
  }
  if (codex) done.push(installCodexHooks(root));
  if (gitHook) done.push(installGitHook(root, args.includes("--checks")));

  const configPath = join(root, CONFIG_FILE);
  if (existsSync(configPath)) done.push(`${CONFIG_FILE}: already there`);
  else {
    const checks = suggestedChecks(root);
    writeFileSync(configPath, JSON.stringify({ checks, criteria: [], runners: [], criteriaChanges: "block", assertions: "fewer", disable: [], exclude: [], maxBlocks: 3, rules: [] }, null, 2) + "\n");
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

  if (claude) done.push(addSection(root, "CLAUDE.md"));
  if (codex || gitHook) done.push(addSection(root, "AGENTS.md"));
  process.stdout.write(`soz-guard set up in ${root}\n${done.map(d => "  " + d).join("\n")}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "hook") return hook();
  if (cmd === "session-start") return sessionStart();
  if (cmd === "init") return init(rest.find(a => !a.startsWith("--")) ?? process.cwd(), rest);
  if (cmd === "pre-commit") return preCommit(rest);
  if (cmd === "track") return track();
  if (cmd === "check") return check(rest);
  if (cmd === "ci") return ci(rest);
  if (cmd === "replay") return replay(rest);
  if (cmd === "accept") return accept(rest);
  if (cmd === "log") return logCommand(rest);
  if (cmd === "gate") return gate(rest);
  if (cmd === "scan" || cmd === undefined) {
    const json = rest.includes("--json");
    const { root, findings } = scan(process.cwd(), flag(rest, "--base") ?? "HEAD");
    if (json) process.stdout.write(JSON.stringify({ root, findings }, null, 2) + "\n");
    else process.stdout.write(findings.length ? `Unfinished work in what changed:\n${report(findings)}\n` : "Nothing unfinished in what changed.\n");
    return findings.length ? 1 : 0;
  }
  process.stderr.write('usage: soz-guard hook | check [--json] | ci --base REF [--checks] [--criteria block|report] | replay COMMIT|FROM..TO | accept "<why>" | pre-commit [--checks] | scan [--json] | init [DIR] [--claude] [--local] [--sessions] [--codex] [--git [--checks]]\n');
  return 2;
}

main(process.argv.slice(2)).then(code => process.exit(code), (e: Error) => {
  // Never a silent failure, and never one that traps the agent: report it and exit 1 (a hook error
  // Claude Code shows to the person without blocking).
  process.stderr.write(`soz-guard: ${e.message}\n`);
  process.exit(1);
});
