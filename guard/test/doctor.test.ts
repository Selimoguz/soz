// doctor.test.ts — soz-guard doctor and the line a session starts with: what this setup guards, read from the
// project's own settings, the same diagnosis in both.
//   - two ordinary projects with the same test command: in one it is not a required check, in the other it is;
//     the person sees the difference at once, in doctor and in the session's line;
//   - with no check, the rules that still hold (on the code, on the tests) are said, the project's own named;
//   - the hooks: missing, switched off, pointing at a soz-guard that is not on this machine;
//   - the server's gate: read when the remote is a folder on this machine, "not verified from here" otherwise;
//   - read-only: doctor changes nothing; the session hook gives the line to the person (systemMessage) and the
//     agent (additionalContext), and logs it.

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : "\n          " + detail}`);
  if (!ok) failed++;
};

const top = mkdtempSync(join(tmpdir(), "soz-doctor-test-"));
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                                { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (cwd: string, args: string[], lang = "tr", input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args],
  { cwd, encoding: "utf8", input, env: { ...process.env, SOZ_GUARD_LANG: lang } });
const doctor = (cwd: string, lang = "tr") => run(cwd, ["doctor"], lang);
const json = (cwd: string) => JSON.parse(run(cwd, ["doctor", "--json"]).stdout) as { sessionLine: string; unwired: { command: string }[]; checks: unknown[] };
const sessionStart = (cwd: string, lang = "tr") => {
  const r = run(cwd, ["session-start"], lang, JSON.stringify({ cwd, session_id: "s1", source: "startup", hook_event_name: "SessionStart" }));
  return { ...r, out: JSON.parse(r.stdout || "{}") as { systemMessage?: string; hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } } };
};

/** An ordinary project: a package.json with a test script, soz-guard set up with init --local, and CONFIG as its
 * .soz-guard.json. */
function project(name: string, config: object): string {
  const dir = join(top, name);
  mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "-q");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "node test/all.test.js" } }, null, 2));
  mkdirSync(join(dir, "test")); writeFileSync(join(dir, "test", "all.test.js"), "process.exit(0);\n");
  writeFileSync(join(dir, "index.js"), "module.exports = 1;\n");
  const init = run(dir, ["init", "--local"]);
  if (init.status !== 0) throw new Error(init.stderr);
  writeFileSync(join(dir, ".soz-guard.json"), JSON.stringify(config, null, 2));
  gitIn(dir, "add", "-A"); gitIn(dir, "commit", "-q", "-m", "start");
  return dir;
}

console.log("Two ordinary projects, the same test command");
const loose = project("loose", { checks: [] });
const bound = project("bound", { checks: [{ name: "tests", run: "npm test" }] });
const dl = doctor(loose), db = doctor(bound);
check("doctor runs in both", dl.status === 0 && db.status === 0, dl.stderr + db.stderr);
check("not a check: \"no project test is set to run when it finishes\"", dl.stdout.includes("Tamamlanırken çalıştırılacak proje testi tanımlı değil."), dl.stdout);
check("... and npm test is named as there but not run by soz-guard, with how to run it",
      dl.stdout.includes(`package.json içinde "npm test" var, ama .soz-guard.json'da zorunlu kontrol değil: soz-guard onu çalıştırmaz.`)
      && dl.stdout.includes(`{"name": "tests", "run": "npm test"}`), dl.stdout);
check("a check: its name and command, when it runs, and no warning", db.stdout.includes("tests: npm test  (her değişiklikte)")
      && !db.stdout.includes("çalıştırmaz") && !db.stdout.includes("tanımlı değil"), db.stdout);
const ll = json(loose).sessionLine, lb = json(bound).sessionLine;
check("the session's line, not a check", ll === "soz-guard · Tamamlanırken çalıştırılacak proje testi tanımlı değil · npm test: projede var, soz-guard çalıştırmıyor"
      + " · Kod kuralları: 8 · Test değişikliği izleniyor: test dosyaları · Sunucudaki soz-guard gate: buradan doğrulanamadı", ll);
check("the session's line, a check", lb === "soz-guard · Tamamlanırken çalışacak: tests · Sunucudaki soz-guard gate: buradan doğrulanamadı", lb);
check("with no check, doctor names the rules that still hold: on the code and on the tests",
      dl.stdout.includes("Yerleşik (8): todo, not-implemented") && dl.stdout.includes("Test dosyaları, CI ayarları ve .soz-guard.json: silmek ya da assertion sayısını azaltmak kişinin onayını ister."), dl.stdout);
