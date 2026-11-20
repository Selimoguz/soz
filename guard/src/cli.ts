#!/usr/bin/env node
// cli.ts — soz-guard: unfinished work, said out loud.
//
//   soz-guard scan [--json] [--base REF]   what changed, scanned; exit 1 if anything is unfinished
//   soz-guard hook                          a Claude Code Stop hook (reads the hook's JSON on stdin)
//   soz-guard init [DIR]                    installs the hook, a .soz-guard.json and a CLAUDE.md section

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scan, report, repoRoot, CONFIG_FILE, type Finding } from "./scan.ts";

const self = fileURLToPath(import.meta.url);
const here = dirname(self);
const MARK = "<!-- soz-guard -->";

/** How to run this very file again from anywhere: this Node, by full path (a desktop app's PATH may
 * not have node), with type stripping only when running the TypeScript source rather than the
 * compiled package. */
const selfCommand = (sub: string) =>
  `"${process.execPath}" ${self.endsWith(".ts") ? "--experimental-strip-types --disable-warning=ExperimentalWarning " : ""}"${self}" ${sub}`;
const isOurHook = (command: string | undefined) =>
  !!command && (command.includes(self) || /soz-guard/.test(command) || /cli\.(ts|js)" hook$/.test(command));

function hookMessage(findings: Finding[], attempt: number, max: number): string {
  return `soz-guard: you are about to finish, but your changes leave work unfinished without saying so:
${report(findings)}

Finish these. If one really has to stay unfinished, keep it, add "soz-guard: ignore <why>" to that line,
and tell the user what is left and why. Do not hide it. (check ${attempt} of ${max})`;
}

/** Claude Code Stop hook. Exit 2 with a message on stderr makes Claude continue instead of stopping. */
function hook(): number {
  let input: { cwd?: string; session_id?: string } = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no input: use the current folder */ }
  const dir = input.cwd ?? process.cwd();
  if (!repoRoot(dir)) return 0;                                   // not a git repository: nothing to compare
  const { findings, config } = scan(dir);
  const stateFile = join(tmpdir(), `soz-guard-${(input.session_id ?? "default").replace(/[^\w-]/g, "")}.json`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) as { blocks: number } : { blocks: 0 };
  if (findings.length === 0) { writeFileSync(stateFile, JSON.stringify({ blocks: 0 })); return 0; }
  state.blocks++;
  writeFileSync(stateFile, JSON.stringify(state));
  if (state.blocks <= config.maxBlocks) {
    process.stderr.write(hookMessage(findings, state.blocks, config.maxBlocks) + "\n");
    return 2;
  }
  // Stopped enough times: let the agent finish, but tell the person what is still unfinished.
  writeFileSync(stateFile, JSON.stringify({ blocks: 0 }));
  process.stdout.write(JSON.stringify({
    systemMessage: `soz-guard: ${findings.length} unfinished item(s) remain after ${config.maxBlocks} checks:\n${report(findings)}`,
  }) + "\n");
  return 0;
}

function init(dir: string): number {
  const root = repoRoot(dir);
  if (!root) {
    process.stderr.write(`${dir} is not a git repository.\n`
      + `soz-guard is set up per project and looks at what changed, so run init inside your project's folder:\n`
      + `  cd path/to/your/project\n  ${selfCommand("init")}\n`
      + `(A project that is not under git yet: git init there first.)\n`);
    return 1;
  }
  const done: string[] = [];

  const settingsPath = join(root, ".claude", "settings.json");
  let settings: { hooks?: { Stop?: { hooks: { type: string; command: string }[] }[] } } = {};
  if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf8"));   // a broken file stops here, untouched
  const command = selfCommand("hook");
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  if (settings.hooks.Stop.some(m => m.hooks?.some(h => isOurHook(h.command))))
    done.push(".claude/settings.json: the Stop hook is already there");
  else {
    settings.hooks.Stop.push({ hooks: [{ type: "command", command }] });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    done.push(".claude/settings.json: Stop hook added");
  }

  const configPath = join(root, CONFIG_FILE);
  if (existsSync(configPath)) done.push(`${CONFIG_FILE}: already there`);
  else {
    writeFileSync(configPath, JSON.stringify({ disable: [], exclude: [], maxBlocks: 3, rules: [] }, null, 2) + "\n");
    done.push(`${CONFIG_FILE}: created (switch rules off, skip paths, add your own rules)`);
  }

  const claudeMd = join(root, "CLAUDE.md");
  const current = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
  if (current.includes(MARK)) done.push("CLAUDE.md: the soz-guard section is already there");
  else {
    const section = readFileSync(join(here, "..", "templates", "CLAUDE.md"), "utf8");
    writeFileSync(claudeMd, (current ? current.replace(/\s*$/, "\n\n") : "") + section);
    done.push(current ? "CLAUDE.md: soz-guard section appended" : "CLAUDE.md: created");
  }
  process.stdout.write(`soz-guard set up in ${root}\n${done.map(d => "  " + d).join("\n")}\n`);
  return 0;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "hook") return hook();
  if (cmd === "init") return init(rest[0] ?? process.cwd());
  if (cmd === "scan" || cmd === undefined) {
    const json = rest.includes("--json");
    const b = rest.indexOf("--base");
    const { root, findings } = scan(process.cwd(), b >= 0 ? rest[b + 1] : "HEAD");
    if (json) process.stdout.write(JSON.stringify({ root, findings }, null, 2) + "\n");
    else process.stdout.write(findings.length ? `Unfinished work in what changed:\n${report(findings)}\n` : "Nothing unfinished in what changed.\n");
    return findings.length ? 1 : 0;
  }
  process.stderr.write("usage: soz-guard [scan [--json] [--base REF] | hook | init [DIR]]\n");
  return 2;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  // Never a silent failure, and never one that traps the agent: report it and exit 1 (a hook error
  // Claude Code shows to the person without blocking).
  process.stderr.write(`soz-guard: ${(e as Error).message}\n`);
  process.exit(1);
}
