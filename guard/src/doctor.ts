// doctor.ts — what this setup guards, right now. Read-only: it reads the project's .soz-guard.json, the agent
// tools' hook settings, soz-guard's own log and, when it can reach it, the server's gate; it changes nothing.
//
//   diagnose(dir)      everything, as data
//   doctorText(d)      the detail, for  soz-guard doctor
//   sessionLine(d)     the one line a session starts with (the SessionStart hook shows it to the person and the agent)
//
// The difference it exists for: a project that has a test command does not mean soz-guard runs it. Only the checks
// in .soz-guard.json run when the agent tries to finish; the rest is a test the project has and nobody runs here.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { CONFIG_FILE, OWN_DIR, parseConfig, defaultCriteria, type Check, type Config } from "./scan.ts";
import { defaultRunners } from "./runners.ts";
import { machineCommand, isThisSozGuard } from "./guard.ts";
import { gateDir, readConfig as readGateConfig } from "./gate.ts";

export type HookState = "on" | "missing" | "elsewhere" | "off";
export type AgentHook = { tool: "claude" | "codex" | "git"; where: string; start: HookState; stop: HookState; detail?: string };
export type SeenGate = { seen: true; where: string; installed: boolean; branches: string[]; requireTask: boolean; package: string; build: string };
export type Gate = { seen: false; why: "no-remote" | "other-machine" | "unreadable"; remote?: string } | SeenGate;
export type Diagnosis = {
  root: string;
  /** .soz-guard.json is there (without it, the defaults hold and no check runs) */
  configFile: boolean;
  configError: string | null;
  checks: Check[];
  /** test commands the project has that no check in .soz-guard.json runs, with where they were found */
  unwired: { command: string; from: string }[];
  rules: { active: string[]; own: { id: string; message: string }[]; off: string[] };
  /** what counts as a change to the tests or rules: the defaults, and the project's own additions */
  testChanges: { own: string[]; ownRunners: string[]; mode: "block" | "report"; assertions: "fewer" | "any-change" };
  hooks: AgentHook[];
  lastRun: { at: string; what: string } | null;
  gate: Gate;
};

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd: string, args: string[]): string | null => { try { return git(cwd, args); } catch { return null; } };
const readText = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const readJson = <T>(p: string): T | null => { const t = readText(p); if (t === null) return null; try { return JSON.parse(t) as T; } catch { return null; } };

// --- The checks, and the test commands the project has --------------------------------------------------------

