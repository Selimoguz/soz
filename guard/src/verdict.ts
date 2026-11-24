// verdict.ts — Is the work finished? Not on the agent's word: soz-guard decides from what changed, the
// repository's own rules and the checks its owner requires, which soz-guard runs itself.
//
//   verified     no unfinished work, the criteria untouched (or accepted by a person), and every check
//                that applies ran on exactly this change and passed
//   unchecked    the same, but no check applies (none configured, or none for what changed)
//   unverified   a check could not give an answer: it timed out or could not be started
//   open         unfinished work, a failed check, or criteria changed without a person's acceptance
//
// The same change (its diff and untracked files), the same config and the same check results give the
// same verdict. Each verdict is written to .soz-guard/last.json with what it was based on: the change's
// fingerprint, the config's, and every check's command, exit code and last lines of output.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { type Check, type Config, type Finding, type Range, CONFIG_FILE, OWN_DIR, configAt, parseConfig, readDiff, repoRoot, scanLines,
         gitShow, gitIgnored, gitTracked } from "./scan.ts";
import { type CriteriaChange, criteriaChanges } from "./criteria.ts";
import { runnerChanges } from "./runners.ts";
import { type GuardState, guardState, guardChanges } from "./guard.ts";
import { matchesAny } from "./rules.ts";