check("a test script named test:e2e is found too, and is not taken for npm test", (() => {
  writeFileSync(join(bound, "package.json"), JSON.stringify({ name: "bound", scripts: { test: "node test/all.test.js", "test:e2e": "node e2e.js" } }));
  const u = json(bound).unwired.map(x => x.command);
  gitIn(bound, "checkout", "-q", "--", "package.json");
  return u.length === 1 && u[0] === "npm run test:e2e";
})());
check("in English where the machine is not Turkish", json(loose) && run(loose, ["doctor"], "en").stdout.includes("No project test is set to run when the agent finishes.")
      && run(loose, ["doctor"], "en").stdout.includes(`package.json has "npm test", but it is not a required check in .soz-guard.json: soz-guard does not run it.`));

console.log("\nThe ERP trial: a script watched, no test run");
const erp = project("erp", {
  checks: [], runners: ["e2e/kapi.ps1"],
  rules: [{ id: "atlandi-adim", pattern: "ATLANDI_ADIM", message: "bir test adımı atlandı", extensions: [".ts", ".java"] },
          { id: "acik-etiketi", pattern: "@acik", message: "bir senaryo açık madde sayıldı, kapıda çalışmaz", extensions: [".ts"] }],
});
const le = json(erp).sessionLine;
check("the line says the script is watched and that no test runs: two things, not one",
      le.includes("Tamamlanırken çalıştırılacak proje testi tanımlı değil") && le.includes("Test değişikliği izleniyor: test dosyaları, e2e/kapi.ps1")
      && le.includes("Kod kuralları: 10 (2 projeye özel)") && le.endsWith("Sunucudaki soz-guard gate: buradan doğrulanamadı"), le);
const de = doctor(erp).stdout;
check("doctor: the script's changes are watched, but it is not run", de.includes("Projeye özel, her değişikliği: e2e/kapi.ps1")
      && de.includes("Bunların değişmesi izlenir, ama çalıştırılmazlar"), de);
check("doctor: the project's own rules, with what they look for", de.includes("Projeye özel (2): atlandi-adim (bir test adımı atlandı); acik-etiketi"), de);

console.log("\nThe session's start: to the person and to the agent");
const s = sessionStart(bound);
check("systemMessage, which the person sees, is the line", s.status === 0 && s.out.systemMessage === lb, s.stdout + s.stderr);
check("additionalContext, for the agent: the same line and what it means", s.out.hookSpecificOutput?.hookEventName === "SessionStart"
      && s.out.hookSpecificOutput.additionalContext?.startsWith(lb + "\n") === true && s.out.hookSpecificOutput.additionalContext.includes("soz-guard doctor"), s.stdout);
check("the session start is in soz-guard's log, with the line", (() => {
  const log = readFileSync(join(bound, ".soz-guard", "log.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  return log.some(e => e.event === "session-start" && e.line === lb) && run(bound, ["log", "--verify"]).stdout.includes("intact");
})());
check("doctor says when the hooks last ran", doctor(bound).stdout.includes("Son çalışma:") && doctor(bound).stdout.includes("(session-start)"));
check("before any session: never ran, open the session again", doctor(loose).stdout.includes("Bu projede henüz hiç çalışmamış"));
check("a broken .soz-guard.json does not keep the session from starting: it is said", (() => {
  writeFileSync(join(loose, ".soz-guard.json"), "{ not json");
  const r = sessionStart(loose);
  gitIn(loose, "checkout", "-q", "--", ".soz-guard.json");
  return r.status === 0 && (r.out.systemMessage ?? "").includes(".soz-guard.json okunamıyor");
})());

console.log("\nRead-only");
const snapshot = (dir: string) => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (f === ".git") continue;
    const st = statSync(p); if (st.isDirectory()) walk(p); else files.push(`${p} ${st.size} ${st.mtimeMs}`); } };
  walk(dir);
  return files.sort().join("\n") + gitIn(dir, "status", "--porcelain");
};
const before = snapshot(bound);
doctor(bound); run(bound, ["doctor", "--json"]);
check("doctor changes nothing in the project, its log included", snapshot(bound) === before);