/** The test commands a project of this kind usually has, and how to tell that a check runs one. */
function projectTests(root: string): { command: string; from: string; runs: (check: string) => boolean }[] {
  const found: { command: string; from: string; runs: (c: string) => boolean }[] = [];
  const pkg = readJson<{ scripts?: Record<string, string> }>(join(root, "package.json"));
  for (const [name, script] of Object.entries(pkg?.scripts ?? {})) {
    if (!/^test($|:)/.test(name) || /no test specified/.test(script)) continue;
    const command = name === "test" ? "npm test" : `npm run ${name}`;
    const words = name === "test" ? /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)\b(?!:)/ : new RegExp(`\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    found.push({ command, from: "package.json", runs: c => words.test(c) });
  }
  const has = (f: string) => existsSync(join(root, f));
  const any = (re: RegExp) => { try { return readdirSync(root).some(f => re.test(f)); } catch { return false; } };
  if (has("pom.xml")) found.push({ command: "mvn test", from: "pom.xml", runs: c => /\bmvnw?\b.*\b(test|verify|package|install)\b/.test(c) });
  if (has("build.gradle") || has("build.gradle.kts")) found.push({ command: "gradle test", from: has("build.gradle") ? "build.gradle" : "build.gradle.kts", runs: c => /\bgradlew?\b.*\b(test|check|build)\b/.test(c) });
  const pyproject = readText(join(root, "pyproject.toml")) ?? "";
  if (has("pytest.ini") || /\[tool\.pytest/.test(pyproject)) found.push({ command: "pytest", from: has("pytest.ini") ? "pytest.ini" : "pyproject.toml", runs: c => /\bpytest\b/.test(c) });
  if (has("go.mod")) found.push({ command: "go test ./...", from: "go.mod", runs: c => /\bgo\s+test\b/.test(c) });
  if (any(/\.(sln|csproj)$/)) found.push({ command: "dotnet test", from: "*.sln / *.csproj", runs: c => /\bdotnet\s+test\b/.test(c) });
  return found;
}

// --- The agent tools' hooks -------------------------------------------------------------------------------------

type HookList = { matcher?: string; hooks?: { command?: string }[] }[];
const isOurs = (sub: string) => (c: string) => (/soz-guard/.test(c) || /cli\.(ts|js)"/.test(c)) && c.trimEnd().endsWith(` ${sub}`);

/** The state of soz-guard's SUB hook in LISTS: there and runnable here, pointing at a soz-guard that is not on this
 * machine, or missing. */
function hookState(lists: (HookList | undefined)[], sub: string): HookState {
  const commands = lists.flatMap(l => (l ?? []).flatMap(m => (m.hooks ?? []).map(h => h.command ?? ""))).filter(isOurs(sub));
  if (!commands.length) return "missing";
  // a command written by hand (npx soz-guard hook) finds soz-guard itself; init's own command names a file
  return commands.some(c => { const m = machineCommand(c); return !m || existsSync(m.script); }) ? "on" : "elsewhere";
}

function agentHooks(root: string): AgentHook[] {
  const out: AgentHook[] = [];
  const files = [".claude/settings.json", ".claude/settings.local.json"];
  const settings = files.map(f => ({ f, j: readJson<{ hooks?: Record<string, HookList>; disableAllHooks?: boolean }>(join(root, f)) }));
  const user = readJson<{ disableAllHooks?: boolean }>(join(homedir(), ".claude", "settings.json"));
  const where = settings.filter(s => s.j && Object.values(s.j.hooks ?? {}).flat().some(m => (m.hooks ?? []).some(h => /soz-guard|cli\.(ts|js)"/.test(h.command ?? ""))))
                        .map(s => s.f);
  const off = settings.find(s => s.j?.disableAllHooks === true)?.f ?? (user?.disableAllHooks === true ? "~/.claude/settings.json" : undefined);
  const claude: AgentHook = {
    tool: "claude", where: where.join(", ") || ".claude/settings.local.json",
    start: hookState(settings.map(s => s.j?.hooks?.SessionStart), "session-start"),
    stop: hookState(settings.map(s => s.j?.hooks?.Stop), "hook"),
  };
  if (off) { claude.start = claude.stop = "off"; claude.detail = off; }
  else if (claude.stop === "elsewhere" || claude.start === "elsewhere") {
    const all = settings.flatMap(s => Object.values(s.j?.hooks ?? {}).flat().flatMap(m => (m.hooks ?? []).map(h => h.command ?? "")));
    claude.detail = all.map(c => machineCommand(c)?.script).find(s => s && !existsSync(s));
  } else if (claude.stop === "on") {
    // init's command names this machine's soz-guard: another copy on this machine works, but is not this one
    const other = settings.flatMap(s => (s.j?.hooks?.Stop ?? []).flatMap(m => (m.hooks ?? []).map(h => h.command ?? "")))
      .map(c => machineCommand(c)?.script).find(s => s && existsSync(s) && !isThisSozGuard(s));
    if (other) claude.detail = other;
  }
  out.push(claude);
  const codexFile = join(root, ".codex", "hooks.json");
  if (existsSync(codexFile)) {
    const j = readJson<{ hooks?: Record<string, HookList> }>(codexFile);
    const toml = readText(join(root, ".codex", "config.toml")) ?? "";
    const codex: AgentHook = { tool: "codex", where: ".codex/hooks.json",
      start: hookState([j?.hooks?.SessionStart], "session-start"), stop: hookState([j?.hooks?.Stop], "hook") };
    if (/^\s*(codex_)?hooks\s*=\s*false/m.test(toml)) { codex.start = codex.stop = "off"; codex.detail = ".codex/config.toml"; }
    out.push(codex);
  }
  const hooksDir = tryGit(root, ["rev-parse", "--git-path", "hooks"]);
  if (hooksDir) {
    const f = join(isAbsolute(hooksDir) ? hooksDir : join(root, hooksDir), "pre-commit");
    const text = readText(f);
    if (text !== null && /soz-guard|cli\.(ts|js)/.test(text) && /pre-commit/.test(text)) {
      const runs = /pre-commit --checks/.test(text);
      out.push({ tool: "git", where: ".git/hooks/pre-commit", start: "missing", stop: "on", detail: runs ? "checks" : "no-checks" });
    }
  }
  return out;
}

/** When a hook of soz-guard's last ran in this project, from its log. */
function lastRun(root: string): { at: string; what: string } | null {
  const text = readText(join(root, OWN_DIR, "log.jsonl"));
  if (!text) return null;
  const lines = text.split("\n").filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as { event?: string; at?: string };
      if ((e.event === "hook" || e.event === "session-start" || e.event === "pre-commit") && e.at) return { at: e.at, what: e.event };
    } catch { continue; }                                         // a damaged line: soz-guard log --verify says where
  }
  return null;
}

// --- The server's gate ------------------------------------------------------------------------------------------

/** A remote's URL as a folder on this machine, or null when it is on another machine. */
function localRemote(root: string, url: string): string | null {
  if (/^file:\/\//i.test(url)) return url.replace(/^file:\/\/(\/(?=[a-zA-Z]:))?/i, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;          // https://, ssh://, git://
  if (/^[^\\/]+:/.test(url) && !/^[a-zA-Z]:[\\/]/.test(url)) return null;   // git@host:path
  return isAbsolute(url) ? url : resolve(root, url);
}

function gateFor(gitDir: string, where: string): SeenGate {
  const config = readGateConfig(gitDir);
  const hooksDir = tryGit(gitDir, ["rev-parse", "--git-path", "hooks"]) ?? "hooks";
  const hook = readText(join(isAbsolute(hooksDir) ? hooksDir : join(gitDir, hooksDir), "pre-receive")) ?? "";
  return { seen: true, where, installed: existsSync(join(gateDir(gitDir), "config.json")) && /soz-guard/.test(hook) && /gate pre-receive/.test(hook),
           branches: config.branches, requireTask: config.requireTask, package: config.package, build: config.build };
}

function serverGate(root: string): Gate {
  const upstream = tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const remote = upstream?.split("/")[0] || (tryGit(root, ["remote"])?.split("\n").find(r => r === "origin") ?? tryGit(root, ["remote"])?.split("\n")[0]);
  const url = remote ? tryGit(root, ["remote", "get-url", remote]) : null;
  if (!url) return { seen: false, why: "no-remote" };
  const folder = localRemote(root, url);
  if (!folder) return { seen: false, why: "other-machine", remote: url };
  const gitDir = existsSync(folder) && statSync(folder).isDirectory() ? tryGit(folder, ["rev-parse", "--absolute-git-dir"]) : null;
  if (!gitDir) return { seen: false, why: "unreadable", remote: url };
  return gateFor(gitDir, url);
}

// --- All of it --------------------------------------------------------------------------------------------------

export function diagnose(dir: string): Diagnosis {
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  const text = readText(join(root, CONFIG_FILE));
  let config: Config, configError: string | null = null;
  try { config = parseConfig(text); } catch (e) { configError = (e as Error).message; config = parseConfig(null); }
  // the project's own additions, as written (parseConfig adds them to the defaults)
  const raw = (text && !configError ? JSON.parse(text) : {}) as { criteria?: string[]; runners?: string[]; rules?: { id: string; message: string }[] };
  const checkRuns = config.checks.map(c => c.run);
  return {
    root, configFile: text !== null, configError,
    checks: config.checks,
    unwired: projectTests(root).filter(t => !checkRuns.some(t.runs)).map(({ command, from }) => ({ command, from })),
    rules: { active: config.rules.filter(r => !config.disable.includes(r.id)).map(r => r.id),
             own: (raw.rules ?? []).filter(r => !config.disable.includes(r.id)).map(r => ({ id: r.id, message: r.message })),
             off: config.disable },
    testChanges: { own: (raw.criteria ?? []).filter(c => !defaultCriteria.includes(c)), ownRunners: (raw.runners ?? []).filter(r => !defaultRunners.includes(r)),
                   mode: config.criteriaChanges, assertions: config.assertions },
    hooks: agentHooks(root),
    lastRun: lastRun(root),
    gate: serverGate(root),
  };
}

/** The diagnosis of a server repository (a bare one, where the gate lives): only its gate. */
export function diagnoseServer(dir: string): SeenGate | null {
  if (tryGit(dir, ["rev-parse", "--is-bare-repository"]) !== "true") return null;
  return gateFor(git(dir, ["rev-parse", "--absolute-git-dir"]), dir);
}

// --- In words ---------------------------------------------------------------------------------------------------

/** Turkish where the machine speaks it (or SOZ_GUARD_LANG=tr), English otherwise. */
export function language(): "tr" | "en" {
  const set = (process.env.SOZ_GUARD_LANG ?? "").toLowerCase();
  if (set === "tr" || set === "en") return set;
  try { return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("tr") ? "tr" : "en"; } catch { return "en"; }
}

const when = (c: Check, tr: boolean) => c.when?.length ? (tr ? `yalnızca ${c.when.join(", ")} değişince` : `only when ${c.when.join(", ")} changed`)
                                                     : (tr ? "her değişiklikte" : "on any change");
const ownWatched = (d: Diagnosis) => [...d.testChanges.ownRunners, ...d.testChanges.own];

/** What the gate guards, in a few words. */
function gateWords(g: Gate, tr: boolean, short: boolean): string {
  if (!g.seen) {
    if (short) return tr ? "Sunucudaki soz-guard gate: buradan doğrulanamadı" : "soz-guard gate on the server: not verified from here";
    return g.why === "no-remote"
      ? (tr ? "doğrulanamadı: bu projenin bir uzak deposu (remote) yok, push'u denetleyen bir soz-guard gate de yok."
            : "not verified: this project has no remote, so no soz-guard gate judges a push.")
      : (tr ? `buradan doğrulanamadı: ${g.remote} bu makineden okunamıyor. Orada soz-guard gate kuruluysa ne koruduğunu sunucuda görürsünüz:\n    soz-guard gate log --last 20`
            : `not verified from here: ${g.remote} cannot be read from this machine. If soz-guard gate is set up there, the server shows what it guards:\n    soz-guard gate log --last 20`);
  }
  if (!g.installed) return short ? (tr ? "Sunucudaki soz-guard gate: kurulu değil" : "soz-guard gate on the server: none")
    : (tr ? `yok: ${g.where} deposunda soz-guard gate kurulu değil; push'lar denetlenmeden girer.`
          : `none: the repository ${g.where} has no soz-guard gate; pushes go in unjudged.`);
  const parts = [tr ? `${g.branches.join(", ")} korunuyor` : `${g.branches.join(", ")} protected`];
  if (g.requireTask) parts.push(tr ? "yalnızca görev teslimi" : "task deliveries only");
  if (g.package) parts.push(tr ? `paket: ${g.package}` : `package: ${g.package}`);
  return short ? `${tr ? "Sunucudaki soz-guard gate" : "soz-guard gate on the server"}: ${parts.join(", ")}` : `${parts.join("; ")} (${g.where})`;
}

