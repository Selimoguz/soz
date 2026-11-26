// guard.ts — soz-guard's own footing. The hooks that run it and the instructions that tell the agent the
// rules are as much the owner's as the tests: an agent that removes the Stop hook, sets disableAllHooks,
// or rewrites soz-guard's section in CLAUDE.md has changed what "finished" means. Such a change is a
// criteria change (kind "guard") that a person has to accept.
//
// Only the parts that matter are compared, so ordinary edits stay free: in .claude/settings.json and
// .claude/settings.local.json the "hooks" and "disableAllHooks" settings (Claude Code writes permissions
// to settings.local.json itself when the user allows a tool; those are not soz-guard's business); in
// CLAUDE.md and AGENTS.md only soz-guard's own section. settings.local.json is usually ignored by git,
// so these are read from the files themselves, not from the diff.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CriteriaChange } from "./criteria.ts";

export const MARK = "<!-- soz-guard -->";
const SETTINGS = [".claude/settings.json", ".claude/settings.local.json", ".codex/hooks.json"];
/** Codex can also hold hooks inline, or switch them off ([features] hooks = false), in its config.toml. */
const CODEX_TOML = ".codex/config.toml";
const INSTRUCTIONS = ["CLAUDE.md", "AGENTS.md"];

/** What a file's guarding part is, as text, or null if the file (or its section) is not there. */
export type GuardState = Record<string, string | null>;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** soz-guard's section of an instructions file: from the mark to the next heading after its own. */
export function sozSection(text: string): string | null {
  const t = text.replace(/\r\n?/g, "\n");
  const start = t.indexOf(MARK);
  if (start < 0) return null;
  const own = t.indexOf("\n#", start + MARK.length);                       // the section's own heading
  const next = own < 0 ? -1 : t.slice(own + 1).search(/\n#{1,6} |\n<!-- /);
  return (next < 0 ? t.slice(start) : t.slice(start, own + 1 + next)).trim();
}

/** The guarding parts of the files, read through READ (a file's text, or null if it is not there). */
export function guardState(read: (file: string) => string | null): GuardState {
  const state: GuardState = {};
  for (const f of SETTINGS) {
    const text = read(f);
    if (text === null) { state[f] = null; continue; }
    try {
      const j = JSON.parse(text) as { hooks?: unknown; disableAllHooks?: unknown };
      state[f] = JSON.stringify({ hooks: j.hooks ?? null, disableAllHooks: j.disableAllHooks ?? null });
    } catch { state[f] = `unreadable ${sha256(text)}`; }
  }
  // TOML is not parsed here: every line that mentions hooks is the guarding part, which errs on the side
  // of asking a person
  const toml = read(CODEX_TOML);
  state[CODEX_TOML] = toml === null ? null
    : toml.replace(/\r\n?/g, "\n").split("\n").map(l => l.trim()).filter(l => /hooks/.test(l)).join("\n") || null;
  for (const f of INSTRUCTIONS) {
    const text = read(f);
    state[f] = text === null ? null : sozSection(text);
  }
  return state;
}

/** soz-guard's own hook command, as init writes it: a Node (whatever its name: node, node.exe, nodejs), by full
 * path, running soz-guard's cli by full path. For Codex on Windows, which runs hooks with PowerShell, the same
 * command after PowerShell's call operator and followed by "; exit $LASTEXITCODE" (see powershellCommand). */
const OWN_COMMAND = /^\s*(?:&\s*)?(?:"[^"]+"|\S+)\s+(?:--[\w=-]+\s+)*"([^"]+[\\/]cli\.(?:ts|js))"\s+(hook|session-start|track)\s*(?:;\s*exit\s+\$LASTEXITCODE\s*)?$/i;

/** COMMAND for PowerShell, which Codex runs its hooks with on Windows. There a line that starts with a quoted
 * path is a string, not a command, so the call operator (&) runs it; and PowerShell's -Command ends with 1
 * whenever a native command fails, so the hook's own exit code (2: keep working) is passed on explicitly. */
export const powershellCommand = (command: string) => `& ${command}; exit $LASTEXITCODE`;

/** A hook command without that PowerShell wrapping: what is left names the soz-guard subcommand it runs. */
export const hookBody = (command: string) => command.trim().replace(/^&\s*/, "").replace(/;\s*exit\s+\$LASTEXITCODE\s*$/i, "").trimEnd();

/** The script and subcommand of a command as init writes it (machine paths), or null for any other command,
 * such as a portable "npx soz-guard hook". */
export function machineCommand(command: string): { script: string; sub: string } | null {
  const m = OWN_COMMAND.exec(command);
  return m ? { script: m[1], sub: m[2] } : null;
}

const norm = (p: string) => { const r = resolve(p).replace(/\\/g, "/"); return process.platform === "win32" ? r.toLowerCase() : r; };
/** This soz-guard's package folder (src/ or dist/ one level down). */
const ownPackage = norm(dirname(dirname(fileURLToPath(import.meta.url))));

/** Whether SCRIPT is this soz-guard's own cli (from its source or its build): not merely some cli.js. */
export function isThisSozGuard(script: string): boolean {
  return existsSync(script) && norm(dirname(dirname(script))) === ownPackage;
}

/** soz-guard's own commands with a path outside the repository become "soz-guard <sub>": where Node and
 * soz-guard live differs from one machine to the next, and running init on another machine, or after moving
 * them, is not a change to what counts as finished. A command whose script is inside the repository stays as
 * it is: that script is part of the change, and could be anything. With EXISTS, so does one whose script is
 * not this very soz-guard: pointing the hook at nothing, or at some other cli.js, switches it off as surely
 * as removing it. */
export function canonicalCommand(command: string, root?: string, exists = false): string {
  const m = machineCommand(command);
  if (!m) return command;
  const script = m.script.replace(/\\/g, "/");
  if (!/^([A-Za-z]:)?\//.test(script)) return command;                    // relative: inside the repository
  if (exists && !isThisSozGuard(m.script)) return command;
  if (root) {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    const inside = process.platform === "win32" ? script.toLowerCase().startsWith(r.toLowerCase()) : script.startsWith(r);
    if (inside) return command;
  }
  return `soz-guard ${m.sub}`;
}

/** A settings state with soz-guard's own commands made canonical (see canonicalCommand). */
function canonicalState(v: string | null | undefined, root?: string, exists = false): string | null | undefined {
  if (!v || !v.startsWith("{")) return v;
  try {
    const j = JSON.parse(v) as { hooks: unknown; disableAllHooks: unknown };
    const walk = (x: unknown): unknown => Array.isArray(x) ? x.map(walk)
      : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, k === "command" && typeof y === "string" ? canonicalCommand(y, root, exists) : walk(y)]))
      : x;
    return JSON.stringify({ hooks: walk(j.hooks), disableAllHooks: j.disableAllHooks });
  } catch { return v; }
}

/** Differences between two guard states, as criteria changes. A part that was not there and is not there
 * now is no change; settings that hold no hooks count as none. ROOT, the repository, tells soz-guard's own
 * commands from others (see canonicalCommand). */
export function guardChanges(before: GuardState, after: GuardState, root?: string): CriteriaChange[] {
  const none = (v: string | null | undefined) => v === null || v === undefined || v === JSON.stringify({ hooks: null, disableAllHooks: null });
  const out: CriteriaChange[] = [];
  for (const f of Object.keys(after).sort()) {
    if (before[f] === after[f]) continue;
    // where soz-guard lives may differ from before, but now it has to be there
    const settingsFile = SETTINGS.includes(f);
    const a = settingsFile ? canonicalState(before[f], root) : before[f], b = settingsFile ? canonicalState(after[f], root, true) : after[f];
    if (a === b || (none(a) && none(b))) continue;
    // soz-guard's section added where there was none only adds rules; changing or removing one is the risk
    if (INSTRUCTIONS.includes(f) && (a === null || a === undefined)) continue;
    const settings = SETTINGS.includes(f) || f === CODEX_TOML;
    const switchedOff = !!b && (b.includes('"disableAllHooks":true') || /hooks\s*=\s*false/.test(b));
    // likewise hooks added where there were none: nothing of soz-guard's was there to lose, unless the new
    // file switches hooks off
    if (settings && none(a) && !switchedOff) continue;
    const detail = settings
      ? (switchedOff ? `all hooks were switched off in ${f} (disableAllHooks)` : `the hooks in ${f} were changed: soz-guard's own may be gone`)
      : (b === null ? `soz-guard's section in ${f} was removed` : `soz-guard's section in ${f} was changed`);
    out.push({ file: f, kind: "guard", detail, evidence: sha256(`${f}\n${b ?? "absent"}`) });
  }
  return out;
}