console.log("\nThe hooks");
const settingsPath = join(erp, ".claude", "settings.local.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
check("init's hooks: both on", doctor(erp).stdout.includes("Claude Code (.claude/settings.local.json): oturum başı açık, bitiş açık"), doctor(erp).stdout);
writeFileSync(settingsPath, JSON.stringify({ ...settings, hooks: { SessionStart: settings.hooks.SessionStart } }));
const noStop = json(erp).sessionLine;
check("the finish hook gone: the line starts with it, nothing is judged at the finish",
      noStop.startsWith("soz-guard · Bitiş kancası çalışmıyor: iş bitiminde hiçbir şey denetlenmez"), noStop);
writeFileSync(settingsPath, JSON.stringify({ ...settings, disableAllHooks: true }));
check("hooks switched off: said, with where", doctor(erp).stdout.includes("oturum başı kancalar kapatılmış, bitiş kancalar kapatılmış (.claude/settings.local.json)"), doctor(erp).stdout);
// the hooks as another machine wrote them: its soz-guard, by a path this machine does not have
const moved = JSON.parse(JSON.stringify(settings)) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
for (const list of Object.values(moved.hooks)) for (const m of list) for (const h of m.hooks) h.command = h.command.split(cli).join(join(top, "gone", "cli.ts"));
writeFileSync(settingsPath, JSON.stringify(moved));
check("pointed at a soz-guard that is not on this machine: said, and how to set it right",
      doctor(erp).stdout.includes("bu makinede olmayan bir soz-guard'ı gösteriyor") && doctor(erp).stdout.includes("Yeniden: soz-guard init --local"), doctor(erp).stdout);
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
check("no Codex hooks and no pre-commit hook: said as not set up", doctor(erp).stdout.includes("git pre-commit: kurulu değil"));
run(erp, ["init", "--git", "--checks"]);
check("the pre-commit hook, with the checks", doctor(erp).stdout.includes("git pre-commit: açık, testleri de çalıştırır"), doctor(erp).stdout);

console.log("\nThe server's gate");
const server = join(top, "server.git");
execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", server], { encoding: "utf8" });
gitIn(bound, "remote", "add", "origin", server.replace(/\\/g, "/"));
check("a remote on this machine with no gate: none, pushes go in unjudged",
      json(bound).sessionLine.endsWith("Sunucudaki soz-guard gate: kurulu değil") && doctor(bound).stdout.includes("soz-guard gate kurulu değil"), json(bound).sessionLine);
run(server, ["gate", "install", "--branches", "main", "--require-task", "--build", "node build.js", "--package", "out"]);
check("the gate on it: what it protects, read from it", json(bound).sessionLine.endsWith("Sunucudaki soz-guard gate: main korunuyor, yalnızca görev teslimi, paket: out"), json(bound).sessionLine);
check("doctor in the server's repository: its gate", doctor(server).stdout.includes("main korunuyor; yalnızca görev teslimi; paket: out"), doctor(server).stdout);
gitIn(bound, "remote", "set-url", "origin", "git@sunucu.firma.local:erp.git");
check("a remote on another machine: not verified, and where to look instead",
      json(bound).sessionLine.endsWith("Sunucudaki soz-guard gate: buradan doğrulanamadı") && doctor(bound).stdout.includes("git@sunucu.firma.local:erp.git bu makineden okunamıyor")
      && doctor(bound).stdout.includes("soz-guard gate log --last 20"), doctor(bound).stdout);
check("no remote at all: said so", doctor(loose).stdout.includes("bu projenin bir uzak deposu (remote) yok"));

check("outside a git repository: said, exit 1", (() => { const d = join(top, "plain"); mkdirSync(d); const r = doctor(d); return r.status === 1 && r.stderr.includes("git deposu değil"); })());
check("the agent is told what the gate in the line is, and that it is not the project's own script",
      (sessionStart(erp).out.hookSpecificOutput?.additionalContext ?? "").includes("projenin kendi betikleriyle ilgisi yoktur"));
check("the template tells the agent what to do when the line is missing", readFileSync(join(dirname(cli), "..", "templates", "CLAUDE.md"), "utf8").includes("soz-guard doctor"));

rmSync(top, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard doctor tests passed"}`);
process.exit(failed ? 1 : 0);