/** The one line a session starts with: what runs when the agent tries to finish, what is watched, and the gate.
 * Something that keeps soz-guard from running at all comes first. */
export function sessionLine(d: Diagnosis, lang = language()): string {
  const tr = lang === "tr";
  const parts: string[] = [];
  const claude = d.hooks.find(h => h.tool === "claude");
  if (d.configError) parts.push(tr ? `.soz-guard.json okunamıyor: ${d.configError}` : `.soz-guard.json cannot be read: ${d.configError}`);
  if (claude && claude.start === "on" && claude.stop !== "on")
    parts.push(tr ? "Bitiş kancası çalışmıyor: iş bitiminde hiçbir şey denetlenmez (soz-guard doctor)"
                  : "The finish hook does not run: nothing is judged when the agent finishes (soz-guard doctor)");
  if (d.checks.length) parts.push(`${tr ? "Tamamlanırken çalışacak" : "Runs when the agent finishes"}: ${d.checks.map(c => c.holdout ? `${c.name} (${tr ? "gizli" : "holdout"})` : c.name).join(", ")}`);
  else parts.push(tr ? "Tamamlanırken çalıştırılacak proje testi tanımlı değil" : "No project test is set to run when the agent finishes");
  if (d.unwired.length) parts.push(`${d.unwired.map(u => u.command).join(", ")}: ${tr ? "projede var, soz-guard çalıştırmıyor" : "in the project, not run by soz-guard"}`);
  if (!d.checks.length) {
    // nothing runs: what still holds is the rules on the changed lines and on the tests themselves
    parts.push(`${tr ? "Kod kuralları" : "Code rules"}: ${d.rules.active.length}${d.rules.own.length ? (tr ? ` (${d.rules.own.length} projeye özel)` : ` (${d.rules.own.length} the project's own)`) : ""}`);
    const own = ownWatched(d);
    parts.push(tr ? `Test değişikliği izleniyor: test dosyaları${own.length ? ", " + own.join(", ") : ""}`
                  : `Changes to tests watched: test files${own.length ? ", " + own.join(", ") : ""}`);
  }
  parts.push(gateWords(d.gate, tr, true));
  return `soz-guard · ${parts.join(" · ")}`;
}

/** For the agent, after the line: what the line means for its work. */
export function sessionContext(d: Diagnosis, lang = language()): string {
  const tr = lang === "tr";
  return `${sessionLine(d, lang)}\n` + (tr
    ? "Bu satırı kullanıcı da gördü. İşini bitirmek istediğinde soz-guard yukarıdakileri denetler; tanımlı test yoksa testleri sen çalıştır ve sonucunu söyle. "
      + "\"Sunucudaki soz-guard gate\", soz-guard'ın sunucuda push'u denetleyen kısmıdır; \"buradan doğrulanamadı\" onun bu makineden okunamadığını söyler, projenin kendi betikleriyle ilgisi yoktur. "
      + "Kullanıcı soz-guard'ın neyi koruduğunu sorarsa: soz-guard doctor."
    : "The user saw this line too. When you try to finish, soz-guard judges the above; with no test set, run the tests yourself and say how they went. "
      + "\"soz-guard gate on the server\" is the part of soz-guard that judges pushes on the server; \"not verified from here\" says it cannot be read from this machine, and has nothing to do with the project's own scripts. "
      + "If the user asks what soz-guard guards: soz-guard doctor.");
}

const HOOK_WORDS = {
  tr: { on: "açık", missing: "yok", elsewhere: "bu makinede olmayan bir soz-guard'ı gösteriyor", off: "kancalar kapatılmış" },
  en: { on: "on", missing: "missing", elsewhere: "points at a soz-guard that is not on this machine", off: "hooks switched off" },
};

/** soz-guard doctor: the detail. */
export function doctorText(d: Diagnosis, lang = language()): string {
  const tr = lang === "tr";
  const out: string[] = [];
  const h = (title: string) => out.push("", title);
  out.push(`soz-guard doctor: ${d.root}`, tr ? "(yalnızca okur, hiçbir şeyi değiştirmez)" : "(read-only: it changes nothing)");
  if (!d.configFile) out.push(tr ? `${CONFIG_FILE} yok: varsayılan kurallar geçerli, hiçbir test çalışmaz. Kurmak için: soz-guard init --local`
                                 : `No ${CONFIG_FILE}: the default rules hold, no test runs. To set it up: soz-guard init --local`);
  if (d.configError) out.push(tr ? `! ${CONFIG_FILE} okunamıyor, varsayılanlar gösteriliyor: ${d.configError}` : `! ${CONFIG_FILE} cannot be read; the defaults are shown: ${d.configError}`);

  h(tr ? "Tamamlanırken çalışacak testler (.soz-guard.json \"checks\")" : "Run when the agent finishes (.soz-guard.json \"checks\")");
  if (!d.checks.length) out.push(tr ? "  Tamamlanırken çalıştırılacak proje testi tanımlı değil." : "  No project test is set to run when the agent finishes.");
  for (const c of d.checks) out.push(`  ${c.name}: ${c.holdout ? (tr ? "(gizli test, komutu ajana gösterilmez)" : "(holdout: its command is not shown to the agent)") : c.run}  (${when(c, tr)})`);
  for (const u of d.unwired) out.push(tr
    ? `  ! ${u.from} içinde "${u.command}" var, ama .soz-guard.json'da zorunlu kontrol değil: soz-guard onu çalıştırmaz.\n    Bağlamak için .soz-guard.json'daki "checks" listesine: {"name": "tests", "run": "${u.command}"}`
    : `  ! ${u.from} has "${u.command}", but it is not a required check in .soz-guard.json: soz-guard does not run it.\n    To run it, add to "checks" in .soz-guard.json: {"name": "tests", "run": "${u.command}"}`);

  h(tr ? "Kod kuralları (değişen satırlarda)" : "Code rules (on the changed lines)");
  const builtIn = d.rules.active.filter(id => !d.rules.own.some(r => r.id === id));
  out.push(`  ${tr ? "Yerleşik" : "Built in"} (${builtIn.length}): ${builtIn.join(", ")}`);
  if (d.rules.own.length) out.push(`  ${tr ? "Projeye özel" : "The project's own"} (${d.rules.own.length}): ${d.rules.own.map(r => `${r.id} (${r.message})`).join("; ")}`);
  if (d.rules.off.length) out.push(`  ${tr ? "Kapatılmış" : "Switched off"}: ${d.rules.off.join(", ")}`);

  h(tr ? "Test değişikliği kuralları" : "Rules on changes to the tests");
  out.push(tr
    ? `  Test dosyaları, CI ayarları ve ${CONFIG_FILE}: silmek ya da ${d.testChanges.assertions === "any-change" ? "var olan bir assertion'ı değiştirmek" : "assertion sayısını azaltmak"} ${d.testChanges.mode === "block" ? "kişinin onayını ister" : "yalnızca bildirilir"}.`
    : `  Test files, CI settings and ${CONFIG_FILE}: deleting them or ${d.testChanges.assertions === "any-change" ? "changing an existing assertion" : "having fewer assertions"} ${d.testChanges.mode === "block" ? "needs a person" : "is only reported"}.`);
  out.push(tr ? "  Test çalıştırıcı ayarları (jest.config.*, playwright.config.*, pytest.ini...): her değişiklik"
              : "  Test runners' settings (jest.config.*, playwright.config.*, pytest.ini...): any change");
  if (d.testChanges.ownRunners.length) out.push(`  ${tr ? "Projeye özel, her değişikliği" : "The project's own, any change to"}: ${d.testChanges.ownRunners.join(", ")}`);
  if (d.testChanges.own.length) out.push(`  ${tr ? "Projeye özel test dosyaları" : "The project's own test files"}: ${d.testChanges.own.join(", ")}`);
  if ((d.testChanges.ownRunners.length || d.testChanges.own.length) && !d.checks.length)
    out.push(tr ? "  Bunların değişmesi izlenir, ama çalıştırılmazlar: çalışmaları için \"checks\" listesine eklenmeleri gerekir."
                : "  Changes to these are watched, but they are not run: to run them, they go in \"checks\".");

  h(tr ? "Ajan kancaları" : "Agent hooks");
  const W = HOOK_WORDS[lang];
  for (const k of d.hooks) {
    if (k.tool === "git") { out.push(`  git pre-commit: ${W.on}${k.detail === "checks" ? (tr ? ", testleri de çalıştırır" : ", runs the checks too") : (tr ? ", yalnızca kurallar (testler için: soz-guard init --git --checks)" : ", rules only (for the checks: soz-guard init --git --checks)")}`); continue; }
    const name = k.tool === "claude" ? "Claude Code" : "Codex";
    if (k.start === "missing" && k.stop === "missing") {
      out.push(`  ${name}: ${tr ? "kurulu değil" : "not set up"} (soz-guard init --local${k.tool === "codex" ? " --codex" : ""})`);
      continue;
    }
    out.push(`  ${name} (${k.where}): ${tr ? "oturum başı" : "session start"} ${W[k.start]}, ${tr ? "bitiş" : "finish"} ${W[k.stop]}`
      + (k.start === "off" ? ` (${k.detail})` : k.detail && (k.start === "elsewhere" || k.stop === "elsewhere") ? `: ${k.detail}. ${tr ? "Yeniden: soz-guard init --local" : "Again: soz-guard init --local"}` : "")
      + (k.detail && k.start === "on" && k.stop === "on" && k.tool === "claude" ? (tr ? ` (başka bir soz-guard kopyasıyla: ${k.detail})` : ` (with another copy of soz-guard: ${k.detail})`) : ""));
    if (k.tool === "codex") out.push(tr ? "    Codex kancalara bir kez /hooks içinde güvenmenizi ister; güvenilip güvenilmediğini yalnızca Codex bilir."
                                        : "    Codex asks you once, in /hooks, to trust them; whether you did, only Codex knows.");
  }
  if (!d.hooks.some(k => k.tool === "git")) out.push(`  git pre-commit: ${tr ? "kurulu değil" : "not set up"}`);
  out.push(d.lastRun
    ? `  ${tr ? "Son çalışma" : "Last ran"}: ${d.lastRun.at.replace("T", " ").slice(0, 16)} UTC (${d.lastRun.what})`
    : `  ${tr ? "Bu projede henüz hiç çalışmamış (kayıt yok)." : "Never ran in this project yet (nothing in its log)."}`
      + (d.hooks.some(k => k.stop === "on") ? (tr ? " Kurulumdan sonra Claude oturumunu yeniden açın." : " Open the Claude session again after setting it up.") : ""));

  h(tr ? "Sunucudaki soz-guard gate (push'u denetler)" : "soz-guard gate on the server (judges pushes)");
  out.push(`  ${gateWords(d.gate, tr, false)}`);

  h(tr ? "Oturum başında görünen satır" : "The line a session starts with");
  out.push(`  ${sessionLine(d, lang)}`);
  return out.join("\n") + "\n";
}

/** soz-guard doctor in the server's repository: its gate. */
export function serverText(g: SeenGate, lang = language()): string {
  return `soz-guard doctor: ${g.where}\n  soz-guard gate: ${gateWords(g, lang === "tr", false)}\n`;
}
