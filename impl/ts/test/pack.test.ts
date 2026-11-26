// pack.test.ts — soz as someone else gets it from npm: npm pack, installed from the tarball into a fresh
// project (offline: the package has no dependencies), its API imported by the package's own name, and its
// three command-line entry points run with plain node, as npm installs them. Node does not strip types in
// node_modules, so this is also the test that what is published is the compiled code.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name: string; version: string; bin: Record<string, string> };
let failed = 0;
const check = (what: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : "\n          " + detail}`);
  if (!ok) failed++;
};
// npm's own entry point, run by this Node: no shell, so paths with spaces are safe (Node 22 refuses to
// start npm.cmd without a shell on Windows).
const npmCli = [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
                join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find(existsSync);
const npm = (args: string[], cwd: string) => npmCli
  ? execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  : execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log(`\nnpm pack ${pkg.name}@${pkg.version}`);
const out = mkdtempSync(join(tmpdir(), "soz-pack-"));
const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", out], pkgDir).replace(/^[^[]*/, "")) as { files: { path: string }[] }[];
const tgz = readdirSync(out).find(f => f.endsWith(".tgz"));
check("npm pack gives one tarball", !!tgz);
const listing = packed[0].files.map(f => f.path.replaceAll("\\", "/"));
check("it holds the compiled code with its types, every bin, README and LICENSE",
      ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE", "package.json", ...Object.values(pkg.bin)].every(f => listing.includes(f)),
      listing.join(", "));
check("and not the TypeScript sources, the tests or the build settings",
      !listing.some(f => f.startsWith("src/") || f.startsWith("test/") || f.startsWith("types/") || f.startsWith("tsconfig")));

console.log("\nInstalled into a fresh project");
const project = mkdtempSync(join(tmpdir(), "soz-project-"));
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "someones-app", private: true, type: "module" }));
npm(["install", "--no-audit", "--no-fund", "--offline", join(out, tgz!)], project);
const installed = join(project, "node_modules", ...pkg.name.split("/"));
check("installs from the tarball, offline", existsSync(join(installed, "dist", "index.js")));

// The API, imported by the package's name, as a user's code would: check, preview, approve, execute.
writeFileSync(join(project, "use.mjs"), `
import { t, defineOperation, defineOperations, checkPlan, preview, execute, Journal } from ${JSON.stringify(pkg.name)};
const paid = [];
const { operations, implementations } = defineOperations(
  defineOperation({ name: "bank.pay", effect: "money", params: { to: t.text(), amount: t.number() }, run: a => { paid.push(a); return null; } }));
const message = "Pay TR33 0006 1005 12,5";
const invented = checkPlan('(plan "x" (bank.pay to "TR33 0006 1005" amount 125))', { message, operations });
const plan = '(plan "x" (bank.pay to "TR33 0006 1005" amount 12.5))';
const journal = new Journal();
const p = await preview(plan, { message, operations, implementations, journal });
const e = await execute(p, p.hash, { implementations, journal });
console.log(JSON.stringify({ inventedCode: invented.errors[0]?.code, status: p.status, outcome: e.outcome, paid: paid.length }));
`);
const api = spawnSync(process.execPath, ["use.mjs"], { cwd: project, encoding: "utf8" });
let used: { inventedCode?: string; status?: string; outcome?: string; paid?: number } = {};
try { used = JSON.parse(api.stdout.trim().split("\n").pop() ?? "{}"); } catch { used = {}; }
check("the API works by the package's name, with plain node: an invented amount is refused", api.status === 0 && used.inventedCode === "invented-value", api.stderr);
check("... and an approved plan is previewed and executed once", used.status === "ready" && used.outcome === "done" && used.paid === 1, api.stdout + api.stderr);

// The command-line entry points, through the links npm made for them (node_modules/.bin), with a shell.
const bin = (name: string, args: string[], input?: string) =>
  spawnSync(`"${join(project, "node_modules", ".bin", name)}" ${args.map(a => `"${a}"`).join(" ")}`,
            { cwd: project, encoding: "utf8", shell: true, input, timeout: 30000 });

const config = join(project, "gateway.json");
writeFileSync(config, JSON.stringify({ servers: {}, approval: "auto", journal: "journal.jsonl", audit: "audit.jsonl" }));
const mcp = bin("soz-mcp", [config], [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-test", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
].map(m => JSON.stringify(m)).join("\n") + "\n");
const answers = mcp.stdout.split("\n").filter(l => l.trim()).map(l => { try { return JSON.parse(l) as { id?: number; result?: { tools?: { name: string }[] } }; } catch { return {}; } });
type Answer = { id?: number; result?: { tools?: { name: string }[] } };
const tools = (answers as Answer[]).find((a: Answer) => a.id === 2)?.result?.tools?.map((x: { name: string }) => x.name) ?? [];
check("soz-mcp runs as an MCP server and offers its tools", tools.includes("soz_preview") && tools.includes("soz_execute"), mcp.stdout + mcp.stderr);

writeFileSync(join(project, "journal.jsonl"), JSON.stringify({ key: "[\"bank.pay\",{\"to\":\"TR33\"}]", status: "unknown", result: null }) + "\n");
const journalOut = bin("soz-journal", ["journal.jsonl"]);
check("soz-journal lists an unresolved step", journalOut.status === 0 && journalOut.stdout.includes("unknown") && journalOut.stdout.includes("bank.pay"), journalOut.stdout + journalOut.stderr);
const approve = bin("soz-approve", []);
check("soz-approve runs and says how it is used", approve.status !== 0 && approve.stderr.includes("usage: soz-approve"), approve.stdout + approve.stderr);

rmSync(out, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All pack tests passed"}`);
process.exit(failed ? 1 : 0);
