// holdout.test.ts — Checks the agent must not see: tests kept outside the repository, whose output never
// reaches the agent or the repository's .soz-guard/, only a file outside it for the person.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
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

const repo = mkdtempSync(join(tmpdir(), "soz-guard-holdout-"));
const home = mkdtempSync(join(tmpdir(), "soz-guard-home-"));       // stands in for the user's ~/.soz-guard
const hidden = join(home, "holdout", "shop");                       // the owner's hidden tests, outside the repo
mkdirSync(hidden, { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                 { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const env = { ...process.env, SOZ_GUARD_HOME: home };
const run = (args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd: repo, encoding: "utf8", input, env });
let session = 0;
const hook = () => run(["hook"], JSON.stringify({ cwd: repo, session_id: `h-${Date.now()}-${++session}`, hook_event_name: "Stop" }));
const own = (f: string) => existsSync(join(repo, ".soz-guard", f)) ? readFileSync(join(repo, ".soz-guard", f), "utf8") : "";

// The hidden test: a discount must never take a price below zero. Its expected value is the secret.
const SECRET = "EXPECTED-PRICE-FLOOR-0";
writeFileSync(join(hidden, "price.mjs"),
  `import { price } from ${JSON.stringify("file:///" + join(repo, "src", "price.mjs").replace(/\\/g, "/"))};\n`
  + `if (price(10, 15) !== 0) { console.log("${SECRET}: price(10, 15) gave " + price(10, 15)); process.exit(1); }\n`
  + `console.log("hidden price test passed");\n`);

git("init", "-q", "-b", "main");
write(".gitignore", ".soz-guard/\n");
write("src/price.mjs", "export const price = (p, d) => p;\n");
write(".soz-guard.json", JSON.stringify({ checks: [
  { name: "hidden-price", run: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(hidden, "price.mjs"))}`, holdout: true },
] }, null, 2));
git("add", "-A"); git("commit", "-q", "-m", "base");

console.log("\nA hidden check fails");
write("src/price.mjs", "export const price = (p, d) => p - d;\n");
const h = hook();
check("the hook stops the agent", h.status === 2, h.stderr);
check("... and tells it a hidden check failed, to re-read the requirement or ask", h.stderr.includes('Hidden check "hidden-price" failed') && h.stderr.includes("ask the user"), h.stderr);
check("... without the hidden test's output", !h.stderr.includes(SECRET), h.stderr);
check("... or its command (where the tests are)", !h.stderr.includes("price.mjs\""), h.stderr);
check("last.json, in the repository, does not hold the output", own("last.json").includes('"failed"') && !own("last.json").includes(SECRET));
check("nor does the checks cache", !own("checks.json").includes(SECRET));
check("nor the log", !own("log.jsonl").includes(SECRET));
const results = join(home, "holdout-results");
const files = existsSync(results) ? readdirSync(results).flatMap(d => readdirSync(join(results, d)).map(f => join(results, d, f))) : [];
check("the output is in a file outside the repository, for the person", files.length === 1 && readFileSync(files[0], "utf8").includes(SECRET), files.join(", "));
const c = run(["check"]);
check("soz-guard check (which an agent may run) points to that file, without the output", c.status === 1 && c.stdout.includes(files[0] ?? "?") && !c.stdout.includes(SECRET), c.stdout);

console.log("\nThe agent fixes the code against the requirement");
write("src/price.mjs", "export const price = (p, d) => Math.max(0, p - d);\n");
const ok = hook();
check("verified", ok.status === 0 && JSON.parse(own("last.json")).state === "verified", ok.stderr);
check("a holdout check runs again every time: its tests can change outside the repository", (() => {
  writeFileSync(join(hidden, "price.mjs"), readFileSync(join(hidden, "price.mjs"), "utf8") + "process.exit(3);\n");
  return hook().status === 2;
})());

const bad = (() => { write(".soz-guard.json", JSON.stringify({ checks: [{ name: "x", run: "echo", holdout: "yes" }] })); return run(["check", "--no-checks"]); })();
check('"holdout" must be true or false', bad.status !== 0 && (bad.stderr + bad.stdout).includes('"holdout" is true or false'), bad.stderr + bad.stdout);

rmSync(repo, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard holdout tests passed"}`);
process.exit(failed ? 1 : 0);
