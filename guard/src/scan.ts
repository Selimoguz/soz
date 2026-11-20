// scan.ts — Finds unfinished work in what changed: the lines a diff adds, and new files whole.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type Rule, defaultRules, defaultExclude, IGNORE_MARK, matchesAny } from "./rules.ts";

export type Finding = { file: string; line: number; column: number; rule: string; message: string; text: string };

export type Config = {
  rules: Rule[];
  exclude: string[];
  /** Rule ids to switch off. */
  disable: string[];
  /** How many times the Claude Code hook stops the agent before it lets it finish (and says so). */
  maxBlocks: number;
};

export const CONFIG_FILE = ".soz-guard.json";

/** The defaults, changed by the repository's .soz-guard.json if there is one. */
export function loadConfig(root: string): Config {
  const config: Config = { rules: [...defaultRules], exclude: [...defaultExclude], disable: [], maxBlocks: 3 };
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return config;
  const j = JSON.parse(readFileSync(path, "utf8")) as Partial<{ rules: Rule[]; exclude: string[]; disable: string[]; maxBlocks: number }>;
  for (const r of j.rules ?? []) {
    new RegExp(r.pattern, r.flags);                          // a bad pattern fails here, not silently later
    config.rules = [...config.rules.filter(x => x.id !== r.id), r];
  }
  config.exclude.push(...(j.exclude ?? []));
  config.disable.push(...(j.disable ?? []));
  if (typeof j.maxBlocks === "number") config.maxBlocks = j.maxBlocks;
  return config;
}

const git = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const hasHead = (root: string): boolean => {
  try { git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]); return true; } catch { return false; }
};

/** The repository's top folder, or null if ROOT is not in a git repository. */
export function repoRoot(dir: string): string | null {
  try { return git(dir, ["rev-parse", "--show-toplevel"]).trim(); } catch { return null; }
}

/** Added lines per file: changes against BASE (default HEAD), plus untracked files whole. */
export function changedLines(root: string, base = "HEAD"): Map<string, [number, string][]> {
  const out = new Map<string, [number, string][]>();
  const add = (file: string, n: number, text: string) => { if (!out.has(file)) out.set(file, []); out.get(file)!.push([n, text]); };
  const whole = (file: string) => {
    const path = join(root, file);
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    if (text.includes("\u0000")) return;                     // binary
    text.split(/\r?\n/).forEach((l, i) => add(file, i + 1, l));
  };
  if (base === "HEAD" && !hasHead(root)) {
    for (const f of git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n")) if (f) whole(f);
    return out;
  }
  let file: string | null = null, n = 0;
  for (const line of git(root, ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "-U0", base, "--"]).split("\n")) {
    if (line.startsWith("+++ ")) { file = line === "+++ /dev/null" ? null : line.slice(6); continue; }
    if (line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { n = Number(hunk[1]); continue; }
    if (file && line.startsWith("+")) add(file, n++, line.slice(1).replace(/\r$/, ""));
  }
  for (const f of git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n")) if (f) whole(f);
  return out;
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
  return { root, findings: scanLines(changedLines(root, base), config), config };
}

export function report(findings: Finding[]): string {
  return findings.map(f => `  ${f.file}:${f.line}  [${f.rule}] ${f.text}`).join("\n");
}
