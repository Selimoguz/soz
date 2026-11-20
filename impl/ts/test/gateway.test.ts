// gateway.test.ts — The TypeScript MCP gateway end to end: this script is the MCP client (the agent
// and the user), the gateway and the pretend ERP behind it run as real processes.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyAudit } from "../src/run.ts";
import { newKeyPair, openPrivateKey, readRequest, signApproval } from "../src/approvals.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "soz-ts-gateway-"));
const NODE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
let failed = 0;
const check = (what: string, ok: unknown) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) failed++; };

type Obj = Record<string, any>;

function writeConfig(name: string, approval: string, extra: Obj = {}): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({
    servers: { erp: { command: process.execPath, args: [...NODE, join(here, "fake-erp.ts")] } },
    operations: { "erp.add_order_line": { key: ["customer", "product", "quantity"], model_allowed: ["note"] } },
    approval, journal: "journal.jsonl", audit: "audit.jsonl", ...extra,
  }));
  return path;
}

class Client {
  proc: ChildProcess; next = 0; waiting = new Map<number, (m: Obj) => void>();
  onElicit: (message: string) => "decline" | "yes" | "no" = () => "decline";
  constructor(config: string, env: Obj = {}) {
    this.proc = spawn(process.execPath, [...NODE, join(here, "..", "src", "soz-mcp.ts"), config],
                      { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...env } });
    createInterface({ input: this.proc.stdout }).on("line", line => {
      const m = JSON.parse(line);
      if (m.method === "elicitation/create") {
        const a = this.onElicit(m.params.message);
        this.send({ jsonrpc: "2.0", id: m.id, result: a === "decline" ? { action: "decline" } : { action: "accept", content: { approve: a === "yes" } } });
      } else if (m.id !== undefined) this.waiting.get(m.id)?.(m);
    });
  }
  send(m: Obj) { this.proc.stdin.write(JSON.stringify(m) + "\n"); }
  request(method: string, params: Obj = {}): Promise<Obj> {
    const id = ++this.next;
    return new Promise(res => { this.waiting.set(id, m => res(m.result ?? m)); this.send({ jsonrpc: "2.0", id, method, params }); });
  }
  async init(elicitation: boolean) {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: elicitation ? { elicitation: {} } : {}, clientInfo: { name: "t", version: "1" } });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return this;
  }
  call(name: string, args: Obj = {}) { return this.request("tools/call", { name, arguments: args }); }
  close() { this.proc.stdin.end(); }
}

const text = (r: Obj): string => r.content?.[0]?.text ?? "";
const previewId = (r: Obj) => /preview_id: ([0-9a-f]{64})/.exec(text(r))?.[1];
const orders = async (c: Client) => JSON.parse(text(await c.call("erp_list_orders"))).length;

const MESSAGE = "Please send Yilmaz Market 20 crates of tomatoes and 5 crates of peppers tomorrow.";
const GOOD = `(plan "Order for Yilmaz Market"
  (let ((c (erp.find_customer name "Yilmaz Market")))
    (if (> (get c balance) (get c limit))
        (stop "over the limit")
        (for-each (line (list (record product "tomatoes" quantity 20) (record product "peppers" quantity 5)))
          (erp.add_order_line customer (get c code) product (get line product) quantity (get line quantity))))))`;

