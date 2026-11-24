// gate.ts — soz-guard on the server that holds the git repository: a push to a protected branch (the one
// that goes live) is let in only when soz-guard says the work is finished, checks run. Whatever the agents
// did on their own machines, this is where the rule holds, as long as the gate runs as a user the
// developers (and their agents) cannot write as.
//
//   soz-guard gate install [--branches main,production] [--setup "npm ci"] [--timeout SECONDS]
//                                   in the repository on the server: the pre-receive hook and the gate's config
//   soz-guard gate pre-receive      the hook itself (git gives it the pushed refs on stdin)
//   soz-guard gate check REV [--base REF]   the same verdict on any commit, by hand (an integrator's review)
//   soz-guard gate approve REV "<why>"      a person accepts the changes to the tests or rules in REV
//   soz-guard gate log [--last N] [--verify]   every verdict the gate gave, chained
//
// Each verdict is worked out in a fresh folder of its own: the pushed commit checked out, the setup command
// run (installing dependencies), then soz-guard ci on it, so the checks run on exactly what was pushed.

import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { OWN_DIR } from "./scan.ts";
import { type Verdict, verdictReport, criteriaFingerprint, appendLog, verifyLog } from "./verdict.ts";

const self = fileURLToPath(import.meta.url);
const cli = join(dirname(self), `cli${self.endsWith(".ts") ? ".ts" : ".js"}`);
const nodeArgs = self.endsWith(".ts") ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] : [];
const ZERO = /^0+$/;

type GateConfig = { branches: string[]; setup: string; timeoutSeconds: number };
type Approval = { commit: string; criteria: string; reason: string; by: string; at: string };
type Report = { commit: string; base: string; ref: string; state: string; verdict: Verdict | null; setup?: { ok: boolean; tail: string };
                error?: string; approved: string | null; at: string };

/** Git's own variables (a hook gets GIT_DIR, the quarantine's object folders...) left out: the gate's own git
 * runs on its own folder. */
type Env = Record<string, string | undefined>;
const cleanEnv = (): Env =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") || k === "GIT_EXEC_PATH" || k.startsWith("GIT_SSH")));

const git = (cwd: string, args: string[], env?: Env) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env }).trim();

/** The repository's git folder (a bare repository is its own), absolute. */
function gitDirOf(dir: string): string {
  return git(dir, ["rev-parse", "--absolute-git-dir"]);
}

const gateDir = (gitDir: string) => join(gitDir, OWN_DIR, "gate");
const configPath = (gitDir: string) => join(gateDir(gitDir), "config.json");

function readConfig(gitDir: string): GateConfig {
  const p = configPath(gitDir);
  if (!existsSync(p)) return { branches: ["main"], setup: "", timeoutSeconds: 900 };
  const j = JSON.parse(readFileSync(p, "utf8")) as Partial<GateConfig>;
  return { branches: j.branches ?? ["main"], setup: j.setup ?? "", timeoutSeconds: j.timeoutSeconds ?? 900 };
}

const approvalPath = (gitDir: string, commit: string) => join(gateDir(gitDir), "approved", `${commit}.json`);
const reportPath = (gitDir: string, commit: string) => join(gateDir(gitDir), "reports", `${commit}.json`);

function readJson<T>(p: string): T | null {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as T : null; } catch { return null; }
}

