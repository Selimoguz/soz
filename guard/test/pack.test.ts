// pack.test.ts — soz-guard as someone else gets it: npm pack, installed from the tarball into a fresh
// project (no network: the package has no dependencies), set up with init, and the hook it installs
// run exactly as Claude Code would run it.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const guard = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const check = (what: string, ok: unknown) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) failed++; };
// npm's own entry point, run by this Node: no shell, so paths with spaces are safe (Node 22 refuses
// to start npm.cmd without a shell on Windows).
const npmCli = [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
                join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find(existsSync);
const npm = (args: string[], cwd: string) => npmCli
  ? execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  : execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log("\nnpm pack, then install and use it elsewhere");
const out = mkdtempSync(join(tmpdir(), "soz-guard-pack-"));
const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", out], guard).replace(/^[^[]*/, "")) as { files: { path: string }[] }[];
const tgz = readdirSync(out).find(f => f.endsWith(".tgz"))!;
check("npm pack gives one tarball", !!tgz);
const listing = packed[0].files.map((f: { path: string }) => "package/" + f.path.replaceAll("\\", "/"));
check("it holds the compiled code, the template, README and LICENSE",
      ["package/dist/cli.js", "package/dist/scan.js", "package/dist/rules.js", "package/templates/CLAUDE.md", "package/README.md", "package/LICENSE"]
        .every(f => listing.includes(f)));
check("and not the TypeScript sources or the tests", !listing.some(f => f.startsWith("package/src/") || f.startsWith("package/test/")));

const project = mkdtempSync(join(tmpdir(), "soz-guard-project-"));
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "someones-app", private: true }));
npm(["install", "--no-audit", "--no-fund", "--offline", join(out, tgz)], project);
const installed = join(project, "node_modules", "@sezeren", "soz-guard", "dist", "cli.js");
check("installs from the tarball, offline", existsSync(installed));

const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" });
git("init", "-q"); writeFileSync(join(project, ".gitignore"), "node_modules/\n"); git("add", "."); git("commit", "-q", "-m", "start");

const init = spawnSync(process.execPath, [installed, "init"], { cwd: project, encoding: "utf8" });
check("init runs from the installed package, with plain node", init.status === 0 && init.stdout.includes("Stop hook added"));
const command: string = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8")).hooks.Stop[0].hooks[0].command;
check("the hook it installs runs the compiled code, with no experimental flag",
      command.includes(join("node_modules", "@sezeren", "soz-guard", "dist", "cli.js")) && !command.includes("strip-types"));

// The command npm links for the package (node_modules/.bin/soz-guard), through a shell, as a person types it.
const bin = (...args: string[]) => spawnSync(`"${join(project, "node_modules", ".bin", "soz-guard")}" ${args.join(" ")}`,
                                             { cwd: project, encoding: "utf8", shell: true, timeout: 60000 });
const plain = bin();
check("soz-guard runs from the command npm linked, and finds nothing unfinished in a clean change",
      plain.status === 0 && plain.stdout.includes("Nothing unfinished"));
const doctor = bin("doctor", "--json");
let diagnosis: { configFile?: boolean; hooks?: { tool: string; start: string; stop: string }[] } = {};
try { diagnosis = JSON.parse(doctor.stdout); } catch { diagnosis = {}; }
check("soz-guard doctor sees the Claude Code hooks init installed",
      doctor.status === 0 && diagnosis.configFile === true
      && !!diagnosis.hooks?.some(h => h.tool === "claude" && h.start === "on" && h.stop === "on"));

writeFileSync(join(project, "save.js"), "export const save = () => {};\nexport function handleSave() {}\n");  // soz-guard: ignore (test data)
// Run the installed hook the way Claude Code does: the command line, through a shell, with JSON on stdin.
const hook = spawnSync(command, { cwd: project, encoding: "utf8", shell: true,
                                  input: JSON.stringify({ cwd: project, session_id: `pack${Date.now()}`, hook_event_name: "Stop" }) });
check("that hook stops an agent that leaves an empty function", hook.status === 2 && hook.stderr.includes("save.js:2"));

const again = spawnSync(process.execPath, [installed, "init"], { cwd: project, encoding: "utf8" });
check("init again recognises its own hook", again.stdout.includes("already there")
      && JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8")).hooks.Stop.length === 1);

rmSync(out, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All pack tests passed"}`);
process.exit(failed ? 1 : 0);