console.log("\nGateway with elicitation");
{
  const c = await new Client(writeConfig("g1.json", "elicitation")).init(true);
  const tools = ((await c.request("tools/list")).tools as Obj[]).map(t => t.name);
  check("offers soz_guide, soz_preview, soz_execute, soz_inspect_audit", ["soz_guide", "soz_preview", "soz_execute", "soz_inspect_audit"].every(n => tools.includes(n)));
  check("passes read tools through", tools.includes("erp_find_customer") && tools.includes("erp_list_orders") && tools.includes("erp_get_order"));
  check("does not offer the write tools directly", !tools.includes("erp_add_order_line") && !tools.includes("erp_cancel_order"));
  const guide = text(await c.call("soz_guide"));
  check("the guide lists the operations with their effects", guide.includes("(erp.add_order_line") && guide.includes("effect: write") && guide.includes("effect: read"));
  check("a pass-through read works", text(await c.call("erp_find_customer", { name: "Yilmaz" })).includes("C-1042"));

  const bad = await c.call("soz_preview", { plan: GOOD.replace("quantity 20", "quantity 25"), message: MESSAGE });
  check("a plan with an invented quantity is refused with the reason", bad.isError && text(bad).includes("invented-value"));
  const p = await c.call("soz_preview", { plan: GOOD, message: MESSAGE });
  const id = previewId(p)!;
  check("the good plan is previewed with its steps and a preview_id", id && text(p).includes("product=tomatoes quantity=20"));
  check("the preview changed nothing", await orders(c) === 0);

  let asked = "";
  c.onElicit = m => { asked = m; return "decline"; };
  const r1 = await c.call("soz_execute", { preview_id: id });
  check("execute asks the user; a decline runs nothing", asked.includes("Approve these steps?") && text(r1).includes("Nothing ran") && await orders(c) === 0);
  check("the question shows the message the plan rests on", asked.includes(MESSAGE));
  c.onElicit = () => "no";
  check("accepting without ticking approve runs nothing", text(await c.call("soz_execute", { preview_id: id })).includes("Nothing ran"));
  c.onElicit = () => "yes";
  const r2 = await c.call("soz_execute", { preview_id: id.slice(0, 16) });
  check("approved: done, and the ERP has the two lines", text(r2).includes("Outcome: done") && await orders(c) === 2);
  const r3 = await c.call("soz_execute", { preview_id: id });
  check("the same preview cannot be executed twice", r3.isError && text(r3).includes("already executed"));
  const again = await c.call("soz_preview", { plan: GOOD, message: MESSAGE });
  const r4 = await c.call("soz_execute", { preview_id: previewId(again) });
  check("the same plan again orders nothing twice", text(again).includes("already done") && text(r4).includes("1 already_done, 2 already_done") && await orders(c) === 2);
  check("an unknown preview_id is refused", (await c.call("soz_execute", { preview_id: "0123456789abcdef" })).isError);

  const resources = ((await c.request("resources/list")).resources as Obj[]).map(r => r.uri);
  check("resources: guide, operations, policy", ["soz://guide", "soz://operations", "soz://policy"].every(u => resources.includes(u)));
  const ops = JSON.parse((await c.request("resources/read", { uri: "soz://operations" })).contents[0].text) as Obj[];
  check("soz://operations describes each operation", ops.some(o => o.name === "erp.add_order_line" && o.effect === "write"));
  check("an output schema's enum becomes a declared type the model can see",
        ops.some(o => o.name === "erp.get_order" && JSON.stringify(o.returns.fields.status) === JSON.stringify({ enum: ["open", "shipped"], type: "text" })));
  const prompt = await c.request("prompts/get", { name: "soz_plan_guard" });
  check("the soz_plan_guard prompt carries the rules and the guide", prompt.messages?.[0]?.content?.text?.includes("If a value is missing, ask me"));
  const cancel = await c.call("soz_preview", { plan: '(plan "x" (let ((o (erp.get_order id "SO-7"))) (if (= (get o status) "open") (erp.cancel_order order (get o id)))))',
                                              message: "Cancel order SO-7." });
  check("schema constants work through the gateway: status = \"open\" may guard a cancel", !cancel.isError && text(cancel).includes("erp.cancel_order order=SO-7"));
  const audit = text(await c.call("soz_inspect_audit", { preview_id: id }));
  check("soz_inspect_audit shows the plan's approval and outcome, and the chain", audit.includes("hash chain intact") && audit.includes('"type":"approval"') && audit.includes('"outcome":"done"'));
  c.close();
}

console.log("\nClient without elicitation, approval=elicitation");
{
  const c = await new Client(writeConfig("g2.json", "elicitation")).init(false);
  const r = await c.call("soz_execute", { preview_id: previewId(await c.call("soz_preview", { plan: GOOD, message: "Yilmaz Market: 20 tomatoes, 5 peppers" })) });
  check("a client that cannot ask the user runs nothing", r.isError && text(r).includes("cannot ask the user"));
  c.close();
}

