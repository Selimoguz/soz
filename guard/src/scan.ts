// scan.ts — Finds unfinished work in what changed: the lines a diff adds, and new files whole.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Rule, defaultRules, defaultExclude, IGNORE_MARK, matchesAny } from "./rules.ts";

export type Finding = { file: string; line: number; column: number; rule: string; message: string; text: string };

/** A check the repository's owner requires, run by soz-guard itself (never taken on the agent's word). */
export type Check = {
  name: string; run: string; when?: string[]; timeoutSeconds?: number;
  /** A check whose tests the agent must not see (kept outside the repository): its output never reaches the
   * agent or the repository's .soz-guard/, only a file in the user's home (see verdict.ts). */
  holdout?: boolean;
};

export type Config = {
  rules: Rule[];
  exclude: string[];
  /** Rule ids to switch off. */
  disable: string[];
  /** How many times the Claude Code hook stops the agent before it lets it finish (and says so). */
  maxBlocks: number;
  /** What must pass before work counts as finished. */
  checks: Check[];
  /** The files that define what "finished" means (tests, CI, this config): an agent may add to them,
   * but deleting them or removing assertions needs a person. */
  criteria: string[];
  /** "block" (default): a change to the criteria keeps the work open until a person accepts it;
   * "report": it is only reported. */
  criteriaChanges: "block" | "report";
  /** "fewer" (default): fewer assertions in a criteria file need a person; "any-change": so does any
   * existing assertion that was changed or removed (moving it unchanged, or adding new ones, is fine). */
  assertions: "fewer" | "any-change";
};

export const CONFIG_FILE = ".soz-guard.json";

export const defaultCriteria = [
  CONFIG_FILE, "**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/*_test.*",
  "**/test_*.py", ".github/workflows/**", ".gitlab-ci.yml", "**/Jenkinsfile",
];

/** The defaults, changed by the repository's .soz-guard.json if there is one. */
export function loadConfig(root: string): Config {
  const config: Config = { rules: [...defaultRules], exclude: [...defaultExclude], disable: [], maxBlocks: 3,
                           checks: [], criteria: [...defaultCriteria], criteriaChanges: "block", assertions: "fewer" };
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return config;
  const j = JSON.parse(readFileSync(path, "utf8")) as Partial<{
    rules: Rule[]; exclude: string[]; disable: string[]; maxBlocks: number;
    checks: Check[]; criteria: string[]; criteriaChanges: string; assertions: string;
  }>;
  if (j.assertions !== undefined && j.assertions !== "fewer" && j.assertions !== "any-change")
    throw new Error(`${CONFIG_FILE}: "assertions" is "fewer" or "any-change", not ${JSON.stringify(j.assertions)}`);
  if (j.assertions) config.assertions = j.assertions;
  for (const c of j.checks ?? []) {
    if (!c || typeof c.name !== "string" || typeof c.run !== "string" || !c.run.trim())
      throw new Error(`${CONFIG_FILE}: a check needs a name and a command to run: ${JSON.stringify(c)}`);
    if (c.holdout !== undefined && typeof c.holdout !== "boolean")
      throw new Error(`${CONFIG_FILE}: "holdout" is true or false: ${JSON.stringify(c)}`);
    config.checks.push(c);
  }
  config.criteria.push(...(j.criteria ?? []));
  if (j.criteriaChanges === "report" || j.criteriaChanges === "block") config.criteriaChanges = j.criteriaChanges;
  for (const r of j.rules ?? []) {
    new RegExp(r.pattern, r.flags);                          // a bad pattern fails here, not silently later
    config.rules = [...config.rules.filter(x => x.id !== r.id), r];
  }
  config.exclude.push(...(j.exclude ?? []));
  config.disable.push(...(j.disable ?? []));
  if (typeof j.maxBlocks === "number") config.maxBlocks = j.maxBlocks;
  return config;
}

// git's own messages are captured (stdio "pipe"), not printed: soz-guard says what went wrong itself.
const git = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

const hasHead = (root: string): boolean => {
  try { git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]); return true; } catch { return false; }
};

/** The repository's top folder, or null if ROOT is not in a git repository. */
export function repoRoot(dir: string): string | null {
  try { return git(dir, ["rev-parse", "--show-toplevel"]).trim(); } catch { return null; }
}

/** FILE's text at REV (a commit or a tree), or null if it is not there. */
export function gitShow(root: string, rev: string, file: string): string | null {
  try { return git(root, ["show", `${rev}:${file}`]); } catch { return null; }
}

/** Whether FILE is tracked in git's index (committed, or staged to be). */
export function gitTracked(root: string, file: string): boolean {
  try { return git(root, ["ls-files", "--", file]).trim() !== ""; } catch { return false; }
}

/** Whether git ignores FILE (.gitignore and the like). */
export function gitIgnored(root: string, file: string): boolean {
  try { git(root, ["check-ignore", "-q", file]); return true; } catch { return false; }
}

/** soz-guard's own folder (verdicts, caches, acceptances): never a change of the project. */
export const OWN_DIR = ".soz-guard";

/** An exclude pattern that would hide soz-guard's own config is not applied: a change to it is always seen. */
export const excludesConfig = (glob: string) => matchesAny(CONFIG_FILE, [glob]);
const own = (file: string) => file === OWN_DIR || file.startsWith(OWN_DIR + "/");

/** What is compared: BASE against HEAD (a commit), or, without HEAD, against the working tree and its
 * untracked files (what an agent has changed and not committed). */
export type Range = { base: string; head?: string };

/** What a diff says: added lines (new numbering), removed lines (old numbering), each file's status
 * (A added, M modified, D deleted, R renamed), and a fingerprint of all of it (the diff's text and the
 * untracked files' contents) that a verdict is bound to. */
