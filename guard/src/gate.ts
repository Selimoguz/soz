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
import { type Task, type TaskRecord, type TaskEvaluation, ACCEPTANCE_DIR, readTasks, itemsHash, itemContent, bindingOf, bringTests, evaluateTask, taskReport } from "./tasks.ts";

const self = fileURLToPath(import.meta.url);
const cli = join(dirname(self), `cli${self.endsWith(".ts") ? ".ts" : ".js"}`);
const nodeArgs = self.endsWith(".ts") ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] : [];
const ZERO = /^0+$/;

type GateConfig = { branches: string[]; setup: string; timeoutSeconds: number };
type Approval = { commit: string; criteria: string; reason: string; by: string; at: string };
type Report = { commit: string; base: string; ref: string; state: string; verdict: Verdict | null; setup?: { ok: boolean; tail: string };
                error?: string; approved: string | null; at: string; tasks?: TaskEvaluation[]; taskProblems?: string[] };

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

/** A folder of its own with REV checked out, reading the server's objects (and, in a pre-receive hook, the
 * pushed ones, which git keeps in quarantine until the hook lets them in); REFS are made in it too. With
 * SETUP, the setup command is run there. The caller removes it. */
function checkout(gitDir: string, rev: string, refs: Record<string, string>, config: GateConfig, setup: boolean): { dir: string; setup?: { ok: boolean; tail: string } } {
  const env = cleanEnv();
  const dir = mkdtempSync(join(tmpdir(), "soz-gate-"));
  git(dir, ["init", "-q"], env);
  const objects = [join(gitDir, "objects"), ...(process.env.GIT_QUARANTINE_PATH ? [process.env.GIT_QUARANTINE_PATH] : [])];
  writeFileSync(join(dir, ".git", "objects", "info", "alternates"), objects.map(o => o.replace(/\\/g, "/")).join("\n") + "\n");
  for (const [ref, to] of Object.entries(refs)) git(dir, ["update-ref", ref, to], env);
  git(dir, ["update-ref", "refs/heads/gate", rev], env);
  git(dir, ["-c", "advice.detachedHead=false", "checkout", "-q", "gate"], env);
  if (!setup || !config.setup.trim()) return { dir };
  const r = spawnSync(config.setup, { cwd: dir, shell: true, encoding: "utf8", env, timeout: config.timeoutSeconds * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\r/g, "").split("\n").slice(-20).join("\n").trim();
  return { dir, setup: { ok: r.status === 0 && !r.error, tail: r.error ? r.error.message : tail } };
}

const taskPath = (gitDir: string, task: string) => join(gateDir(gitDir), "tasks", `${task.replace(/[^\w.-]/g, "_")}.json`);
const readRecord = (gitDir: string, task: string): TaskRecord => readJson<TaskRecord>(taskPath(gitDir, task)) ?? {};
function writeRecord(gitDir: string, task: string, r: TaskRecord) {
  mkdirSync(dirname(taskPath(gitDir, task)), { recursive: true });
  writeFileSync(taskPath(gitDir, task), JSON.stringify(r, null, 2) + "\n");
}

/** TASKS evaluated on the delivery checked out in DIR (SPEC 4.3, 4.4): each against the base its approval
 * names, checked out and set up on its own, with the delivery's bound tests brought in. */
function evaluateTasks(gitDir: string, tasks: Task[], delivery: string, dir: string, config: GateConfig): TaskEvaluation[] {
  return tasks.map(t => {
    const record = readRecord(gitDir, t.task);
    const base = record.approval && record.approval.itemsHash === itemsHash(dir, t) ? record.approval.base : null;
    let baseDir: string | null = null;
    try {
      if (base) {
        const b = checkout(gitDir, base, {}, config, true);
        baseDir = b.dir;
        if (b.setup && !b.setup.ok) { rmSync(baseDir, { recursive: true, force: true }); baseDir = null; }
        else bringTests(dir, baseDir, t);
      }
      const e = evaluateTask(t, record, delivery, dir, baseDir, cleanEnv(), config.timeoutSeconds);
      keepEvaluation(gitDir, e);
      return e;
    } finally {
      if (baseDir) rmSync(baseDir, { recursive: true, force: true });
    }
  });
}

/** The verdict on HEAD against BASE (commits in the repository at GIT_DIR), worked out in a folder of its own:
 * soz-guard's verdict on the change, and the verdict of every task the change carries. */
export function judge(gitDir: string, base: string, head: string, ref: string, config: GateConfig): Report {
  const at = new Date().toISOString();
  const approval = readJson<Approval>(approvalPath(gitDir, head));
  let work: string | null = null;
  try {
    const c = checkout(gitDir, head, { "refs/remotes/gate/base": base }, config, true);
    work = c.dir;
    const setup = c.setup;
    if (setup && !setup.ok) return { commit: head, base, ref, state: "unverified", verdict: null, setup, approved: null, at };
    const env = cleanEnv();
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
    // the tasks this change carries (their file added or changed): pushing them is asking for completion
    const touched = git(work, ["diff", "--name-only", "refs/remotes/gate/base", "HEAD", "--", ACCEPTANCE_DIR], env).split("\n").filter(Boolean);
    const { tasks, problems } = readTasks(work);
    const carried = tasks.filter(t => touched.includes(`${ACCEPTANCE_DIR}/${t.task}.json`));
    const taskProblems = problems.filter(p => touched.some(f => p.startsWith(f)));
    const evaluations = evaluateTasks(gitDir, carried, head, work, config);
    if (taskProblems.length || evaluations.some(e => e.verdict === "incomplete")) state = "open";
    else if (evaluations.some(e => e.verdict === "unverified") && state !== "open") state = "unverified";
    return { commit: head, base, ref, state, verdict, setup, approved, at,
             ...(evaluations.length ? { tasks: evaluations } : {}), ...(taskProblems.length ? { taskProblems } : {}) };
  } catch (e) {
    return { commit: head, base, ref, state: "unverified", verdict: null, error: (e as Error).message, approved: null, at };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
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
    ...(report.tasks ? { tasks: report.tasks.map(t => ({ task: t.task, verdict: t.verdict, items: Object.fromEntries(t.items.map(i => [i.id, i.state])) })) } : {}),
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
  for (const p of r.taskProblems ?? []) lines.push(`A task file cannot be read: ${p}`);
  for (const t of r.tasks ?? []) lines.push(taskReport(t) + taskHints(t, gitDir, r.commit));
  if (r.approved) lines.push(`The changes to the tests or rules were approved by a person: ${r.approved}`);
  else if (!passed(r.state) && v.criteria.length && !v.findings.length && !v.checks.some(c => c.status === "failed"))
    lines.push(`If these changes to the tests or rules are right, a person approves them on the server, in a terminal:\n`
      + `    cd ${gitDir.replace(/\\/g, "/")} && soz-guard gate approve ${r.commit.slice(0, 12)} "<why>"\nand pushes again.`);
  return lines.join("\n");
}

/** What a person can do about a task that is not complete, as commands to type on the server. */
function taskHints(t: TaskEvaluation, gitDir: string, commit: string): string {
  const at = `cd ${gitDir.replace(/\\/g, "/")} && soz-guard gate task`;
  const out: string[] = [];
  if (!t.approved) out.push(`${at} approve ${t.task} <a branch that has it>     (read the items, approve them in words)`);
  for (const i of t.items) {
    if (i.state === "unproven" && i.alreadyTrue) out.push(`${at} confirm ${t.task} ${i.id} ${commit.slice(0, 12)}     (it passed before the task: look at what the test does)`);
    if (i.state === "awaiting-person") out.push(`${at} confirm ${t.task} ${i.id} ${commit.slice(0, 12)}     (look at the delivery yourself)`);
  }
  return out.length ? `\n  A person, on the server:\n${out.map(o => "    " + o).join("\n")}` : "";
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
                                   findings?: unknown[]; criteria?: unknown[]; checks?: { name: string; status: string }[]; approved?: string | null; error?: string;
                                   task?: string; item?: string; delivery?: string; verdict?: string;
                                   tasks?: { task: string; verdict: string; items: Record<string, string> }[]; items?: Record<string, string> };
      const items = (m?: Record<string, string>) => m ? Object.entries(m).map(([k, v]) => `${k} ${v}`).join(", ") : "";
      const what = e.event === "gate"
        ? `${(e.ref ?? "").replace(/^refs\/heads\//, "")} ${(e.commit ?? "").slice(0, 10)} ${e.state}${e.by ? ` (${e.by})` : ""}: ${e.findings?.length ?? 0} unfinished, ${e.criteria?.length ?? 0} criteria`
          + `${e.checks?.length ? ", " + e.checks.map(c => `${c.name} ${c.status}`).join(", ") : ""}${e.approved ? ", approved" : ""}${e.error ? `, error: ${e.error.split("\n")[0]}` : ""}`
          + (e.tasks ?? []).map(t => `; task ${t.task} ${t.verdict} (${items(t.items)})`).join("")
        : e.event === "approve" ? `${(e.commit ?? "").slice(0, 10)} approved by ${e.by}: ${e.reason}`
        : e.event === "task" ? `${e.task} on ${(e.delivery ?? "").slice(0, 10)}: ${e.verdict} (${items(e.items)})`
        : e.event.startsWith("task-") ? `${e.task}${e.item ? ` ${e.item}` : ""} ${e.event.slice(5)}d by ${e.by}${e.reason ? `: ${e.reason}` : ""}`
        : e.event;
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

// --- Tasks, on the server: the person approves items, confirms what only they can, takes items out ---------

const evalPath = (gitDir: string, task: string, commit: string) => join(gateDir(gitDir), "tasks", task.replace(/[^\w.-]/g, "_"), `${commit}.json`);

/** Keeps a task's evaluation on a delivery, for status, confirm and the person's record. */
function keepEvaluation(gitDir: string, e: TaskEvaluation) {
  mkdirSync(dirname(evalPath(gitDir, e.task, e.delivery)), { recursive: true });
  writeFileSync(evalPath(gitDir, e.task, e.delivery), JSON.stringify(e, null, 2) + "\n");
}

/** The evaluation of TASK on the delivery whose commit starts with REV: git drops a push it turned down, so
 * the delivery is found by what the gate kept. */
function evaluationFor(gitDir: string, task: string, rev: string): TaskEvaluation | null {
  const dir = dirname(evalPath(gitDir, task, "x"));
  if (!existsSync(dir)) return null;
  let commit = rev;
  try { commit = git(gitDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]); } catch { commit = rev; }
  const hits = readdirSync(dir).filter(f => f.startsWith(commit.toLowerCase()) && f.endsWith(".json"));
  return hits.length === 1 ? readJson<TaskEvaluation>(join(dir, hits[0])) : null;
}

/** The gate's newest verdict on a task, whatever the delivery. */
function latestEvaluation(gitDir: string, task: string): TaskEvaluation | null {
  const dir = dirname(evalPath(gitDir, task, "x"));
  if (!existsSync(dir)) return null;
  const all = readdirSync(dir).filter(f => f.endsWith(".json")).map(f => readJson<TaskEvaluation>(join(dir, f)))
    .filter((e): e is TaskEvaluation => !!e && typeof e.at === "string");
  return all.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

const terminalOnly = (what: string): boolean => {
  if (process.stdin.isTTY) return true;
  process.stderr.write(`soz-guard gate task ${what} needs a terminal: a person types it, an agent cannot.\n`);
  return false;
};
async function yes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(res => rl.question(`${question} Type the whole word yes: `, a => { rl.close(); res(a); }));
  return answer.trim().toLowerCase() === "yes";
}

/** The protected branch's tip: what is live, where a task starts from by default. */
const liveTip = (gitDir: string, config: GateConfig) => git(gitDir, ["rev-parse", "--verify", `refs/heads/${config.branches[0]}^{commit}`]);

async function taskCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const gitDir = gitDirOf(process.cwd());
  const config = readConfig(gitDir);
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const pos = rest.filter((a, k) => !a.startsWith("--") && rest[k - 1] !== "--base");
  const by = userInfo().username;
  const now = () => new Date().toISOString();

  if (sub === "status") {
    // the task's verdict on a delivery (by default what is live), worked out now; nothing the model says counts
    const [taskId, rev] = pos;
    if (!taskId) throw new Error("usage: soz-guard gate task status TASK [REV]");
    const head = git(gitDir, ["rev-parse", "--verify", `${rev ?? `refs/heads/${config.branches[0]}`}^{commit}`]);
    const c = checkout(gitDir, head, {}, config, true);
    try {
      if (c.setup && !c.setup.ok) { process.stdout.write(`Task ${taskId}: unverified, the setup failed on ${head.slice(0, 10)}:\n${c.setup.tail}\n`); return 1; }
      const { tasks, problems } = readTasks(c.dir);
      const task = tasks.find(t => t.task === taskId);
      if (!task) {
        process.stdout.write(`Task ${taskId}: open. ${problems.find(p => p.includes(`${taskId}.json`)) ?? `${ACCEPTANCE_DIR}/${taskId}.json is not in ${rev ?? config.branches[0]} (${head.slice(0, 10)})`}\n`);
        return 1;
      }
      const [e] = evaluateTasks(gitDir, [task], head, c.dir, config);
      keepEvaluation(gitDir, e);
      appendLog(gitDir, { event: "task", task: e.task, delivery: head, verdict: e.verdict, items: Object.fromEntries(e.items.map(i => [i.id, i.state])), by });
      process.stdout.write(`${taskReport(e)}${taskHints(e, gitDir, head)}\n  (on ${head.slice(0, 10)}${e.base ? `, against the base ${e.base.slice(0, 10)}` : ""})\n`);
      return e.verdict === "complete" ? 0 : 1;
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }

  if (sub === "approve") {
    const [taskId, rev] = pos;
    if (!taskId || !rev) throw new Error("usage: soz-guard gate task approve TASK REV [--base REV]   (REV: a branch or commit on the server that has the task)");
    const head = git(gitDir, ["rev-parse", "--verify", `${rev}^{commit}`]);
    const c = checkout(gitDir, head, {}, config, false);
    try {
      const task = readTasks(c.dir).tasks.find(t => t.task === taskId);
      if (!task) { process.stderr.write(`${ACCEPTANCE_DIR}/${taskId}.json is not in ${rev}, or cannot be read.\n`); return 1; }
      const base = flag("--base") ? git(gitDir, ["rev-parse", "--verify", `${flag("--base")}^{commit}`]) : liveTip(gitDir, config);
      process.stdout.write(`Task ${task.task}: ${task.title}\nWhat it must do, each proved on the delivery before the task counts as complete:\n`
        + task.items.map(i => `  ${i.id}${i.required === false ? " (optional)" : ""}  ${i.text}\n        proved by ${i.proof === "person" ? "a person, on the delivery" : `the test ${i.test!.name || `[${i.id}]`} in ${i.test!.file}${bindingOf(c.dir, i) ? "" : " (NOT in this commit)"}`}`).join("\n")
        + `\nStarting from ${base.slice(0, 10)} (what is live now): each test must fail there, or pass there and be confirmed by you.\n`);
      if (!terminalOnly("approve")) return 2;
      if (!(await yes("Are these the behaviours you asked for?"))) { process.stdout.write("Not approved.\n"); return 1; }
      const record = readRecord(gitDir, taskId);
      record.approval = { itemsHash: itemsHash(c.dir, task), base, by, at: now() };
      writeRecord(gitDir, taskId, record);
      appendLog(gitDir, { event: "task-approve", task: taskId, itemsHash: record.approval.itemsHash, base, by });
      process.stdout.write(`Approved. Any change to these items or their tests needs your approval again.\n`);
      return 0;
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  }

  if (sub === "confirm") {
    const [taskId, itemId, rev] = pos;
    if (!taskId || !itemId || !rev) throw new Error("usage: soz-guard gate task confirm TASK ITEM REV   (REV: the delivery the gate printed)");
    const e = evaluationFor(gitDir, taskId, rev);
    const item = e?.items.find(i => i.id === itemId);
    if (!e || !item) { process.stderr.write(`No verdict of the gate on ${taskId} at ${rev} with an item ${itemId}: run  soz-guard gate task status ${taskId} ${rev}  first.\n`); return 1; }
    const already = item.proof === "check" && item.alreadyTrue && item.binding;
    if (!already && item.proof !== "person") { process.stderr.write(`${itemId} is proved by its test, not by a person; nothing to confirm.\n`); return 1; }
    process.stdout.write(already
      ? `${itemId}: ${item.text}\nIts test passed before the task, as it does now. A test that passes from the start is what a hollow test\nlooks like too: read what it does (${e.items.find(i => i.id === itemId)?.detail}).\n`
      : `${itemId}: ${item.text}\nLook at delivery ${e.delivery.slice(0, 10)} yourself.\n`);
    if (!terminalOnly("confirm")) return 2;
    if (!(await yes(already ? "Does the test really check this?" : "Does the delivery do this?"))) { process.stdout.write("Not confirmed.\n"); return 1; }
    const record = readRecord(gitDir, taskId);
    record.confirmed = { ...(record.confirmed ?? {}), [itemId]: already ? { binding: item.binding!, by, at: now() } : { delivery: e.delivery, by, at: now() } };
    writeRecord(gitDir, taskId, record);
    appendLog(gitDir, { event: "task-confirm", task: taskId, item: itemId, delivery: e.delivery, by });
    process.stdout.write(`Confirmed${already ? ", for this test as it is" : `, on ${e.delivery.slice(0, 10)}`}. Push or check again for the task's verdict.\n`);
    return 0;
  }

  if (sub === "descope") {
    const [taskId, itemId, ...why] = pos;
    const reason = why.join(" ").trim();
    if (!taskId || !itemId || !reason) throw new Error('usage: soz-guard gate task descope TASK ITEM "<why it is out of this task>"');
    // the decision is about the item as the person reads it here; reworded later, it is asked again
    const item = latestEvaluation(gitDir, taskId)?.items.find(i => i.id === itemId);
    if (!item) { process.stderr.write(`The gate has not judged ${taskId} with an item ${itemId} yet: push it, or run  soz-guard gate check REV, first.\n`); return 1; }
    process.stdout.write(`${itemId}: ${item.text}\n`);
    if (!terminalOnly("descope")) return 2;
    if (!(await yes(`Take ${itemId} out of ${taskId} (${reason})? The task can then be complete without it.`))) { process.stdout.write("Left in.\n"); return 1; }
    const record = readRecord(gitDir, taskId);
    record.descoped = { ...(record.descoped ?? {}), [itemId]: { item: itemContent(item), reason, by, at: now() } };
    writeRecord(gitDir, taskId, record);
    appendLog(gitDir, { event: "task-descope", task: taskId, item: itemId, reason, by });
    process.stdout.write(`${itemId} is out of ${taskId}: ${reason}\n`);
    return 0;
  }
  process.stderr.write('usage: soz-guard gate task status TASK [REV] | approve TASK REV [--base REV] | confirm TASK ITEM REV | descope TASK ITEM "<why>"\n');
  return 2;
}

export async function gate(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "pre-receive") return preReceive();
  if (sub === "check") return checkCommand(rest);
  if (sub === "approve") return approve(rest);
  if (sub === "log") return logCommand(rest);
  if (sub === "install") return install(rest);
  if (sub === "task") return taskCommand(rest);
  process.stderr.write('usage: soz-guard gate install [--branches main,production] [--setup "npm ci"] | check REV [--base REF] | approve REV "<why>" | log [--last N] [--verify] | task status|approve|confirm|descope ...\n');
  return 2;
}