console.log("\nApproval code (approval=auto, client without elicitation)");
{
  const codeFile = join(dir, "code.txt");
  const c = await new Client(writeConfig("g3.json", "auto"), { SOZ_TEST_CODE_FILE: codeFile }).init(false);
  const msg = "Yilmaz Market: 7 tomatoes and 3 peppers";
  const plan = GOOD.replace("quantity 20", "quantity 7").replace("quantity 5", "quantity 3");
  const p = await c.call("soz_preview", { plan, message: msg });
  const id = previewId(p)!;
  check("the preview tells the model the user will be shown a code", text(p).includes("approval code outside this chat"));
  check("a code before one was issued is refused", (await c.call("soz_execute", { preview_id: id, approval_code: "AAA-AAA" })).isError);
  const r = await c.call("soz_execute", { preview_id: id });
  check("execute without a code shows the user a code and runs nothing", text(r).includes("approval code is now shown") && await orders(c) === 0);
  const window = readFileSync(codeFile, "utf8");
  const code = /Approval code: (\w{3}-\w{3})/.exec(window)?.[1] ?? "";
  check("the window has the code, the steps and the message", code && window.includes("quantity=7") && window.includes(msg));
  check("the model never saw the code", !text(r).includes(code));
  const wrong = await c.call("soz_execute", { preview_id: id, approval_code: "XXX-XXX" });
  check("a wrong code runs nothing", wrong.isError && await orders(c) === 0);
  const ok = await c.call("soz_execute", { preview_id: id, approval_code: code.toLowerCase().replace("-", "") });
  check("the user's code, typed loosely, runs the plan", text(ok).includes("Outcome: done") && await orders(c) === 2);
  check("the same code cannot be used twice", (await c.call("soz_execute", { preview_id: id, approval_code: code })).isError);
  const id2 = previewId(await c.call("soz_preview", { plan: plan.replace("quantity 7", "quantity 3"), message: msg }))!;
  await c.call("soz_execute", { preview_id: id2 });
  const code2 = /Approval code: (\w{3}-\w{3})/.exec(readFileSync(codeFile, "utf8"))?.[1];
  for (let i = 0; i < 3; i++) await c.call("soz_execute", { preview_id: id2, approval_code: "WRONG1" });
  const locked = await c.call("soz_execute", { preview_id: id2, approval_code: code2 });
  check("three wrong codes lock the preview, even for the right code", locked.isError && text(locked).includes("locked") && await orders(c) === 2);
  c.close();
}

console.log("\nPolicy (actor ali, role sales)");
{
  const codeFile = join(dir, "code-policy.txt");
  const c = await new Client(writeConfig("g4.json", "auto", {
    actor: { id: "ali", roles: ["sales"] },
    policy: { rules: [
      { name: "orders over 10 need a manager", when: { operation: "erp.add_order_line", args: { quantity: { ">": 10 } } }, then: { approve_by: "manager" } },
      { name: "no order line of 100 or more", when: { operation: "erp.add_order_line", args: { quantity: { ">=": 100 } } }, then: { deny: "too large" } }] },
  }), { SOZ_TEST_CODE_FILE: codeFile }).init(false);
  const msg = "Yilmaz Market: 30 tomatoes, 8 peppers, or 200 tomatoes";
  const line = (product: string, q: number) => `(plan "x" (let ((c (erp.find_customer name "Yilmaz Market"))) (erp.add_order_line customer (get c code) product "${product}" quantity ${q})))`;
  check("the guide lists the policy in force", text(await c.call("soz_guide")).includes("orders over 10 need a manager"));
  const p = await c.call("soz_preview", { plan: line("tomatoes", 30), message: msg });
  check("the preview shows the approval a step needs", text(p).includes("needs approval by manager"));
  const r = await c.call("soz_execute", { preview_id: previewId(p) });
  check("a manager's approval cannot be collected here: nothing runs, no code shown", r.isError && text(r).includes("needs approval by manager") && !existsSync(codeFile) && await orders(c) === 0);
  const d = await c.call("soz_preview", { plan: line("tomatoes", 200), message: msg });
  check("a denied value: the preview says the policy does not allow it", d.isError && text(d).includes("policy does not allow") && text(d).includes("too large"));
  const id = previewId(await c.call("soz_preview", { plan: line("peppers", 8), message: msg }));
  const shown = await c.call("soz_execute", { preview_id: id });
  const code = /Approval code: (\w{3}-\w{3})/.exec(readFileSync(codeFile, "utf8"))?.[1];
  const done = await c.call("soz_execute", { preview_id: id, approval_code: code });
  check("a step the policy asks nothing more for goes through the user's own approval", text(shown).includes("approval code is now shown") && text(done).includes("Outcome: done") && await orders(c) === 1);
  c.close();
}

