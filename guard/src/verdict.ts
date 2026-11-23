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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Check, type Config, type Finding, type Range, CONFIG_FILE, OWN_DIR, loadConfig, readDiff, repoRoot, scanLines } from "./scan.ts";
import { type CriteriaChange, criteriaChanges } from "./criteria.ts";
import { matchesAny } from "./rules.ts";

export type CheckResult = {
  name: string; run: string; status: "passed" | "failed" | "timeout" | "error";
  exitCode: number | null; seconds: number; tail: string; reused?: boolean;
};
export type State = "verified" | "unchecked" | "unverified" | "open";
export type Verdict = {
  state: State; change: string; config: string; at: string; range: Range;
  findings: Finding[]; criteria: CriteriaChange[]; criteriaAccepted: string | null; checks: CheckResult[];
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const TAIL_LINES = 30;

/** The checks that apply to what changed: those without "when", and those whose paths changed. */
export function applicableChecks(checks: Check[], changedFiles: string[]): Check[] {
  if (!changedFiles.length) return [];
  return checks.filter(c => !c.when || c.when.length === 0 || changedFiles.some(f => matchesAny(f, c.when!)));
}

export function runCheck(root: string, c: Check): CheckResult {
  const started = Date.now();
  const timeout = (c.timeoutSeconds ?? 600) * 1000;
  const r = spawnSync(c.run, { cwd: root, encoding: "utf8", shell: true, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\r/g, "").split("\n");
  const tail = output.slice(-TAIL_LINES).join("\n").trim();
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
  /** Write the verdict to .soz-guard/last.json. */
  record?: boolean;
};

export function evaluate(dir: string, o: EvaluateOptions = {}): { root: string; config: Config; verdict: Verdict } {
  const root = repoRoot(dir);
  if (!root) throw new Error(`${dir} is not in a git repository; soz-guard looks at what changed, so it needs git`);
  const range = o.range ?? { base: "HEAD" };
  const config = loadConfig(root);
  const configText = existsSync(join(root, CONFIG_FILE)) ? readFileSync(join(root, CONFIG_FILE), "utf8") : "";
  const diff = readDiff(root, range, config.exclude);
  const change = sha256(diff.fingerprint), configHash = sha256(configText);
  const findings = scanLines(diff.added, config);
  const criteria = criteriaChanges(diff, config);
  const accepted = readAccepted(root);
  const criteriaAccepted = criteria.length && accepted && accepted.criteria === criteriaFingerprint(criteria) ? accepted.reason : null;
  const criteriaOpen = criteria.length > 0 && config.criteriaChanges === "block" && !criteriaAccepted;

  // Checks run only when nothing static is open: unfinished work has to be finished first anyway.
  let checks: CheckResult[] = [];
  const todo = applicableChecks(config.checks, [...diff.status.keys()]);
  if (o.checks !== false && !findings.length && !criteriaOpen && todo.length) {
    const cachePath = join(root, OWN_DIR, "checks.json");
    let cache: { change: string; config: string; results: CheckResult[] } | null = null;
    try { if (o.reuse !== false && existsSync(cachePath)) cache = JSON.parse(readFileSync(cachePath, "utf8")); } catch { cache = null; }
    checks = todo.map(c => {
      const hit = cache && cache.change === change && cache.config === configHash
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
  const verdict: Verdict = { state, change, config: configHash, at: new Date().toISOString(), range, findings, criteria, criteriaAccepted, checks };
  if (o.record !== false) writeOwn(root, "last.json", verdict);
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
  for (const c of v.checks.filter(c => c.status !== "passed"))
    parts.push(`Check "${c.name}" (${c.run}) ${c.status === "failed" ? `failed (exit ${c.exitCode})` : c.status === "timeout" ? "did not finish in time" : "could not run"}${c.reused ? ", on this same change before" : ""}:\n`
      + c.tail.split("\n").map(l => "    " + l).join("\n")
      + (forAgent && c.status === "failed" ? "\nMake it pass by fixing the code, not the check." : ""));
  const passed = v.checks.filter(c => c.status === "passed");
  if (passed.length) parts.push(`Passed: ${passed.map(c => `${c.name} (${c.seconds}s${c.reused ? ", same change as before" : ""})`).join(", ")}`);
  const head = { verified: "Verified: the checks ran on this change and passed.", unchecked: "Nothing open; no check applies to this change.",
                 unverified: "Not verified: a check could not give an answer.", open: "Not finished." }[v.state];
  return `${head}\n${parts.join("\n\n")}`.trim();
}