/** The verdict on HEAD against BASE (commits in the repository at GIT_DIR), worked out in a folder of its own. */
export function judge(gitDir: string, base: string, head: string, ref: string, config: GateConfig): Report {
  const at = new Date().toISOString();
  const work = mkdtempSync(join(tmpdir(), "soz-gate-"));
  const env = cleanEnv();
  const approval = readJson<Approval>(approvalPath(gitDir, head));
  try {
    // a repository of its own that reads the server's objects (and, in a pre-receive hook, the pushed ones,
    // which git keeps in quarantine until the hook lets them in)
    git(work, ["init", "-q"], env);
    const objects = [join(gitDir, "objects"), ...(process.env.GIT_QUARANTINE_PATH ? [process.env.GIT_QUARANTINE_PATH] : [])];
    writeFileSync(join(work, ".git", "objects", "info", "alternates"), objects.map(o => o.replace(/\\/g, "/")).join("\n") + "\n");
    git(work, ["update-ref", "refs/remotes/gate/base", base], env);
    git(work, ["update-ref", "refs/heads/gate", head], env);
    git(work, ["-c", "advice.detachedHead=false", "checkout", "-q", "gate"], env);
    let setup: Report["setup"];
    if (config.setup.trim()) {
      const r = spawnSync(config.setup, { cwd: work, shell: true, encoding: "utf8", env, timeout: config.timeoutSeconds * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
      const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\r/g, "").split("\n").slice(-20).join("\n").trim();
      setup = { ok: r.status === 0 && !r.error, tail: r.error ? r.error.message : tail };
      if (!setup.ok) return { commit: head, base, ref, state: "unverified", verdict: null, setup, approved: null, at };
    }
    const r = spawnSync(process.execPath, [...nodeArgs, cli, "ci", "--base", "refs/remotes/gate/base", "--checks", "--json",
                                            ...(approval ? ["--criteria", "report"] : [])],
                        { cwd: work, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    let verdict: Verdict & { notRun?: string[] };
    try { verdict = JSON.parse(r.stdout); }
    catch { return { commit: head, base, ref, state: "unverified", verdict: null, setup, error: (r.stderr || r.stdout || "soz-guard ci gave no answer").trim(), approved: null, at }; }
    let state = verdict.state;
    let approved: string | null = null;
    if (approval) {
      // an approval is for exactly the changes the person saw; anything else in the criteria is not approved
      if (approval.criteria === criteriaFingerprint(verdict.criteria)) approved = approval.reason;
      else if (verdict.criteria.length) state = "open";
    }
    return { commit: head, base, ref, state, verdict, setup, approved, at };
  } catch (e) {
    return { commit: head, base, ref, state: "unverified", verdict: null, error: (e as Error).message, approved: null, at };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const passed = (state: string) => state === "verified" || state === "unchecked";

/** Keeps the report (the last one per commit) and appends the verdict to the gate's chained log. */
function record(gitDir: string, report: Report, source: string) {
  mkdirSync(dirname(reportPath(gitDir, report.commit)), { recursive: true });
  writeFileSync(reportPath(gitDir, report.commit), JSON.stringify(report, null, 2) + "\n");
  const v = report.verdict;
  appendLog(gitDir, {
    event: "gate", source, ref: report.ref, base: report.base, commit: report.commit, state: report.state,
    by: process.env.GL_USERNAME || process.env.GITEA_PUSHER_NAME || userInfo().username,
    findings: v ? v.findings.map(f => `${f.file}:${f.line} ${f.rule}`) : [], criteria: v ? v.criteria.map(c => `${c.file} ${c.kind}`) : [],
    checks: v ? v.checks.map(c => ({ name: c.name, status: c.status, seconds: c.seconds })) : [], approved: report.approved,
    ...(report.error ? { error: report.error.slice(0, 500) } : {}), ...(report.setup && !report.setup.ok ? { setup: "failed" } : {}),
  });
}

/** The report in words, for the person who pushed (git shows it to them as "remote: ..."). */
function reportText(r: Report, gitDir: string): string {
  const head = `soz-guard gate: ${r.ref} ${r.commit.slice(0, 10)}: ${passed(r.state) ? `${r.state}, let in` : `${r.state}, not let in`}`;
  if (r.setup && !r.setup.ok) return `${head}\nThe setup command failed, so the checks could not run:\n${r.setup.tail.split("\n").map(l => "    " + l).join("\n")}`;
  if (!r.verdict) return `${head}\n${r.error ?? ""}`;
  const v = r.verdict as Verdict & { notRun?: string[] };
  const lines = [head, verdictReport(v, false)];
  if (v.notRun?.length) lines.push(`Files the setup left behind kept the checks from running: ${v.notRun.slice(0, 5).join(", ")}. Add them to "exclude" in .soz-guard.json.`);
  if (r.approved) lines.push(`The changes to the tests or rules were approved by a person: ${r.approved}`);
  else if (!passed(r.state) && v.criteria.length && !v.findings.length && !v.checks.some(c => c.status === "failed"))
    lines.push(`If these changes to the tests or rules are right, a person approves them on the server, in a terminal:\n`
      + `    cd ${gitDir.replace(/\\/g, "/")} && soz-guard gate approve ${r.commit.slice(0, 12)} "<why>"\nand pushes again.`);
  return lines.join("\n");
}

/** The pre-receive hook: every pushed ref, one line "old new ref" each. A protected branch moves only to a
 * finished commit; other refs are not judged here. */
export function preReceive(): number {
  const gitDir = gitDirOf(process.cwd());
  const config = readConfig(gitDir);
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch { input = ""; }     // no refs given: nothing to judge
  let rejected = false;
  for (const line of input.split("\n").map(l => l.trim()).filter(Boolean)) {
    const [oldRev, newRev, ref] = line.split(/\s+/);
    const branch = ref.replace(/^refs\/heads\//, "");
    if (!ref.startsWith("refs/heads/") || !config.branches.includes(branch)) continue;
    if (ZERO.test(newRev)) {
      process.stderr.write(`soz-guard gate: ${branch} is protected and cannot be deleted by a push.\n`);
      rejected = true;
      continue;
    }
    // what goes live is judged against what is live now; a new protected branch against the default branch
    let base = ZERO.test(oldRev) ? "" : oldRev;
    if (!base) { try { base = git(gitDir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]); } catch { base = ""; } }
    if (!base || base === newRev) {
      process.stderr.write(`soz-guard gate: ${branch} ${newRev.slice(0, 10)}: nothing to compare it with (the first push); let in.\n`);
      appendLog(gitDir, { event: "gate", source: "pre-receive", ref, base: null, commit: newRev, state: "unchecked", approved: null, note: "first push, nothing to compare" });
      continue;
    }
    const report = judge(gitDir, base, newRev, ref, config);
    record(gitDir, report, "pre-receive");
    process.stderr.write(reportText(report, gitDir) + "\n");
    if (!passed(report.state)) rejected = true;
  }
  return rejected ? 1 : 0;
}

/** By hand: the verdict on REV (a branch an integrator reviews, say) against --base (the default branch). */
function checkCommand(args: string[]): number {
  const gitDir = gitDirOf(process.cwd());
  const rev = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--base");
  if (!rev) throw new Error("usage: soz-guard gate check REV [--base REF]");
  const i = args.indexOf("--base");
  const head = git(gitDir, ["rev-parse", "--verify", `${rev}^{commit}`]);
  const base = git(gitDir, ["rev-parse", "--verify", `${i >= 0 ? args[i + 1] : "HEAD"}^{commit}`]);
  const report = judge(gitDir, base, head, rev, readConfig(gitDir));
  record(gitDir, report, "check");
  process.stdout.write(reportText(report, gitDir) + "\n");
  return passed(report.state) ? 0 : 1;
}

/** The commit whose report's name starts with REV (a hash, or the start of one), if exactly one does. */
function reportFor(gitDir: string, rev: string): string | null {
  if (!/^[0-9a-f]{7,40}$/i.test(rev)) return null;
  const dir = join(gateDir(gitDir), "reports");
  const hits = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json") && f.startsWith(rev.toLowerCase())) : [];
  return hits.length === 1 ? hits[0].slice(0, -5) : null;
}

/** A person approves the changes to the tests or rules that the last report on REV named. Typed in a terminal,
 * never piped; the approval is for exactly those changes in exactly that commit. */
async function approve(args: string[]): Promise<number> {
  const gitDir = gitDirOf(process.cwd());
  const [rev, ...why] = args.filter(a => !a.startsWith("--"));
  const reason = why.join(" ").trim();
  if (!rev || !reason) throw new Error('usage: soz-guard gate approve REV "<why these changes to the tests or rules are right>"');
  // a push the gate turned down is not kept in the repository (git drops it), but its report is: the commit
  // is found by the report's name, by its hash or the start of it, or else as a branch the server has
  const commit = reportFor(gitDir, rev) ?? git(gitDir, ["rev-parse", "--verify", `${rev}^{commit}`]);
  const report = readJson<Report>(reportPath(gitDir, commit));
  if (!report?.verdict) {
    process.stderr.write(`No verdict on ${commit.slice(0, 12)} yet: push it, or run  soz-guard gate check ${rev}  first, and read what it says.\n`);
    return 1;
  }
  const criteria = report.verdict.criteria;
  if (!criteria.length) { process.stdout.write("Nothing to approve: the last verdict on it found no change to the tests or rules.\n"); return 0; }
  if (!process.stdin.isTTY) {
    process.stderr.write("soz-guard gate approve needs a terminal: a person types it, an agent cannot.\n");
    return 2;
  }
  process.stdout.write(`${commit.slice(0, 12)} changes what counts as finished:\n${criteria.map(c => `  ${c.file}  [${c.kind}] ${c.detail}`).join("\n")}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(res => rl.question("Approve them? Type the whole word yes: ", a => { rl.close(); res(a); }));
  if (answer.trim().toLowerCase() !== "yes") { process.stdout.write("Not approved.\n"); return 1; }
  const approval: Approval = { commit, criteria: criteriaFingerprint(criteria), reason, by: userInfo().username, at: new Date().toISOString() };
  mkdirSync(dirname(approvalPath(gitDir, commit)), { recursive: true });
  writeFileSync(approvalPath(gitDir, commit), JSON.stringify(approval, null, 2) + "\n");
  appendLog(gitDir, { event: "approve", commit, reason, by: approval.by, criteria: criteria.map(c => `${c.file} ${c.kind}`) });
  process.stdout.write(`Approved, for exactly these changes in ${commit.slice(0, 12)}. Push it again; the checks still have to pass.\n`);
  return 0;
}

function logCommand(args: string[]): number {
  const gitDir = gitDirOf(process.cwd());
  const v = verifyLog(gitDir);
  if (args.includes("--verify")) {
    process.stdout.write(v.ok ? `The gate's log is intact: ${v.lines} entries, each chained to the one before.\n` : `The gate's log is broken at entry ${v.brokenAt} of ${v.lines}: ${v.why}.\n`);
    return v.ok ? 0 : 1;
  }
  const path = join(gitDir, OWN_DIR, "log.jsonl");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(l => l.trim()) : [];
  const i = args.indexOf("--last");
  for (const l of lines.slice(-Number(i >= 0 ? args[i + 1] : 20))) {
    try {
      const e = JSON.parse(l) as { seq: number; at: string; event: string; ref?: string; commit?: string; state?: string; by?: string; reason?: string;
                                   findings?: unknown[]; criteria?: unknown[]; checks?: { name: string; status: string }[]; approved?: string | null; error?: string };
      const what = e.event === "gate"
        ? `${(e.ref ?? "").replace(/^refs\/heads\//, "")} ${(e.commit ?? "").slice(0, 10)} ${e.state}${e.by ? ` (${e.by})` : ""}: ${e.findings?.length ?? 0} unfinished, ${e.criteria?.length ?? 0} criteria`
          + `${e.checks?.length ? ", " + e.checks.map(c => `${c.name} ${c.status}`).join(", ") : ""}${e.approved ? ", approved" : ""}${e.error ? `, error: ${e.error.split("\n")[0]}` : ""}`
        : e.event === "approve" ? `${(e.commit ?? "").slice(0, 10)} approved by ${e.by}: ${e.reason}` : e.event;
      process.stdout.write(`${String(e.seq).padStart(4)}  ${e.at}  ${e.event.padEnd(7)}  ${what}\n`);
    } catch { process.stdout.write("      (unreadable line)\n"); }
  }
  if (!v.ok) process.stdout.write(`\nThe gate's log is broken at entry ${v.brokenAt}: ${v.why}.\n`);
  return 0;
}

/** Installs the pre-receive hook and the gate's config in the repository at the current folder. */
function install(args: string[]): number {
  const gitDir = gitDirOf(process.cwd());
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const current = readConfig(gitDir);
  const config: GateConfig = {
    branches: (flag("--branches") ?? current.branches.join(",")).split(",").map(b => b.trim()).filter(Boolean),
    setup: flag("--setup") ?? current.setup,
    timeoutSeconds: Number(flag("--timeout") ?? current.timeoutSeconds),
  };
  mkdirSync(gateDir(gitDir), { recursive: true });
  writeFileSync(configPath(gitDir), JSON.stringify(config, null, 2) + "\n");
  const hooksDir = git(gitDir, ["rev-parse", "--git-path", "hooks"]);
  const dir = isAbsolute(hooksDir) ? hooksDir : join(gitDir, hooksDir);
  const hook = join(dir, "pre-receive");
  const command = [process.execPath, ...nodeArgs, cli].map((p, k) => k === 0 || k === nodeArgs.length + 1 ? `"${p.replace(/\\/g, "/")}"` : p).join(" ") + " gate pre-receive";
  const notes = [`gate config: ${configPath(gitDir)} (protected: ${config.branches.join(", ")}${config.setup ? `; setup: ${config.setup}` : "; no setup command"})`];
  if (existsSync(hook) && !readFileSync(hook, "utf8").includes("soz-guard gate")) {
    notes.push(`pre-receive: there is one already, left as it is; to add the gate, put this line in ${hook}:\n      ${command} || exit 1`);
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(hook, `#!/bin/sh\n# soz-guard gate: a push to a protected branch is let in only when the work is finished\nexec ${command}\n`);
    try { chmodSync(hook, 0o755); } catch { notes.push("pre-receive: could not make it executable (chmod +x it)"); }
    notes.push(`pre-receive: installed (${hook})`);
  }
  process.stdout.write(`soz-guard gate set up in ${gitDir}\n${notes.map(n => "  " + n).join("\n")}\n`
    + `  The gate holds only if the people who push cannot write here: run it as a user of its own.\n`);
  return 0;
}

export async function gate(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "pre-receive") return preReceive();
  if (sub === "check") return checkCommand(rest);
  if (sub === "approve") return approve(rest);
  if (sub === "log") return logCommand(rest);
  if (sub === "install") return install(rest);
  process.stderr.write('usage: soz-guard gate install [--branches main,production] [--setup "npm ci"] | check REV [--base REF] | approve REV "<why>" | log [--last N] [--verify]\n');
  return 2;
}