console.log("\nAnother person's approval (four eyes, signed)");
{
  const codeFile = join(dir, "code-four-eyes.txt");
  const ayse = newKeyPair("ayse's passphrase"), ali = newKeyPair("ali's passphrase"), veli = newKeyPair("veli's passphrase");
  const c = await new Client(writeConfig("g5.json", "auto", {
    actor: { id: "ali", roles: ["sales", "finance"] },
    approvers: [{ id: "ayse", roles: ["finance"], public_key: ayse.publicKey }, { id: "ali", roles: ["finance"], public_key: ali.publicKey },
                { id: "veli", roles: ["sales"], public_key: veli.publicKey }],
    approval_requests: "requests",
    policy: { rules: [{ name: "orders over 10: finance, four eyes", when: { operation: "erp.add_order_line", args: { quantity: { ">": 10 } } },
                        then: { approve_by: "finance", four_eyes: true } }] },
  }), { SOZ_TEST_CODE_FILE: codeFile }).init(false);
  const before = await orders(c);
  const plan = `(plan "x" (let ((c (erp.find_customer name "Yilmaz Market"))) (erp.add_order_line customer (get c code) product "tomatoes" quantity 30)))`;
  const id = previewId(await c.call("soz_preview", { plan, message: "Yilmaz Market: 30 tomatoes" }))!;
  const asked = await c.call("soz_execute", { preview_id: id });
  const path = /written to:\n  (.+)\n/.exec(text(asked))?.[1] ?? "";
  check("the gateway writes an approval request and names who can approve (not ali himself)",
        asked.isError && existsSync(path) && text(asked).includes("approval by finance (someone other than ali): ayse") && !existsSync(codeFile));
  const req = readRequest(readFileSync(path, "utf8"));
  check("the request's hash is the preview's", req.hash === id && req.requires[0]?.fourEyes === true);
  const tampered = readFileSync(path, "utf8").replace('"quantity":30', '"quantity":3');
  let refused = false;
  try { readRequest(tampered); } catch { refused = true; }
  check("an edited request is refused: its steps no longer match its hash", refused && tampered !== readFileSync(path, "utf8"));

  const exp = Math.floor(Date.now() / 1000) + 3600;
  const tok = (who: string, k: { privatePem: string }, pass: string, hash = id, e = exp) => signApproval(hash, who, e, openPrivateKey(k.privatePem, pass));
  const ayseTok = tok("ayse", ayse, "ayse's passphrase");
  const forged = ayseTok.slice(0, -3) + (ayseTok.endsWith("AAA") ? "BBB" : "AAA");
  const tries: [string, string, string][] = [
    ["a forged signature", forged, "not ayse's approval"],
    ["ayse's approval of another preview", tok("ayse", ayse, "ayse's passphrase", "0".repeat(64)), "not ayse's approval"],
    ["an expired approval", tok("ayse", ayse, "ayse's passphrase", id, 1000), "expired"],
    ["a key that is not ayse's, under her name", tok("ayse", veli, "veli's passphrase"), "not ayse's approval"],
    ["someone the gateway does not know", tok("mallory", veli, "veli's passphrase"), "not an approver"],
  ];
  for (const [what, t, why] of tries) {
    const r = await c.call("soz_execute", { preview_id: id, approvals: [t] });
    check(`${what} is not accepted, nothing runs`, r.isError && text(r).includes(why) && !existsSync(codeFile) && await orders(c) === before);
  }
  const own = await c.call("soz_execute", { preview_id: id, approvals: [tok("ali", ali, "ali's passphrase")] });
  check("ali's own signed approval is not taken: he approves in his own window", own.isError && text(own).includes("ali is the user") && text(own).includes("someone other than ali") && await orders(c) === before);
  const wrongRole = await c.call("soz_execute", { preview_id: id, approvals: [tok("veli", veli, "veli's passphrase")] });
  check("veli's approval is not taken: the role comes from the gateway, and he is not finance", wrongRole.isError && text(wrongRole).includes("no approval veli can give") && await orders(c) === before);

  const shown = await c.call("soz_execute", { preview_id: id, approvals: [ayseTok] });
  const window = existsSync(codeFile) ? readFileSync(codeFile, "utf8") : "";
  check("with ayse's approval, ali is shown his own approval code, which says ayse approved", text(shown).includes("approval code is now shown")
        && window.includes("Also approved by: ayse (finance)") && await orders(c) === before);
  const code = /Approval code: (\w{3}-\w{3})/.exec(window)?.[1];
  const done = await c.call("soz_execute", { preview_id: id, approval_code: code });
  check("ali's code then runs it: two people approved", text(done).includes("Outcome: done") && await orders(c) === before + 1);
  const approval = readFileSync(join(dir, "audit.jsonl"), "utf8").split("\n").filter(l => l.includes('"type":"approval"') && l.includes(id)).map(l => JSON.parse(l))[0];
  check("the audit record keeps both approvers and ayse's signed token",
        approval?.data?.approvers?.map((a: Obj) => a.id).join() === "ali,ayse" && approval?.data?.signatures?.[0] === ayseTok);

  const cli = (args: string[]) => new Promise<{ code: number | null; out: string }>(res => {
    const p = spawn(process.execPath, [...NODE, join(here, "..", "src", "approve-cli.ts"), ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", d => { out += String(d); }); p.stderr?.on("data", d => { out += String(d); });
    p.stdin.write("yes\nayse's passphrase\n"); p.stdin.end();
    p.on("close", code => res({ code, out }));
  });
  const shownByCli = await cli(["show", path]);
  check("soz-approve show prints the steps of a request", shownByCli.code === 0 && shownByCli.out.includes("erp.add_order_line") && shownByCli.out.includes("quantity: 30"));
  writeFileSync(join(dir, "tampered.json"), tampered);
  const bad = await cli(["show", join(dir, "tampered.json")]);
  check("soz-approve refuses an edited request", bad.code === 2 && bad.out.includes("was changed"));
  writeFileSync(join(dir, "ayse.soz-key"), JSON.stringify({ soz_key: 1, id: "ayse", private_key: ayse.privatePem }));
  const piped = await cli([path, "--key", join(dir, "ayse.soz-key")]);
  check("soz-approve does not approve from piped input: a person types it in a terminal", piped.code === 2 && piped.out.includes("needs a terminal") && !piped.out.includes("soz1."));
  c.close();
}

console.log("\nA plan in the JSON syntax");
{
  const codeFile = join(dir, "code-json.txt");
  const c = await new Client(writeConfig("g6.json", "auto", { journal: "journal-json.jsonl" }), { SOZ_TEST_CODE_FILE: codeFile }).init(false);
  const before = await orders(c);
  const schema = JSON.parse((await c.request("resources/read", { uri: "soz://plan-schema" })).contents?.[0]?.text ?? "null");
  check("the resource soz://plan-schema is the plan's JSON Schema", schema?.required?.includes("plan") && schema?.$defs?.expr?.anyOf?.length === 13);
  const plan = JSON.stringify({ plan: "Order for Yilmaz Market", body: [
    { let: [{ name: "c", value: { call: "erp.find_customer", args: [{ name: "name", value: "Yilmaz Market" }] } }],
      body: [{ call: "erp.add_order_line", args: [{ name: "customer", value: { get: { var: "c" }, field: "code" } },
                                                 { name: "product", value: "tomatoes" }, { name: "quantity", value: 20 }] }] }] });
  const p = await c.call("soz_preview", { plan, message: MESSAGE });
  check("a JSON plan is previewed like an s-expression", !p.isError && text(p).includes("erp.add_order_line") && !!previewId(p));
  const invented = await c.call("soz_preview", { plan: plan.replace('"value":20', '"value":25'), message: MESSAGE });
  check("an invented value in a JSON plan is refused, with its JSON position", invented.isError && text(invented).includes("[invented-value]") && text(invented).includes("line 1"));
  const id = previewId(p);
  await c.call("soz_execute", { preview_id: id });
  const code = /Approval code: (\w{3}-\w{3})/.exec(readFileSync(codeFile, "utf8"))?.[1];
  const done = await c.call("soz_execute", { preview_id: id, approval_code: code });
  check("and executed after the user's approval", text(done).includes("Outcome: done") && await orders(c) === before + 1);
  c.close();
}

console.log("\nAudit record across restarts");
{
  const lines = readFileSync(join(dir, "audit.jsonl"), "utf8").split("\n").filter(l => l.trim());
  check("four gateway sessions wrote one audit record, and its chain is intact",
        lines.filter(l => JSON.parse(l).seq === 1).length === 1 && verifyAudit(join(dir, "audit.jsonl")) === true);
}

await new Promise(r => setTimeout(() => r(null), 300));
rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} FAILED` : "All gateway tests passed"}`);
process.exit(failed ? 1 : 0);
