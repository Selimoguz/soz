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

// --- Several sessions in one folder: each answers for the files it touched ----------------------------------
//
// With several agent sessions working in the same folder, the difference from a session's baseline holds
// the other sessions' work too. A PostToolUse hook records the files a session edits (Edit, Write,
// MultiEdit, NotebookEdit name them), and for a shell command the files that changed while it ran: a
// snapshot before (PreToolUse) and after (PostToolUse). What another session changes while this one's
// command runs is counted as this one's, which errs on the side of judging more, not less.

const touchedPath = (root: string, session: string) => file(root, session).replace(/\.json$/, ".touched.json");
const pendingPath = (root: string, session: string, key: string) =>
  file(root, session).replace(/\.json$/, `.pending-${key.replace(/[^\w-]/g, "").slice(0, 80) || "shell"}.json`);

/** The files this session touched, repository-relative with forward slashes, or null if none recorded. */
export function readTouched(root: string, session: string | undefined): Set<string> | null {
  if (!session) return null;
  try {
    const p = touchedPath(root, session);
    return existsSync(p) ? new Set((JSON.parse(readFileSync(p, "utf8")) as { files: string[] }).files) : null;
  } catch { return null; }
}

/** A path from a tool's input as soz-guard names files: relative to the repository, forward slashes; null if
 * it is outside the repository. */
export function repoPath(root: string, path: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root), p = norm(isAbsolute(path) ? path : join(root, path));
  const same = process.platform === "win32" ? p.toLowerCase().startsWith(r.toLowerCase() + "/") : p.startsWith(r + "/");
  return same ? p.slice(r.length + 1) : null;
}

export function recordTouched(root: string, session: string, files: string[]) {
  const have = readTouched(root, session) ?? new Set<string>();
  const before = have.size;
  for (const f of files) have.add(f);
  if (have.size === before && existsSync(touchedPath(root, session))) return;
  mkdirSync(join(root, OWN_DIR, SESSIONS), { recursive: true });
  writeFileSync(touchedPath(root, session), JSON.stringify({ files: [...have].sort() }, null, 2) + "\n");
}

/** Before a shell command: the working tree as it is. */
export function beforeShell(root: string, session: string, key: string, exclude: string[]) {
  mkdirSync(join(root, OWN_DIR, SESSIONS), { recursive: true });
  writeFileSync(pendingPath(root, session, key), JSON.stringify({ tree: snapshotTree(root, exclude) }) + "\n");
}

/** After it: the files that changed while it ran are this session's. */
export function afterShell(root: string, session: string, key: string, exclude: string[]): string[] {
  const p = pendingPath(root, session, key);
  if (!existsSync(p)) { recordTouched(root, session, []); return []; }
  let before: string;
  try { before = (JSON.parse(readFileSync(p, "utf8")) as { tree: string }).tree; } finally { rmSync(p, { force: true }); }
  const after = snapshotTree(root, exclude);
  const files = before === after ? [] : git(root, ["-c", "core.quotepath=false", "diff-tree", "-r", "--name-only", "--no-renames", before, after])
    .split("\n").filter(Boolean);
  recordTouched(root, session, files);
  return files;
}

export { CONFIG_FILE };

// --- The line a session starts with, in front of the person ------------------------------------------------
//
// The SessionStart hook gives the line to the person as Claude Code's systemMessage, but not every app shows
// it: the desktop app keeps it in the transcript and shows nothing. What every app shows is the agent's own
// reply. So the agent is told to start its first reply with the line, and the Stop hook looks in the
// transcript for it: once it is there, the person has seen it; if it is not, the agent is stopped once and
// told to write it. Whether it was shown is logged, so that it can be checked, not believed.

const linePath = (root: string, session: string) => file(root, session).replace(/\.json$/, ".line.json");
type SessionLine = { line: string; shown: boolean; asked: boolean };

/** At a session's start (and again after a resume or compaction): the line the person is to see. A new
 * line, after the setup changed, is to be shown again. */
export function recordSessionLine(root: string, session: string, line: string) {
  const had = readSessionLine(root, session);
  if (had && had.line === line) return;
  mkdirSync(join(root, OWN_DIR, SESSIONS), { recursive: true });
  writeFileSync(linePath(root, session), JSON.stringify({ line, shown: false, asked: false }, null, 2) + "\n");
}

export function readSessionLine(root: string, session: string | undefined): SessionLine | null {
  if (!session) return null;
  try { return existsSync(linePath(root, session)) ? JSON.parse(readFileSync(linePath(root, session), "utf8")) as SessionLine : null; }
  catch { return null; }
}

export function markSessionLine(root: string, session: string, change: Partial<SessionLine>) {
  const had = readSessionLine(root, session);
  if (had) writeFileSync(linePath(root, session), JSON.stringify({ ...had, ...change }, null, 2) + "\n");
}

/** The agent's replies in a transcript: Claude Code's (type "assistant", text blocks) and Codex's (assistant
 * messages, output_text; agent_message events). Hooks' own records are not the agent's words and are left out. */
export function agentReplies(transcript: string): string[] {
  const out: string[] = [];
  const texts = (content: unknown) => {
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content)) for (const c of content)
      if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          && ["text", "output_text"].includes((c as { type?: string }).type ?? "")) out.push((c as { text: string }).text);
  };
  for (const raw of transcript.split("\n")) {
    if (!raw.trim()) continue;
    let o: Record<string, any>;
    try { o = JSON.parse(raw); } catch { continue; }
    if (o?.type === "assistant" && o.message?.role === "assistant") texts(o.message.content);
    const p = o?.payload;
    if (p?.type === "message" && p.role === "assistant") texts(p.content);
    if (p?.type === "agent_message" && typeof p.message === "string") out.push(p.message);
  }
  return out;
}

/** The app that writes a Codex transcript, as its first record (session_meta) names it ("Codex Desktop" for
 * the desktop app); null for any other transcript, or none yet. Read when a session starts, while the
 * transcript is still short. */
export function codexOriginator(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null;
  let text: string;
  try { text = readFileSync(transcriptPath, "utf8"); } catch { return null; }   // no transcript (yet): no app named
  const end = text.indexOf("\n");
  try {
    const o = JSON.parse(end < 0 ? text : text.slice(0, end)) as { type?: string; payload?: { originator?: unknown } };
    return o.type === "session_meta" && typeof o.payload?.originator === "string" ? o.payload.originator : null;
  } catch { return null; }                                       // not a Codex transcript
}

/** Whether LINE is in one of the agent's replies (or in its LAST message, which a hook may be given before the
 * transcript has it). Spaces and line breaks do not count, so that a wrapped or quoted line is still the line. */
export function lineInReplies(line: string, transcriptPath: string | undefined, last: string | undefined): boolean {
  const flat = (s: string) => s.replace(/[\s>*`"_]+/g, " ").trim();
  const want = flat(line);
  const replies = last ? [last] : [];
  if (transcriptPath) { try { replies.push(...agentReplies(readFileSync(transcriptPath, "utf8"))); } catch { /* no transcript: only LAST counts */ } }
  return replies.some(r => flat(r).includes(want));
}
