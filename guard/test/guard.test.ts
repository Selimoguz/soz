// guard.test.ts — soz-guard on real git repositories in a temporary folder.
// The sample lines below are unfinished work on purpose; each source line says so to soz-guard itself.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { scanLines, loadConfig } from "../src/scan.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : "\n          " + detail}`);
  if (!ok) failed++;
};

console.log("\nRules: what is unfinished, and what only looks like it");
const config = loadConfig(mkdtempSync(join(tmpdir(), "soz-guard-cfg-")));
const cases: [string, string, string | null][] = [
  ["src/order.ts", "// TODO: connect to the stock service", "todo"],                       // soz-guard: ignore (test data)
  ["src/order.ts", "  // FIXME stok düşmüyor", "todo"],                                    // soz-guard: ignore (test data)
  ["src/order.ts", 'throw new Error("not implemented");', "not-implemented"],               // soz-guard: ignore (test data)
  ["src/Order.cs", "throw new NotImplementedException();", "not-implemented"],             // soz-guard: ignore (test data)
  ["src/order.ts", "} catch (e) {}", "swallowed-error"],                                   // soz-guard: ignore (test data)
  ["src/order.ts", "save().catch(() => {});", "swallowed-error"],                           // soz-guard: ignore (test data)
  ["src/order.py", "except Exception: pass", "swallowed-error"],                            // soz-guard: ignore (test data)
  ["src/order.ts", "const vat = 0.2; // şimdilik sabit", "deferred"],                       // soz-guard: ignore (test data)
  ["src/order.ts", "// wire this to the API later", "deferred"],                           // soz-guard: ignore (test data)
  ["src/order.ts", "  // ... rest of the screen", "elided"],                                // soz-guard: ignore (test data)
  ["src/order.ts", "  // ...", "elided"],                                                   // soz-guard: ignore (test data)
  ["src/order.ts", 'const email = "test@test.com";', "fake-data"],                          // soz-guard: ignore (test data)
  ["src/order.ts", 'notes: "Lorem ipsum dolor"', "fake-data"],                              // soz-guard: ignore (test data)
  ["src/Order.tsx", "<button onClick={() => {}}>Kaydet</button>", "empty-function"],        // soz-guard: ignore (test data)
  ["src/order.ts", "const handleSave = () => {};", "empty-function"],                       // soz-guard: ignore (test data)
  ["src/order.ts", "  save() {}", "empty-function"],                                        // soz-guard: ignore (test data)
  ["src/order.ts", "function approve(order: Order): void {}", "empty-function"],            // soz-guard: ignore (test data)
  ["src/order.ts", "const cancel = () => {};", "empty-function"],                           // soz-guard: ignore (test data)
  ["src/order.ts", "export const cancel = async (id: string): Promise<void> => {};", "empty-function"],   // soz-guard: ignore (test data)
  ["src/Order.tsx", "  private cancel = () => {}", "empty-function"],                       // soz-guard: ignore (test data)
  ["test/pay.test.ts", 'test.skip("does not pay twice", () => check());', "skipped-test"],   // soz-guard: ignore (test data)
  ["test/pay.test.ts", 'it.todo("refunds");', "skipped-test"],                                // soz-guard: ignore (test data)
  ["src/PayTest.java", "@Disabled", "skipped-test"],                                         // soz-guard: ignore (test data)
  // not unfinished
  ["src/cli.ts", "const [cmd, ...rest] = argv;", null],
  ["src/queue.ts", "// failed jobs are retried later by the queue", null],
  ["src/files.ts", "// written to a temporary folder first", null],
  ["src/order.ts", "// sonra çağrılır, sırası önemli", null],
  ["test/order.test.ts", 'check("the new TODO is reported", ok);', null],                    // soz-guard: ignore (test data)
  ["src/Order.tsx", '<input placeholder="Cari adı" />', null],
  ["src/Order.tsx", "useEffect(() => {}, []);", null],
  ["src/order.ts", "const noop = () => {};", null],
  ["src/order.ts", "export function load(done = () => {}) {", null],
  ["src/order.ts", "const save = () => {", null],
  ["src/order.ts", "const todoList = loadTodos();", null],
  ["src/order.ts", "if (stock < 0) {}", null],
  ["src/order.ts", "constructor() {}", null],
  ["test/order.test.ts", 'const email = "test@test.com";', null],                          // soz-guard: ignore (test data)
  ["README.md", "TODO: write the docs", null],                                             // soz-guard: ignore (test data)
  ["src/order.ts", "return price; // TODO later soz-guard: ignore waiting for the pricing API", null],  // soz-guard: ignore (test data)
];
for (const [file, line, rule] of cases) {
  const f = scanLines(new Map([[file, [[1, line]]]]), config);
  const got = f[0]?.rule ?? null;
  check(`${rule ?? "nothing"}: ${file}  ${line}`, got === rule, `got ${got}`);
}

// --- a real repository --------------------------------------------------------------------------------