export type Diff = {
  added: Map<string, [number, string][]>;
  removed: Map<string, [number, string][]>;
  status: Map<string, string>;
  /** A renamed file's path before (keyed by its path now): a test moved out of the tests is a test gone. */
  renamed: Map<string, string>;
  fingerprint: string;
};

/** Untracked files larger than this are not read: they are data (caches, databases, archives), not
 * code to scan; the fingerprint takes their size and modification time instead. */
const LARGE = 2 * 1024 * 1024;

/** EXCLUDE (glob patterns) is left out of the diff altogether, in git itself: a project that committed
 * node_modules does not make soz-guard read every package's every line. soz-guard's config file is never
 * left out, whatever EXCLUDE says, so a change to it is always seen. */
export function readDiff(root: string, range: Range = { base: "HEAD" }, exclude: string[] = []): Diff {
  const added = new Map<string, [number, string][]>(), removed = new Map<string, [number, string][]>(), status = new Map<string, string>();
  const renamed = new Map<string, string>();
  const push = (m: Map<string, [number, string][]>, file: string, n: number, text: string) => {
    if (own(file)) return;
    if (!m.has(file)) m.set(file, []);
    m.get(file)!.push([n, text]);
  };
  const hash = createHash("sha256");
  const paths = ["--", ".", ...exclude.filter(g => !excludesConfig(g)).map(g => `:(exclude,glob)${g}`)];
  const whole = (file: string) => {
    if (own(file)) return;
    const path = join(root, file);
    if (!existsSync(path)) return;
    status.set(file, "A");
    const st = statSync(path);
    if (st.size > LARGE) { hash.update(`\nuntracked ${file} size ${st.size} modified ${st.mtimeMs}\n`, "utf8"); return; }
    const text = readFileSync(path, "utf8");
    hash.update(`\nuntracked ${file}\n`, "utf8").update(text, "utf8");
    if (text.includes("\u0000")) return;                     // binary
    text.split(/\r?\n/).forEach((l, i) => push(added, file, i + 1, l));
  };
  const untracked = (extra: string[]) =>
    git(root, ["-c", "core.quotepath=false", "ls-files", ...extra, "--others", "--exclude-standard", ...paths]).split("\n").filter(Boolean);
  if (!range.head && range.base === "HEAD" && !hasHead(root)) {
    for (const f of untracked(["--cached"])) whole(f);
    return { added, removed, status, renamed, fingerprint: hash.digest("hex") };
  }
  const span = range.head ? [range.base, range.head] : [range.base];
  const nameStatus = git(root, ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "--name-status", "-M", ...span, ...paths]);
  for (const line of nameStatus.split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 2 && !own(parts[parts.length - 1])) {
      status.set(parts[parts.length - 1], parts[0][0]);
      if (parts[0][0] === "R" && parts.length >= 3) renamed.set(parts[2], parts[1]);
    }
  }
  // a line whose only change is its ending (LF and CRLF, as Windows and other machines check files out) has
  // not changed: it is neither added code to scan nor an assertion removed
  const diffText = git(root, ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "-U0", "-M", "--ignore-cr-at-eol", ...span, ...paths]);
  hash.update(nameStatus, "utf8").update(diffText, "utf8");
  let oldFile: string | null = null, newFile: string | null = null, o = 0, n = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- ")) { oldFile = line === "--- /dev/null" ? null : line.slice(6); continue; }
    if (line.startsWith("+++ ")) { newFile = line === "+++ /dev/null" ? null : line.slice(6); continue; }
    if (line.startsWith("diff ") || line.startsWith("index ")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { o = Number(hunk[1]); n = Number(hunk[2]); continue; }
    if (line.startsWith("+") && newFile) push(added, newFile, n++, line.slice(1).replace(/\r$/, ""));
    else if (line.startsWith("-") && (newFile ?? oldFile)) push(removed, newFile ?? oldFile!, o++, line.slice(1).replace(/\r$/, ""));
  }
  if (!range.head) for (const f of untracked([])) whole(f);
  return { added, removed, status, renamed, fingerprint: hash.digest("hex") };
}

/** Added lines per file: changes against BASE (default HEAD), plus untracked files whole. */
export function changedLines(root: string, base = "HEAD", exclude: string[] = []): Map<string, [number, string][]> {
  return readDiff(root, { base }, exclude).added;
}

export function scanLines(lines: Map<string, [number, string][]>, config: Config): Finding[] {
  const rules = config.rules.filter(r => !config.disable.includes(r.id)).map(r => ({ r, re: new RegExp(r.pattern, r.flags) }));
  const findings: Finding[] = [];
  for (const [file, ls] of lines) {
    if (matchesAny(file, config.exclude)) continue;
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    const applicable = rules.filter(({ r }) => (!r.extensions || r.extensions.includes(ext)) && !(r.exclude && matchesAny(file, r.exclude)));
    for (const [line, text] of ls) {
      if (IGNORE_MARK.test(text)) continue;
      for (const { r, re } of applicable) {
        const m = re.exec(text);
        if (m) { findings.push({ file, line, column: m.index + 1, rule: r.id, message: r.message, text: text.trim().slice(0, 160) }); break; }
      }
    }
  }
  return findings;
}

/** Everything that changed in the repository at DIR, scanned. */
export function scan(dir: string, base = "HEAD"): { root: string; findings: Finding[]; config: Config } {
  const root = repoRoot(dir);
  if (!root) throw new Error(`${dir} is not in a git repository; soz-guard looks at what changed, so it needs git`);
  const config = loadConfig(root);
  return { root, findings: scanLines(changedLines(root, base, config.exclude), config), config };
}

export function report(findings: Finding[]): string {
  return findings.map(f => `  ${f.file}:${f.line}  [${f.rule}] ${f.text}`).join("\n");
}
