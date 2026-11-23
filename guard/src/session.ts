// session.ts — Only what the agent changed. At the start of a session soz-guard records the working tree
// as it is (tracked and untracked files, as git would see them) as a git tree; when the agent tries to
// finish, the verdict is about the difference between that tree and the working tree now. Work that was
// already uncommitted before the session, someone else's or an earlier agent's, is not this agent's.
//
// The snapshot is made with a copy of git's index (GIT_INDEX_FILE), so the working tree, the real index
// and the branch are never touched; git only stores the files' contents as objects, as `git stash` does.
// Limit: changes a person makes in the same folder while the agent works are counted as the agent's.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { CONFIG_FILE, OWN_DIR, excludesConfig } from "./scan.ts";
import { type GuardState, guardState } from "./guard.ts";

const SESSIONS = "sessions";
const KEEP_DAYS = 14;

const git = (root: string, args: string[], env?: Record<string, string | undefined>) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
                               env: env ? { ...process.env, ...env } : undefined }).trim();

/** The working tree as a git tree id, without touching the working tree or the real index. EXCLUDE (globs)
 * is left out, like soz-guard's own folder; soz-guard's config file never is. */
export function snapshotTree(root: string, exclude: string[]): string {
  mkdirSync(join(root, OWN_DIR), { recursive: true });
  const tmp = join(root, OWN_DIR, `index-${process.pid}-${Date.now()}`);
  try {
    // a copy of the real index keeps git's file stat cache: only files that changed are read again
    const real = git(root, ["rev-parse", "--git-path", "index"]);
    const realPath = isAbsolute(real) ? real : join(root, real);
    if (existsSync(realPath)) copyFileSync(realPath, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    const paths = ["--", ".", ...exclude.filter(g => !excludesConfig(g)).map(g => `:(exclude,glob)${g}`)];
    // excluded paths that are tracked stay as the index has them; untracked ones are not added
    git(root, ["add", "-A", ...paths], env);
    // soz-guard's own folder is never part of the project. It is taken out afterwards rather than excluded
    // by name: git refuses a pathspec that names a path its .gitignore ignores, even to exclude it.
    git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", OWN_DIR], env);
    return git(root, ["write-tree"], env);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** TREE: the working tree at the start; GUARD: the hooks and soz-guard's instructions then (guard.ts). */
type Baseline = { tree: string; at: string; source: string; guard?: GuardState };

const file = (root: string, session: string) => join(root, OWN_DIR, SESSIONS, `${session.replace(/[^\w-]/g, "")}.json`);

export function readBaseline(root: string, session: string | undefined): Baseline | null {
  if (!session) return null;
  try { return existsSync(file(root, session)) ? JSON.parse(readFileSync(file(root, session), "utf8")) as Baseline : null; }
  catch { return null; }
}

/** At a session's start: record its baseline, unless it has one (a resumed session keeps its own). */
export function startSession(root: string, session: string, exclude: string[], source = "startup"): Baseline {
  const existing = readBaseline(root, session);
  if (existing) return existing;
  const read = (f: string) => existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null;
  const baseline = { tree: snapshotTree(root, exclude), at: new Date().toISOString(), source, guard: guardState(read) };
  mkdirSync(join(root, OWN_DIR, SESSIONS), { recursive: true });
  writeFileSync(file(root, session), JSON.stringify(baseline, null, 2) + "\n");
  pruneSessions(root);
  return baseline;
}

/** Baselines of sessions older than KEEP_DAYS are dropped. */
function pruneSessions(root: string) {
  const dir = join(root, OWN_DIR, SESSIONS);
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* gone already */ }
  }
}

export { CONFIG_FILE };