const repo = mkdtempSync(join(tmpdir(), "soz-guard-repo-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                 { cwd: repo, encoding: "utf8" });
const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const run = (args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd: repo, encoding: "utf8", input });

git("init", "-q");
write("src/stock.ts", "export function reserve() {\n  // TODO: old one, not ours\n  return 1;\n}\n");  // soz-guard: ignore (test data)
git("add", "."); git("commit", "-q", "-m", "base");

console.log("\nscan: only what changed");
check("a clean repository has nothing unfinished", run(["scan"]).status === 0);
write("src/stock.ts", "export function reserve() {\n  // TODO: old one, not ours\n  return 1;\n}\nexport function release() {\n  // TODO: release the reservation\n}\n");  // soz-guard: ignore (test data)
write("src/screens/Order.tsx", "export const Order = () => (\n  <form>\n    <input placeholder=\"Ürün\" />\n    <button onClick={() => {}}>Kaydet</button>\n  </form>\n);\n");  // soz-guard: ignore (test data)
const r = run(["scan", "--json"]);
const found = JSON.parse(r.stdout).findings as { file: string; line: number; rule: string }[];
check("exit 1 when something is unfinished", r.status === 1);
check("the new TODO in a changed file, at its line", found.some(f => f.file === "src/stock.ts" && f.line === 6 && f.rule === "todo"), JSON.stringify(found));
check("the old TODO that was already committed is not reported", !found.some(f => f.file === "src/stock.ts" && f.line === 2));
check("a new, untracked file is scanned whole: the empty button", found.some(f => f.file === "src/screens/Order.tsx" && f.line === 4 && f.rule === "empty-function"));
check("the placeholder attribute is not reported", !found.some(f => f.line === 3));

console.log("\nhook: Claude Code Stop");
const session = `t${Date.now()}`;
const hookInput = JSON.stringify({ cwd: repo, session_id: session, hook_event_name: "Stop", stop_hook_active: false });
const h1 = run(["hook"], hookInput);
check("unfinished work: exit 2, so the agent continues", h1.status === 2, `status ${h1.status} ${h1.stderr}`);
check("the agent is told what, where, and how to declare what must stay", h1.stderr.includes("src/stock.ts:6") && h1.stderr.includes("soz-guard: ignore"));
run(["hook"], hookInput); run(["hook"], hookInput);
const h4 = run(["hook"], hookInput);
check("after 3 checks it lets the agent finish (no endless loop)", h4.status === 0);
check("... and tells the person, plainly, that it is not finished", JSON.parse(h4.stdout).systemMessage.includes("the work is open, not finished")
      && JSON.parse(h4.stdout).systemMessage.includes("src/stock.ts:6"));
write("src/stock.ts", "export function reserve() {\n  // TODO: old one, not ours\n  return 1;\n}\nexport function release() {\n  return 0; // soz-guard: ignore the stock API has no release call yet\n}\n");  // soz-guard: ignore (test data)
write("src/screens/Order.tsx", "export const Order = () => <form><button onClick={save}>Kaydet</button></form>;\n");
check("finished, or declared: the agent may stop", run(["hook"], hookInput).status === 0);
const outside = mkdtempSync(join(tmpdir(), "soz-guard-nogit-"));
check("outside a git repository the hook stays out of the way",
      spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, "hook"],
                { cwd: outside, encoding: "utf8", input: JSON.stringify({ cwd: outside }) }).status === 0);

console.log("\ninit");
write(".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }, null, 2));
write("CLAUDE.md", "# Project\n\nUse tabs.\n");
const i1 = run(["init"]);
const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
check("init adds the Stop hook", i1.status === 0 && settings.hooks.Stop[0].hooks[0].command.includes("cli.ts\" hook"));
check("init keeps the settings that were there", settings.permissions.allow[0] === "Bash(npm test)");
check("init keeps CLAUDE.md and adds its section", readFileSync(join(repo, "CLAUDE.md"), "utf8").startsWith("# Project")
      && readFileSync(join(repo, "CLAUDE.md"), "utf8").includes("Finished means finished"));
check("init writes .soz-guard.json", existsSync(join(repo, ".soz-guard.json")));
run(["init"]);
const again = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
check("running init twice changes nothing", again.hooks.Stop.length === 1
      && readFileSync(join(repo, "CLAUDE.md"), "utf8").split("Finished means finished").length === 2);
write(".soz-guard.json", JSON.stringify({ disable: ["empty-function"], rules: [{ id: "debug-log", pattern: "console\\.log\\(", message: "a debug log left in", extensions: [".ts"] }] }));
write("src/debug.ts", "console.log(order);\nexport const noop = { onClick: () => {} };\n");  // soz-guard: ignore (test data)
const custom = JSON.parse(run(["scan", "--json"]).stdout).findings as { file: string; rule: string }[];
check("a project can add its own rule", custom.some(f => f.file === "src/debug.ts" && f.rule === "debug-log"));
check("... and switch a rule off", !custom.some(f => f.rule === "empty-function"));

rmSync(repo, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard tests passed"}`);
process.exit(failed ? 1 : 0);
