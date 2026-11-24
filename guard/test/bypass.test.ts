// bypass.test.ts — Ways a capable agent could weaken the tests without deleting one or removing an assertion:
// the test script, the runner's config, .skip and .only, an assertion that cannot fail. Each is a criteria
// change; the ordinary edits next to them (a dependency, a new script, a new test) are not.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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

const repo = mkdtempSync(join(tmpdir(), "soz-guard-bypass-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args],
                                                 { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const run = (args: string[], input?: string) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args], { cwd: repo, encoding: "utf8", input });
type Criteria = { file: string; kind: string; detail: string }[];
/** The criteria changes in the working tree against HEAD; afterwards the tree is put back as it was. */
const judge = (): Criteria => {
  const r = run(["check", "--json", "--no-checks"]);
  const c = (JSON.parse(r.stdout) as { criteria: Criteria }).criteria;
  git("reset", "-q"); git("checkout", "-q", "--", "."); git("clean", "-q", "-fd", "--", ".", ":(exclude).soz-guard");
  return c;
};
const has = (c: Criteria, kind: string, file?: string) => c.some(x => x.kind === kind && (!file || x.file === file));
const show = (c: Criteria) => JSON.stringify(c.map(x => `${x.file} ${x.kind}: ${x.detail}`));

const pkg = (scripts: Record<string, string>, extra: object = {}) => JSON.stringify({ name: "shop", scripts, dependencies: { a: "1.0.0" }, ...extra }, null, 2);
const TEST = 'import { reserve } from "../src/stock";\nit("reserves", () => {\n  expect(reserve(1)).toBe(1);\n});\nit("never below zero", () => {\n  expect(reserve(-1)).toBe(0);\n});\n';

git("init", "-q", "-b", "main");
git("config", "core.autocrlf", "false");
write(".gitignore", ".soz-guard/\nnode_modules/\n");
write(".soz-guard.json", JSON.stringify({ checks: [], runners: ["**/Makefile"] }));
write("package.json", pkg({ test: "jest", lint: "eslint ." }));
write("jest.config.js", "module.exports = { testEnvironment: \"node\" };\n");
write("pyproject.toml", "[project]\nname = \"shop\"\ndependencies = [\"a\"]\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n");
write("Makefile", "test:\n\tnpm test\n");
write("src/stock.ts", "export const reserve = (n: number) => Math.max(0, n);\n");
write("test/stock.test.ts", TEST);
write("tests/test_stock.py", "def test_reserve():\n    assert reserve(1) == 1\n");
git("add", "-A"); git("commit", "-q", "-m", "base");

console.log("\nWhat runs the tests");
write("package.json", pkg({ test: "exit 0", lint: "eslint ." }));
let c = judge();
check('the "test" script changed to "exit 0": a criteria change', has(c, "runner", "package.json") && c.some(x => x.detail.includes('"exit 0"')), show(c));
write("package.json", pkg({ lint: "eslint ." }));
check('the "test" script removed: a criteria change', has(judge(), "runner", "package.json"));
write("package.json", pkg({ test: "jest", lint: "eslint .", build: "tsc" }, { dependencies: { a: "2.0.0", b: "1.0.0" } }));
c = judge();
check("a new script and new dependencies: fine", c.length === 0, show(c));
write("package.json", pkg({ test: "jest && node test/extra.test.js", lint: "eslint ." }));
c = judge();
check("another test run added at the end of the test script: fine (it can add a failure, not hide one)", c.length === 0, show(c));
write("package.json", pkg({ test: "node prepare.js && jest", lint: "eslint ." }));
check("... but a command put before the tests (it could delete them first): a criteria change", has(judge(), "runner", "package.json"));
write("package.json", pkg({ test: "jest && node test/extra.test.js || true", lint: "eslint ." }));
check("... and one that ends in || true: a criteria change", has(judge(), "runner", "package.json"));
write("package.json", pkg({ test: "jest --passWithNoTests", lint: "eslint ." }));
check("... and a flag on the runner itself: a criteria change", has(judge(), "runner", "package.json"));
write("package.json", pkg({ test: "jest", lint: "eslint ." }, { jest: { testPathIgnorePatterns: ["test/"] } }));
check('a "jest" section in package.json: a criteria change', has(judge(), "runner", "package.json"));
write("node_modules/x/package.json", pkg({ test: "exit 0" }));
check("a package's own package.json in node_modules: not the project's", judge().length === 0);
write("jest.config.js", "module.exports = { testEnvironment: \"node\", testPathIgnorePatterns: [\"test/\"] };\n");
check("the runner's config told to leave the tests out: a criteria change", has(judge(), "runner", "jest.config.js"));
git("rm", "-q", "jest.config.js");
check("... or deleted: a criteria change", has(judge(), "runner", "jest.config.js"));
write("vitest.config.ts", "export default { test: { exclude: [\"test/**\"] } };\n");
check("a new runner config: a criteria change (it decides what runs)", has(judge(), "runner", "vitest.config.ts"));
write("tests/conftest.py", "def pytest_collection_modifyitems(items):\n    items.clear()\n");
check("a conftest.py that can drop every test: a criteria change", has(judge(), "runner", "tests/conftest.py"));
write("pyproject.toml", "[project]\nname = \"shop\"\ndependencies = [\"a\"]\n\n[tool.pytest.ini_options]\ntestpaths = [\"nothing\"]\n");
check("pytest's section in pyproject.toml changed: a criteria change", has(judge(), "runner", "pyproject.toml"));
write("pyproject.toml", "[project]\nname = \"shop\"\ndependencies = [\"a\", \"b\"]\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n");
c = judge();
check("... another section (a dependency): fine", c.length === 0, show(c));
write("Makefile", "test:\n\ttrue\n");
check('a runner the owner named in "runners" (Makefile): a criteria change', has(judge(), "runner", "Makefile"));

console.log("\nTests switched off without removing one");
write("test/stock.test.ts", TEST.replace('it("never below zero"', 'it.skip("never below zero"'));   // soz-guard: ignore (test data)
c = judge();
check("it.skip: a criteria change, though no assertion was removed", has(c, "tests-skipped", "test/stock.test.ts"), show(c));
write("test/stock.test.ts", TEST.replace('it("reserves"', 'it.only("reserves"'));   // soz-guard: ignore (test data)
check("it.only (every other test then does not run): a criteria change", has(judge(), "tests-skipped"));
write("test/stock.test.ts", TEST.replace('it("never below zero"', 'xit("never below zero"'));   // soz-guard: ignore (test data)
check("xit: a criteria change", has(judge(), "tests-skipped"));
write("tests/test_stock.py", "import pytest\n\n@pytest.mark.skip\ndef test_reserve():\n    assert reserve(1) == 1\n");   // soz-guard: ignore (test data)
check("@pytest.mark.skip: a criteria change", has(judge(), "tests-skipped", "tests/test_stock.py"));   // soz-guard: ignore (test data)
write("test/stock.test.ts", TEST.replace('it("never below zero"', 'it.skip("never below zero"'));   // soz-guard: ignore (test data)
git("add", "-A"); git("commit", "-q", "-m", "a test skipped, accepted earlier");
write("test/stock.test.ts", TEST);
c = judge();
check("a skipped test switched back on: fine", c.length === 0, show(c));
git("reset", "-q", "--hard", "HEAD~1");
write("test/stock.test.ts", TEST + 'it("releases", () => {\n  expect(reserve(2)).toBe(2);\n});\n');
c = judge();
check("a new test: fine", c.length === 0, show(c));

console.log("\nAn assertion that cannot fail");
write("test/stock.test.ts", TEST.replace("expect(reserve(-1)).toBe(0);", "expect(true).toBe(true);"));
c = judge();
check('a real assertion swapped for expect(true).toBe(true): fewer assertions, even in "fewer" mode', has(c, "assertions-removed"), show(c));
write("tests/test_stock.py", "def test_reserve():\n    assert True\n");
check("... assert True, likewise", has(judge(), "assertions-removed", "tests/test_stock.py"));
write("test/stock.test.ts", TEST.replace("expect(reserve(-1)).toBe(0);", "expect(reserve(-1)).toBe(0);\n  expect(reserve(-2)).toBe(0);"));
c = judge();
check("a real assertion added: fine", c.length === 0, show(c));

console.log("\nIn ci, on a branch");
git("checkout", "-q", "-b", "agent");
write("package.json", pkg({ test: "echo ok", lint: "eslint ." }));
git("add", "-A"); git("commit", "-q", "-m", "make tests faster");
const ci = run(["ci", "--base", "main"]);
check("a branch that changes the test script: ci fails and says what changed", ci.status === 1 && ci.stdout.includes('"echo ok"'), ci.stdout + ci.stderr);

rmSync(repo, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All soz-guard bypass tests passed"}`);
process.exit(failed ? 1 : 0);
