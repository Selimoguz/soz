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

/** Differences between two guard states, as criteria changes. A part that was not there and is not there
 * now is no change; settings that hold no hooks count as none. */
export function guardChanges(before: GuardState, after: GuardState): CriteriaChange[] {
  const none = (v: string | null | undefined) => v === null || v === undefined || v === JSON.stringify({ hooks: null, disableAllHooks: null });
  const out: CriteriaChange[] = [];
  for (const f of Object.keys(after).sort()) {
    const a = before[f], b = after[f];
    if (a === b || (none(a) && none(b))) continue;
    // soz-guard's section added where there was none only adds rules; changing or removing one is the risk
    if (INSTRUCTIONS.includes(f) && (a === null || a === undefined)) continue;
    const settings = SETTINGS.includes(f) || f === CODEX_TOML;
    const detail = settings
      ? (b && (b.includes('"disableAllHooks":true') || /hooks\s*=\s*false/.test(b)) ? `all hooks were switched off in ${f} (disableAllHooks)` : `the hooks in ${f} were changed: soz-guard's own may be gone`)
      : (b === null ? `soz-guard's section in ${f} was removed` : `soz-guard's section in ${f} was changed`);
    out.push({ file: f, kind: "guard", detail, evidence: sha256(`${f}\n${b ?? "absent"}`) });
  }
  return out;
}
