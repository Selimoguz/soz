// runners.ts — What decides which tests run, and how. A required check is a command ("npm test"); what it
// runs is decided by files outside the tests: package.json's scripts, the test runner's config (jest,
// vitest, pytest...), conftest.py. An agent that changes the test script to "exit 0", or tells the runner
// to leave a folder out, has weakened the tests without touching one, so such a change is a criteria change
// (kind "runner") that a person accepts.
//
// Only what matters is compared, so ordinary edits stay free: in package.json the existing scripts and the
// runners' own sections ("jest", "ava", ...), not dependencies or a new script; in pyproject.toml and
// setup.cfg only pytest's section. A test runner's own config file counts whole.

import { createHash } from "node:crypto";
import { type CriteriaChange } from "./criteria.ts";
import { type Diff, type Config } from "./scan.ts";
import { matchesAny } from "./rules.ts";

/** Test runners' config files, counted whole: added, changed, renamed away or deleted. */
export const defaultRunners = [
  "**/jest.config.*", "**/vitest.config.*", "**/vitest.workspace.*", "**/playwright.config.*", "**/cypress.config.*",
  "**/karma.conf.*", "**/.mocharc*", "**/ava.config.*", "**/jest.setup.*", "**/vitest.setup.*",
  "**/pytest.ini", "**/tox.ini", "**/conftest.py", "**/noxfile.py", "**/phpunit.xml", "**/phpunit.xml.dist", "**/.rspec",
];

/** package.json sections that are a test runner's config. */
const PACKAGE_RUNNERS = ["jest", "ava", "mocha", "vitest", "c8", "nyc"];

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);

/** A file's text before and after the change (null: not there). */
export type Reader = (file: string) => string | null;

/** pytest's section(s) of a pyproject.toml or setup.cfg, as text, or "" if there is none. */
function pytestSection(text: string | null): string {
  if (text === null) return "";
  const out: string[] = [];
  let inside = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) inside = /^(tool[.:]pytest)/.test(header[1].trim());
    if (inside && line.trim()) out.push(line.trim());
  }
  return out.join("\n");
}

/** A command with no shell control in it (no ;, |, &, redirection or substitution): it runs, and its exit
 * code is the part's. */
const PLAIN = /^[^;|&<>`$]+$/;

/** Whether AFTER only adds to BEFORE: BEFORE unchanged at its start, then more commands joined by &&. Those
 * run only once everything before them passed, so they can add a failure but never hide one. A command put
 * anywhere earlier could (it could delete the tests that run after it), so that is a change to accept. */
function extends_(before: string, after: string | undefined): boolean {
  if (after === undefined || !after.startsWith(before)) return false;
  const rest = after.slice(before.length).trim();
  if (!rest.startsWith("&&")) return false;
  return rest.slice(2).split("&&").every(p => PLAIN.test(p.trim()));
}

/** Where two commands differ, without the long part they share: "…a && b…" to "…a && x && b…". */
function difference(before: string, after: string): string {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let q = 0;
  while (q < before.length - p && q < after.length - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
  const ctx = 20;
  const cut = (t: string) => `${p > ctx ? "…" : ""}${t.slice(Math.max(0, p - ctx), t.length - q + ctx)}${q > ctx ? "…" : ""}`;
  return `${JSON.stringify(cut(before))} to ${JSON.stringify(cut(after))}`;
}

/** What in package.json decides how tests run: the existing scripts that were changed or removed (a new
 * script adds; it weakens nothing), and the runners' own sections. Null: unchanged in what matters. */
function packageChange(before: string | null, after: string | null): string | null {
  if (before === after) return null;
  type Pkg = { scripts?: Record<string, string> } & Record<string, unknown>;
  const parse = (t: string | null): Pkg | null | "unreadable" => {
    if (t === null) return null;
    try { return JSON.parse(t) as Pkg; } catch { return "unreadable"; }
  };
  const b = parse(before), a = parse(after);
  if (b === "unreadable" || a === "unreadable") return "package.json could not be read as JSON";
  const scriptsBefore = b?.scripts ?? {}, scriptsAfter = a?.scripts ?? {};
  const changed = Object.keys(scriptsBefore).filter(k => scriptsAfter[k] !== scriptsBefore[k] && !extends_(scriptsBefore[k], scriptsAfter[k]));
  const sections = PACKAGE_RUNNERS.filter(k => JSON.stringify(b?.[k] ?? null) !== JSON.stringify(a?.[k] ?? null));
  if (!changed.length && !sections.length) return null;
  return [
    ...changed.map(k => k in scriptsAfter ? `script "${k}" changed: ${difference(scriptsBefore[k], scriptsAfter[k])}`
                                          : `script "${k}" removed (was ${JSON.stringify(scriptsBefore[k])})`),
    ...sections.map(k => `the "${k}" section changed`),
  ].join("; ");
}

/** Changes to what decides which tests run, as criteria changes. BEFORE and AFTER read the files as they
 * were at the base and as the change leaves them. */
export function runnerChanges(diff: Diff, config: Config, before: Reader, after: Reader): CriteriaChange[] {
  const out: CriteriaChange[] = [];
  const isRunner = (f: string) => matchesAny(f, config.runners) && !matchesAny(f, config.exclude);
  for (const [file, status] of [...diff.status].sort((x, y) => x[0] < y[0] ? -1 : 1)) {
    const from = status === "R" ? diff.renamed.get(file) : undefined;
    // a runner's config renamed to something its runner no longer reads is a config gone
    if (from !== undefined && isRunner(from) && !isRunner(file)) {
      out.push({ file: from, kind: "runner", evidence: sha256(`${from}\n${file}`),
                 detail: `the test runner's configuration was renamed to ${file}, where it is no longer read` });
      continue;
    }
    const b = before(from ?? file), a = after(file);
    if (isRunner(file)) {
      if (b === a) continue;
      out.push({ file, kind: "runner", evidence: sha256(`${file}\n${a ?? "absent"}`),
                 detail: `the test runner's configuration (${file}) was ${a === null ? "deleted" : b === null ? "added" : "changed"}: it decides which tests run, and how` });
      continue;
    }
    if (matchesAny(file, config.exclude)) continue;
    if (base(file) === "package.json") {
      const what = packageChange(b, a);
      if (what) out.push({ file, kind: "runner", evidence: sha256(`${file}\n${what}`), detail: `what runs the tests changed: ${what}` });
    } else if (base(file) === "pyproject.toml" || base(file) === "setup.cfg") {
      const sb = pytestSection(b), sa = pytestSection(a);
      if (sb !== sa) out.push({ file, kind: "runner", evidence: sha256(`${file}\n${sa}`), detail: `pytest's section in ${file} changed: it decides which tests run` });
    }
  }
  return out;
}