export type CheckResult = {
  name: string; run: string; status: "passed" | "failed" | "timeout" | "error";
  exitCode: number | null; seconds: number; tail: string; reused?: boolean;
  /** A holdout check: TAIL is withheld, and the full output is in this file outside the repository. */
  holdout?: string;
};
export type State = "verified" | "unchecked" | "unverified" | "open";
export type Verdict = {
  state: State; change: string; config: string; at: string; range: Range;
  findings: Finding[]; criteria: CriteriaChange[]; criteriaAccepted: string | null; checks: CheckResult[];
  /** With several sessions in one folder: files changed since the baseline that this session did not touch,
   * left to the sessions that did (they are not judged here, but the checks run on them too). */
  foreign?: string[];
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const TAIL_LINES = 30;

/** The checks that apply to what changed: those without "when", and those whose paths changed. */
export function applicableChecks(checks: Check[], changedFiles: string[]): Check[] {
  if (!changedFiles.length) return [];
  return checks.filter(c => !c.when || c.when.length === 0 || changedFiles.some(f => matchesAny(f, c.when!)));
}

/** Where soz-guard keeps what must stay outside the repository: SOZ_GUARD_HOME, else ~/.soz-guard. */
export const guardHome = () => process.env.SOZ_GUARD_HOME || join(homedir(), ".soz-guard");

/** The file outside the repository where a holdout check's full output goes, for the person. */
export const holdoutResultFile = (root: string, check: string) =>
  join(guardHome(), "holdout-results", `${basename(root)}-${sha256(root).slice(0, 8)}`, `${check.replace(/[^\w-]/g, "_")}.txt`);

const WITHHELD = "(output withheld: this is a holdout check)";

/** Runs a check. A holdout check's output is written outside the repository and left out of the result,
 * which goes to the agent, .soz-guard/last.json and the cache: an agent shown what a hidden test expected
 * could write code to fit it, which is what holding the test out is meant to prevent. */
export function runCheck(root: string, c: Check): CheckResult {
  const r = runCheckOpen(root, c);
  if (!c.holdout) return r;
  const file = holdoutResultFile(root, c.name);
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${new Date().toISOString()}  ${c.name}: ${r.status}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ""}\n$ ${c.run}\n\n${r.tail}\n`);
  } catch { /* the verdict does not depend on the person's copy */ }
  return { ...r, tail: WITHHELD, holdout: file };
}

function runCheckOpen(root: string, c: Check): CheckResult {
  const started = Date.now();
  const timeout = (c.timeoutSeconds ?? 600) * 1000;
  const r = spawnSync(c.run, { cwd: root, encoding: "utf8", shell: true, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\r/g, "").split("\n");
  // a holdout check's output goes only to the person's file, which can hold more of it
  const tail = output.slice(-(c.holdout ? 400 : TAIL_LINES)).join("\n").trim();
  if (r.error && r.error.code === "ETIMEDOUT" || (r.status === null && r.signal))
    return { name: c.name, run: c.run, status: "timeout", exitCode: null, seconds, tail };
  if (r.error) return { name: c.name, run: c.run, status: "error", exitCode: null, seconds, tail: r.error.message };
  // 127: the shell could not find the command; it never ran
  if (r.status === 127) return { name: c.name, run: c.run, status: "error", exitCode: 127, seconds, tail };
  return { name: c.name, run: c.run, status: r.status === 0 ? "passed" : "failed", exitCode: r.status, seconds, tail };
}

type Accepted = { criteria: string; reason: string; at: string };

/** The fingerprint of a set of criteria changes, which a person's acceptance is bound to. */
export const criteriaFingerprint = (changes: CriteriaChange[]) => sha256(JSON.stringify(changes.map(c => [c.file, c.kind, c.evidence])));

export function readAccepted(root: string): Accepted | null {
  const p = join(root, OWN_DIR, "accepted.json");
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Accepted : null; } catch { return null; }
}

export const ACCEPTED = `${OWN_DIR}/accepted.json`;

/** A person accepts on their own machine, and .soz-guard/ stays out of git. An acceptance that is in git, or
 * in the commit being judged, came with the change: an agent can write one and commit it (git add -f), so it
 * accepts nothing, and is itself a change to what counts as finished. Its text, or null if there is none. */
function committedAcceptance(root: string, range: Range): string | null {
  const atHead = range.head ? gitShow(root, range.head, ACCEPTED) : null;
  if (atHead !== null) return atHead;
  if (!gitTracked(root, ACCEPTED)) return null;
  return gitShow(root, "HEAD", ACCEPTED) ?? (existsSync(join(root, ACCEPTED)) ? readFileSync(join(root, ACCEPTED), "utf8") : "");
}

export function writeOwn(root: string, file: string, data: unknown) {
  mkdirSync(join(root, OWN_DIR), { recursive: true });
  writeFileSync(join(root, OWN_DIR, file), JSON.stringify(data, null, 2) + "\n");
}

export type EvaluateOptions = {
  range?: Range;
  /** Run the checks (the hook does once the static part is clean; CI may leave tests to itself). */
  checks?: boolean;
  /** Reuse results of checks already run on exactly this change (the hook's cache). */
  reuse?: boolean;
  /** Write the verdict to .soz-guard/last.json and append it to the log. */
  record?: boolean;
  /** The hooks and instructions as they were at the session's start (see guard.ts); without it, as they
   * are at the range's base in git. */
  guardBase?: GuardState;
  /** Judge only these files (the ones this session touched); the rest of the change is another session's. */
  only?: Set<string>;
  /** How a criteria change counts, instead of the config's "criteriaChanges": ci --criteria, for a team that
   * reviews such changes in the pull request. With "report" the checks still run. */
  criteriaChanges?: "block" | "report";
  /** For the log: which session, and what asked for the verdict. */
  session?: string;
  source?: string;
};

// --- The log: every verdict and acceptance, appended, each line chained to the one before ---------------

const LOG = "log.jsonl";
const ZERO = "0".repeat(64);

/** Appends ENTRY to .soz-guard/log.jsonl with its sequence number and the SHA-256 of the line before,
 * so that a line removed or edited afterwards breaks the chain (soz-guard log --verify). */
export function appendLog(root: string, entry: Record<string, unknown>) {
  mkdirSync(join(root, OWN_DIR), { recursive: true });
  const path = join(root, OWN_DIR, LOG);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(l => l.trim()) : [];
  const prevLine = lines[lines.length - 1];
  let seq = 1;
  try { if (prevLine) seq = (JSON.parse(prevLine) as { seq: number }).seq + 1; } catch { seq = lines.length + 1; }
  appendFileSync(path, JSON.stringify({ seq, prev: prevLine ? sha256(prevLine) : ZERO, at: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

/** Checks the log's chain: { ok, lines } or the first line where it breaks. */
export function verifyLog(root: string): { ok: boolean; lines: number; brokenAt?: number; why?: string } {
  const path = join(root, OWN_DIR, LOG);
  if (!existsSync(path)) return { ok: true, lines: 0 };
  const lines = readFileSync(path, "utf8").split("\n").filter(l => l.trim());
  let prev = ZERO;
  for (let i = 0; i < lines.length; i++) {
    let e: { seq?: number; prev?: string };
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, lines: lines.length, brokenAt: i + 1, why: "not JSON" }; }
    if (e.seq !== i + 1) return { ok: false, lines: lines.length, brokenAt: i + 1, why: `sequence ${e.seq}, expected ${i + 1} (a line was removed or added)` };
    if (e.prev !== prev) return { ok: false, lines: lines.length, brokenAt: i + 1, why: "the line before was changed or removed" };
    prev = sha256(lines[i]);
  }
  return { ok: true, lines: lines.length };
}

export function evaluate(dir: string, o: EvaluateOptions = {}): { root: string; config: Config; verdict: Verdict } {
  const root = repoRoot(dir);
  if (!root) throw new Error(`${dir} is not in a git repository; soz-guard looks at what changed, so it needs git`);
  const range = o.range ?? { base: "HEAD" };
  // The rules come from before the change: a change that loosens them (criteriaChanges "report", maxBlocks 0,
  // a rule switched off, a check removed) is itself a criteria change, and is judged by the rules it would
  // replace. Once a person accepts it, the new rules apply.
  const before = configAt(root, range.base);
  const currentText = range.head ? (gitShow(root, range.head, CONFIG_FILE) ?? "")
    : existsSync(join(root, CONFIG_FILE)) ? readFileSync(join(root, CONFIG_FILE), "utf8") : "";
  const diff = readDiff(root, range, before.config.exclude);
  let foreign: string[] | undefined;
  if (o.only) {
    const only = o.only;
    foreign = [...diff.status.keys()].filter(f => !only.has(f)).sort();
    for (const m of [diff.added, diff.removed, diff.status, diff.renamed] as Map<string, unknown>[])
      for (const f of [...m.keys()]) if (!only.has(f)) m.delete(f);
  }
  const change = sha256(diff.fingerprint);
  // the hooks and soz-guard's instructions: against the session's start if known, else against the base in
  // git (where a file git ignores, such as settings.local.json, cannot be compared and is left out)
  const worktree = (f: string) => existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null;
  const atRev = (rev: string) => (f: string) => gitShow(root, rev, f);
  const guard = o.guardBase
    ? guardChanges(o.guardBase, guardState(worktree), root)
    : guardChanges(guardState(atRev(range.base)), guardState(range.head ? atRev(range.head) : worktree), root)
        .filter(c => range.head || !gitIgnored(root, c.file));
  const after = range.head ? atRev(range.head) : worktree;
  const criteria = [...criteriaChanges(diff, before.config), ...runnerChanges(diff, before.config, atRev(range.base), after), ...guard];
  const committed = committedAcceptance(root, range);
  if (committed !== null)
    criteria.push({ file: ACCEPTED, kind: "guard", evidence: sha256(`${ACCEPTED}\n${committed}`),
                    detail: "an acceptance is in git: a person accepts on their own machine, and an acceptance never travels with the change (git rm --cached it)" });
  const accepted = committed === null ? readAccepted(root) : null;
  const criteriaAccepted = criteria.length > 0 && accepted !== null && accepted.criteria === criteriaFingerprint(criteria) ? accepted.reason : null;
  const criteriaOpen = criteria.length > 0 && (o.criteriaChanges ?? before.config.criteriaChanges) === "block" && !criteriaAccepted;
  // a changed config, accepted by a person: from now on it is the rules
  // (a proposed config is read all the same, so that a mistake in it is said at once, not after accepting)
  const proposed = currentText !== before.text ? parseConfig(currentText || null) : before.config;
  const config = criteriaAccepted !== null ? proposed : before.config;
  const configText = config === before.config ? before.text : currentText;
  const configHash = sha256(configText);
  const findings = scanLines(diff.added, config);

  // Checks run only when nothing static is open: unfinished work has to be finished first anyway.
  let checks: CheckResult[] = [];
  const todo = applicableChecks(config.checks, [...diff.status.keys()]);
  if (o.checks !== false && !findings.length && !criteriaOpen && todo.length) {
    const cachePath = join(root, OWN_DIR, "checks.json");
    let cache: { change: string; config: string; results: CheckResult[] } | null = null;
    try { if (o.reuse !== false && existsSync(cachePath)) cache = JSON.parse(readFileSync(cachePath, "utf8")); } catch { cache = null; }
    checks = todo.map(c => {
      // a holdout check always runs again: its tests live outside the repository and can change unseen
      const hit = !c.holdout && cache && cache.change === change && cache.config === configHash
        ? cache.results.find(r => r.name === c.name && r.run === c.run && (r.status === "passed" || r.status === "failed")) : undefined;
      return hit ? { ...hit, reused: true } : runCheck(root, c);
    });
    writeOwn(root, "checks.json", { change, config: configHash, results: checks.map(({ reused, ...r }) => r) });
  }

  const state: State =
    findings.length || criteriaOpen || checks.some(c => c.status === "failed") ? "open"
    : checks.some(c => c.status === "timeout" || c.status === "error") ? "unverified"
    : todo.length && o.checks !== false ? "verified"
    : "unchecked";
  const verdict: Verdict = { state, change, config: configHash, at: new Date().toISOString(), range, findings, criteria, criteriaAccepted, checks,
                            ...(foreign ? { foreign } : {}) };
  if (o.record !== false) {
    writeOwn(root, "last.json", verdict);
    appendLog(root, {
      event: "verdict", source: o.source ?? "check", session: o.session ?? null, state, change, config: configHash,
      base: range.base, findings: findings.map(f => `${f.file}:${f.line} ${f.rule}`),
      criteria: criteria.map(c => `${c.file} ${c.kind}`), criteriaAccepted, ...(foreign ? { foreign: foreign.length } : {}),
      checks: checks.map(c => ({ name: c.name, status: c.status, seconds: c.seconds, reused: !!c.reused })),
    });
  }
  return { root, config, verdict };
}

/** The verdict in words, for the agent (in the hook) or a person (in a terminal or CI log). */
export function verdictReport(v: Verdict, forAgent: boolean): string {
  const parts: string[] = [];
  if (v.findings.length)
    parts.push(`Unfinished work in what changed:\n${v.findings.map(f => `  ${f.file}:${f.line}  [${f.rule}] ${f.text}`).join("\n")}`
      + (forAgent ? `\nFinish these. If one really has to stay unfinished, keep it, add "soz-guard: ignore <why>" to that line,\nand tell the user what is left and why. Do not hide it.` : ""));
  if (v.criteria.length)
    parts.push(`${v.criteriaAccepted ? "Changes to what counts as finished (accepted by a person: " + v.criteriaAccepted + ")" : "Changes to what counts as finished, which a person has to accept"}:\n`
      + v.criteria.map(c => `  ${c.file}  [${c.kind}] ${c.detail}`).join("\n")
      + (forAgent && !v.criteriaAccepted ? `\nDo not weaken the tests, the CI or soz-guard's rules to get your work accepted. Undo this change, or, if it is\nright (a test that no longer applies), stop and ask the user: they accept it with  soz-guard accept "<why>"  in a terminal.` : ""));
  for (const c of v.checks.filter(c => c.status !== "passed" && c.holdout))
    parts.push(forAgent
      ? `Hidden check "${c.name}" ${c.status === "failed" ? "failed" : c.status === "timeout" ? "did not finish in time" : "could not run"}. Its tests and output are kept from you on purpose:\n`
        + `the owner holds them out so the work is judged against the requirement, not against what a test expects.\n`
        + `Do not look for them. Re-read the requirement and check your work against it, edge cases included; if it is\n`
        + `unclear, stop and ask the user. The user can see the details.`
      : `Holdout check "${c.name}" ${c.status === "failed" ? `failed (exit ${c.exitCode})` : c.status === "timeout" ? "did not finish in time" : "could not run"}; its output is kept out of the repository, in:\n    ${c.holdout}`);
  for (const c of v.checks.filter(c => c.status !== "passed" && !c.holdout))
    parts.push(`Check "${c.name}" (${c.run}) ${c.status === "failed" ? `failed (exit ${c.exitCode})` : c.status === "timeout" ? "did not finish in time" : "could not run"}${c.reused ? ", on this same change before" : ""}:\n`
      + c.tail.split("\n").map(l => "    " + l).join("\n")
      + (forAgent && c.status === "failed" ? "\nMake it pass by fixing the code, not the check." : ""));
  if (v.foreign?.length && v.checks.some(c => c.status !== "passed"))
    parts.push(`Other sessions in this folder have changed ${v.foreign.length} file(s) you did not touch (${v.foreign.slice(0, 5).join(", ")}${v.foreign.length > 5 ? ", ..." : ""}).\n`
      + `The checks ran on the whole folder, their work included.`
      + (forAgent ? ` If the failure is in their files, do not edit them: say so in your final message\nand stop; fix only what is yours.` : ""));
  const passed = v.checks.filter(c => c.status === "passed");
  if (passed.length) parts.push(`Passed: ${passed.map(c => `${c.name} (${c.seconds}s${c.reused ? ", same change as before" : ""})`).join(", ")}`);
  const head = { verified: "Verified: the checks ran on this change and passed.", unchecked: "Nothing open; no check applies to this change.",
                 unverified: "Not verified: a check could not give an answer.", open: "Not finished." }[v.state];
  return `${head}\n${parts.join("\n\n")}`.trim();
}
