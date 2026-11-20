// gateway.ts — The soz MCP gateway (SPEC 11), with no dependencies: an MCP server over stdio in
// front of other MCP servers. Tools that only read pass through; tools that change something are
// never offered to the model: it writes a plan, the gateway previews it, the person approves it
// (MCP elicitation, or a one-time code shown outside the chat), and the gateway executes exactly that.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { randomInt } from "node:crypto";
import { Rational, type Json, type HostValue, isObject, newObject, canonicalJson, parseJson, nameFold } from "./exact.ts";
import {
  type Operation, type Operations, type Param, type Type, type Rule, type Actor,
  typeFromJson, typeName, typeToJson, isSideEffect, policyFromJson, actorFromJson, errorReport,
} from "./checker.ts";
import {
  type Implementations, type Preview, type Execution, type Requirement,
  preview, execute, previewSummary, Journal, Audit, verifyAudit, OperationFailed, OperationUnknown,
  unmetRequirements, requirementsText,
} from "./run.ts";

const log = (m: string) => process.stderr.write(`soz-gateway: ${m}\n`);
const PROTOCOL = "2025-06-18";
const VERSION = "0.3.0";

// --- JSON-RPC over newline-delimited stdio ----------------------------------------------------------

type Message = { [k: string]: Json };
type Pending = { resolve: (m: Message) => void; reject: (e: Error) => void; timer: unknown };

class Timeout extends Error {}

/** One end of a JSON-RPC connection. Numbers stay exact in both directions. */
class Rpc {
  pending = new Map<string, Pending>();
  next = 0;
  out: { write(s: string): unknown };
  prefix: string;
  onRequest: (m: Message) => Promise<Json>;
  constructor(out: { write(s: string): unknown }, prefix: string, onRequest: (m: Message) => Promise<Json>) {
    this.out = out; this.prefix = prefix; this.onRequest = onRequest;
  }
  send(m: Message | { [k: string]: unknown }) { this.out.write(canonicalJson(m) + "\n"); }
  request(method: string, params: unknown, timeoutMs = 60000): Promise<Message> {
    const id = `${this.prefix}${++this.next}`;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Timeout(`${method} did not answer in ${timeoutMs / 1000}s`)); }, timeoutMs);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.send({ jsonrpc: "2.0", id, method, params: params ?? newObject() });
    });
  }
  notify(method: string, params?: unknown) { this.send(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method }); }
  failAll(e: Error) { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(e); this.pending.delete(id); } }
  /** One line from the other end. */
  receive(line: string) {
    if (!line.trim()) return;
    let m: Message;
    try { m = parseJson(line) as Message; } catch { return; }
    const id = m.id === undefined ? undefined : m.id instanceof Rational ? m.id.toString() : String(m.id);
    if (m.method === undefined && id !== undefined) {           // a response to us
      const p = this.pending.get(id);
      if (p) { clearTimeout(p.timer); this.pending.delete(id); p.resolve(m); }
      return;
    }
    if (typeof m.method !== "string" || m.id === undefined) return; // notifications
    this.onRequest(m).then(
      result => this.send({ jsonrpc: "2.0", id: m.id, result }),
      e => this.send({ jsonrpc: "2.0", id: m.id, error: { code: (e as { code?: number }).code ?? -32603, message: (e as Error).message } }));
  }
}

class RpcError extends Error { code: number; constructor(code: number, m: string) { super(m); this.code = code; } }

// --- Downstream MCP servers ------------------------------------------------------------------------

type Tool = { name: string; description?: string; inputSchema?: Json; outputSchema?: Json; annotations?: Json };

class Downstream {
  name: string; rpc: Rpc; proc: ChildProcess; tools: Tool[] = []; alive = true;
  constructor(name: string, proc: ChildProcess) {
    this.name = name; this.proc = proc;
    this.rpc = new Rpc(proc.stdin, "g", async () => { throw new RpcError(-32601, "not supported by soz-gateway"); });
    createInterface({ input: proc.stdout }).on("line", l => this.rpc.receive(l));
    proc.on("exit", () => { this.alive = false; this.rpc.failAll(new Timeout(`${name} exited`)); });
  }
}

function startProcess(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<ChildProcess> {
  const run = (cmd: string, a: string[]) => spawn(cmd, a, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  return new Promise((res, rej) => {
    const p = run(command, args);
    let settled = false;
    p.on("error", e => {
      if (settled) return;
      settled = true;
      // npx.cmd and friends on Windows need cmd /c
      if (e.code === "ENOENT" && process.platform === "win32") {
        const q = run("cmd", ["/c", command, ...args]);
        q.on("error", rej);
        res(q);
      } else rej(e);
    });
    setTimeout(() => { if (!settled) { settled = true; res(p); } }, 50);
  });
}

async function connect(name: string, spec: Json, base: string): Promise<Downstream> {
  if (!isObject(spec) || typeof spec.command !== "string")
    throw new Error(`${name}: a server needs a command (MCP over HTTP is not supported yet)`);
  const env = isObject(spec.env) ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, String(v)])) : {};
  const proc = await startProcess(spec.command, ((spec.args ?? []) as Json[]).map(String), base, env);
  const d = new Downstream(name, proc);
  const init = await d.rpc.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "soz-gateway", version: VERSION } });
  if (init.error) throw new Error(`${name}: initialize failed: ${canonicalJson(init.error)}`);
  d.rpc.notify("notifications/initialized");
  let cursor: Json | undefined;
  do {
    const r = await d.rpc.request("tools/list", cursor ? { cursor } : {});
    const res = r.result as { tools?: Tool[]; nextCursor?: Json } | undefined;
    d.tools.push(...(res?.tools ?? []));
    cursor = typeof res?.nextCursor === "string" ? res.nextCursor : undefined;
  } while (cursor);
  return d;
}

// --- Tools -> soz operations (SPEC 11.1) ---------------------------------------------------------------

function schemaType(s: Json | undefined, output: boolean): Type {
  if (!isObject(s)) return "any";
  const ty = s.type;
  if (output && Array.isArray(s.enum) && (ty === "string" || ty === "number" || ty === "integer"))
    return { kind: "enum", base: ty === "string" ? "text" : "number", values: s.enum as (string | Rational)[] };
  if (ty === "string") return "text";
  if (ty === "number" || ty === "integer") return "number";
  if (ty === "boolean") return "bool";
  if (output && ty === "array") return { kind: "list", item: schemaType(s.items, true) };
  if (output && ty === "object" && Array.isArray(s.required) && isObject(s.properties)) {
    const props = s.properties;
    return { kind: "record", fields: (s.required as string[]).map(k => [nameFold(k), schemaType(props[k], true)] as [string, Type])
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) };
  }
  return "any";
}

function toolOperation(server: string, tool: Tool, overrides: Json | undefined): Operation {
  const name = `${server}.${tool.name}`;
  const o = isObject(overrides) && isObject(overrides[name]) ? overrides[name] as { [k: string]: Json } : null;
  const input = isObject(tool.inputSchema) ? tool.inputSchema : null;
  const required = Array.isArray(input?.required) ? input!.required as string[] : [];
  const allowed = Array.isArray(o?.model_allowed) ? o!.model_allowed as string[] : [];
  const readOnly = isObject(tool.annotations) && tool.annotations.readOnlyHint === true;
  const params: Param[] = isObject(input?.properties) ? Object.entries(input!.properties).map(([k, v]) => ({
    name: k, type: schemaType(v, false), required: required.includes(k), modelAllowed: allowed.includes(k),
  })) : [];
  return {
    name, params,
    effect: typeof o?.effect === "string" ? o.effect : readOnly ? "read" : "write",
    returns: o?.returns !== undefined ? typeFromJson(o.returns) : tool.outputSchema ? schemaType(tool.outputSchema, true) : "any",
    key: Array.isArray(o?.key) ? o!.key as string[] : null,
  };
}

const resultText = (r: Json) => ((isObject(r) && Array.isArray(r.content) ? r.content : []) as Json[])
  .filter(c => isObject(c) && c.type === "text").map(c => (c as { text: string }).text).join("\n");

/** structuredContent, else the text parsed as JSON (numbers exact), else the text. */
function toolValue(r: Json): HostValue {
  if (isObject(r) && r.structuredContent !== undefined) return r.structuredContent;
  const text = resultText(r);
  try { return parseJson(text); } catch { return text; }
}

// --- Configuration ---------------------------------------------------------------------------------------

export type Gateway = {
  servers: Downstream[]; passthrough: { name: string; server: Downstream; tool: Tool }[];
  operations: Operations; implementations: Implementations;
  journal: Journal; audit: Audit; auditPath: string;
  approval: "auto" | "elicitation" | "code" | "client";
  policy: Rule[]; actor: Actor | null;
  previews: Map<string, Preview>; codes: Map<string, { code: string | null; expires: number; wrong: number }>;
};

export async function loadGateway(configPath: string): Promise<Gateway> {
  const base = dirname(resolve(configPath));
  const at = (p: string) => isAbsolute(p) ? p : resolve(base, p);
  const config = parseJson(readFileSync(configPath, "utf8"));
  if (!isObject(config)) throw new Error("the config must be a JSON object");
  const approval = (config.approval ?? "auto") as Gateway["approval"];
  if (!["auto", "elicitation", "code", "client"].includes(approval))
    throw new Error(`approval must be "auto", "elicitation", "code" or "client", not ${JSON.stringify(approval)}`);
  const policyJson = typeof config.policy === "string" ? parseJson(readFileSync(at(config.policy), "utf8")) : config.policy;
  const auditPath = at(typeof config.audit === "string" ? config.audit : "soz-audit.jsonl");
  const g: Gateway = {
    servers: [], passthrough: [], operations: new Map(), implementations: new Map(),
    journal: Journal.open(at(typeof config.journal === "string" ? config.journal : "soz-journal.jsonl")),
    audit: Audit.open(auditPath), auditPath, approval,
    policy: policyFromJson(policyJson ?? []), actor: actorFromJson(config.actor),
    previews: new Map(), codes: new Map(),
  };
  const exposeReads = config.expose_reads !== false;
  for (const [name, spec] of Object.entries(isObject(config.servers) ? config.servers : {})) {
    let d: Downstream;
    try { d = await connect(name, spec, base); }
    catch (e) { log(`${name}: ${(e as Error).message}`); continue; }
    g.servers.push(d);
    for (const tool of d.tools) {
      const op = toolOperation(name, tool, config.operations);
      g.operations.set(nameFold(op.name), op);
      g.implementations.set(nameFold(op.name), args => callTool(d, tool.name, args));
      if (exposeReads && !isSideEffect(op.effect)) g.passthrough.push({ name: `${name}_${tool.name}`, server: d, tool });
    }
    log(`${name}: ${d.tools.length} tools`);
  }
  return g;
}

async function callTool(d: Downstream, tool: string, args: Json): Promise<HostValue> {
  let r: Message;
  try { r = await d.rpc.request("tools/call", { name: tool, arguments: args }); }
  catch (e) { throw new OperationUnknown(`${d.name} did not answer (${(e as Error).message})`); }
  if (r.error) throw new OperationFailed(isObject(r.error) ? String(r.error.message) : "error");
  if (isObject(r.result) && r.result.isError === true) throw new OperationFailed(resultText(r.result));
  return toolValue(r.result ?? null);
}

// --- What the model sees ---------------------------------------------------------------------------------

function operationsText(g: Gateway): string {
  return [...g.operations.values()].sort((a, b) => a.name < b.name ? -1 : 1).map(op =>
    `- (${op.name}${op.params.map(p => ` ${p.name} <${typeName(p.type)}${p.required ? "" : ", optional"}${p.modelAllowed ? ", your own text allowed" : ""}>`).join("")})  effect: ${op.effect}`
    + (op.returns === "any" ? "" : `; returns ${typeName(op.returns)}`)).join("\n");
}

export function guideText(g: Gateway): string {
  return `soz plans: how to change anything through this gateway.

Tools that only read can be called directly. Everything that changes something (writes, sends,
pays) goes through a plan: call soz_preview with the plan and the user's message, show the user
the preview, and call soz_execute only after they agree. The user approves in their own client or
by telling you a code shown to them outside the chat; you cannot approve for them.

A plan is one s-expression:

  (plan "title" EXPR ...)

Forms: (let ((name EXPR) ...) BODY...)   (for-each (name LIST) BODY...)   (if COND THEN [ELSE])
       (do EXPR ...)   (stop "reason" ...)   (list EXPR ...)   (record field EXPR ...)
       (get RECORD field)   + - * /   = != < > <= >=   and or not
Calls:  (operation param EXPR param EXPR ...)   ; parameters by name, in any order
Values: "text", numbers like 20 or 12.5, names bound by let or for-each. Nothing else: no quotes,
        no #, no colons.

Rules the checker enforces (it explains every error with line and column):
- Every number and text you write in the plan must appear in the user's message, or come from an
  operation's result. A value you made up cannot go to an operation that changes something, and
  such an operation cannot sit under an \`if\` whose condition contains a made-up value. If you do
  not know a value, look it up with a read, or stop and ask: (stop "Which customer?").
- What a read returns for a value you made up is not trusted either.
- Pass the user's message to soz_preview exactly as they wrote it.
- Loops run only over lists, at most 50 items.

Operations:
${operationsText(g)}
${g.policy.length ? `\nPolicy in force${g.actor ? ` for ${g.actor.id} (${g.actor.roles.join(", ")})` : ""}:\n${g.policy.map(r => `- ${r.name}`).join("\n")}\n` : ""}
Example (the operation names here may differ from this gateway's):
  (plan "Order for Yilmaz Market"
    (let ((c (erp.find_customer name "Yilmaz Market")))
      (if (> (get c balance) (get c limit))
          (stop "Yilmaz Market is over its credit limit")
          (for-each (line (list (record product "tomatoes" quantity 20)
                                (record product "peppers" quantity 5)))
            (erp.add_order_line customer (get c code) product (get line product)
                                quantity (get line quantity))))))`;
}

const stringProp = (description: string) => ({ type: "string", description });

function toolList(g: Gateway) {
  return [
    { name: "soz_guide", description: "How to write a soz plan, the operations available and the policy in force. Read this before your first plan.",
      inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    { name: "soz_preview", description: "Check a soz plan and preview it: reads run, nothing is changed. Returns the steps the plan would take and a preview_id, or the errors to fix.",
      inputSchema: { type: "object", properties: { plan: stringProp('The plan, one (plan "title" ...) s-expression.'),
                                                   message: stringProp("The user's request, exactly as they wrote it.") },
                     required: ["plan", "message"] },
      annotations: { readOnlyHint: true } },
    { name: "soz_execute", description: "Run a previewed plan. The user approves it first: in their client, or by telling you the approval code shown to them outside the chat. Nothing runs without that approval.",
      inputSchema: { type: "object", properties: { preview_id: stringProp("The preview_id returned by soz_preview."),
                                                   approval_code: stringProp("Only the code the user told you. Never guess it.") },
                     required: ["preview_id"] },
      annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: "soz_inspect_audit", description: "What happened to a plan: its preview, approval, every call and the outcome, from the audit record, and whether the record's hash chain is intact.",
      inputSchema: { type: "object", properties: { preview_id: stringProp("A preview_id; without it, the most recent records.") } },
      annotations: { readOnlyHint: true } },
    ...g.passthrough.map(p => ({ name: p.name, description: p.tool.description ?? "", inputSchema: p.tool.inputSchema ?? { type: "object" },
                                 annotations: { readOnlyHint: true } })),
  ];
}

const textResult = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });

// --- Approval codes (SPEC 11.3) ---------------------------------------------------------------------------

const CODE_ALPHABET = "ACDEFHJKLMNPRTUVWXY3479", CODE_LIFETIME = 600, CODE_ATTEMPTS = 3;

function newCode(): string {
  let c = "";
  for (let i = 0; i < 6; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}
const normalizeCode = (s: unknown) => typeof s === "string" ? s.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase() : "";

function base64(text: string): string {
  const b = new TextEncoder().encode(text), abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const v = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += abc[(v >> 18) & 63] + abc[(v >> 12) & 63] + (i + 1 < b.length ? abc[(v >> 6) & 63] : "=") + (i + 2 < b.length ? abc[v & 63] : "=");
  }
  return out;
}

/** A window of its own on the user's screen; the text goes through stdin, never a command line. */
function showToUser(title: string, text: string): boolean {
  const testFile = process.env.SOZ_TEST_CODE_FILE;
  if (testFile) { writeFileSync(testFile, text); return true; }
  const run = (cmd: string, args: string[], script: string) => {
    try {
      const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      p.on("error", e => log(`could not show the approval window: ${e.message}`));
      p.stdin.write(script); p.stdin.end();
      return true;
    } catch (e) { log(`could not show the approval window: ${(e as Error).message}`); return false; }
  };
  if (process.platform === "win32")
    return run("powershell", ["-NoProfile", "-NonInteractive", "-Sta", "-Command", "-"],
      `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(text)}'))\n`
      + `$h=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(title)}'))\n`
      + `Add-Type -AssemblyName System.Windows.Forms\n`
      + `[void][System.Windows.Forms.MessageBox]::Show($t,$h,'OK','Information','Button1','DefaultDesktopOnly')\n`);
  if (process.platform === "darwin")
    return run("osascript", [], `display dialog "${text.replaceAll('"', "'")}" with title "${title.replaceAll('"', "'")}" buttons {"OK"} default button 1\n`);
  return false;
}

// --- The MCP server side -----------------------------------------------------------------------------------

export class GatewayServer {
  g: Gateway;
  client: Rpc;
  capabilities: Json = null;
  constructor(g: Gateway, out: { write(s: string): unknown }) {
    this.g = g;
    this.client = new Rpc(out, "soz-", m => this.handle(m));
  }
  receive(line: string) { this.client.receive(line); }

  private elicits(): boolean { return isObject(this.capabilities) && this.capabilities.elicitation !== undefined; }
  private codeMode(): boolean { return this.g.approval === "code" || (this.g.approval === "auto" && !this.elicits()); }

  async handle(m: Message): Promise<Json> {
    const params = isObject(m.params) ? m.params : newObject();
    switch (m.method) {
      case "initialize":
        this.capabilities = params.capabilities ?? null;
        return { protocolVersion: (params.protocolVersion as string) ?? PROTOCOL,
                 capabilities: { tools: {}, resources: {}, prompts: {} },
                 serverInfo: { name: "soz-gateway", version: VERSION },
                 instructions: "Changes go through soz plans: read soz_guide (or the soz://guide resource), then soz_preview, then soz_execute after the user agrees." } as unknown as Json;
      case "ping": return newObject();
      case "tools/list": return { tools: toolList(this.g) } as unknown as Json;
      case "tools/call":
        try { return await this.callTool(params.name as string, isObject(params.arguments) ? params.arguments : newObject()) as unknown as Json; }
        catch (e) { return textResult(`soz-gateway error: ${(e as Error).message}`, true) as unknown as Json; }
      case "resources/list": return { resources: [
        { uri: "soz://guide", name: "soz guide", description: "How to write a soz plan, the operations and the policy.", mimeType: "text/plain" },
        { uri: "soz://operations", name: "operations", description: "The operations a plan may call, with parameters and effects.", mimeType: "application/json" },
        { uri: "soz://policy", name: "policy", description: "The policy in force and the person it applies to.", mimeType: "application/json" },
      ] } as unknown as Json;
      case "resources/read": return { contents: [{ uri: params.uri, ...this.resource(params.uri as string) }] } as unknown as Json;
      case "prompts/list": return { prompts: [{ name: "soz_plan_guard", description: "Rules for working through soz: plan, preview, ask, execute; never make up values." }] } as unknown as Json;
      case "prompts/get":
        if (params.name !== "soz_plan_guard") throw new RpcError(-32602, `unknown prompt ${String(params.name)}`);
        return { description: "Working through soz", messages: [{ role: "user", content: { type: "text", text:
          "In this conversation, change nothing directly. For anything that writes, sends or pays: write a soz plan using only values from my message or from reads, preview it with soz_preview, show me the steps, and execute only after I agree. If a value is missing, ask me instead of guessing. When the checker reports errors, fix exactly those.\n\n" + guideText(this.g) } }] } as unknown as Json;
    }
    throw new RpcError(-32601, `method not found: ${String(m.method)}`);
  }

  private resource(uri: string): { mimeType: string; text: string } {
    if (uri === "soz://guide") return { mimeType: "text/plain", text: guideText(this.g) };
    if (uri === "soz://operations") return { mimeType: "application/json", text: canonicalJson([...this.g.operations.values()].map(op => ({
      name: op.name, effect: op.effect, returns: typeToJson(op.returns), key: op.key,
      params: op.params.map(p => ({ name: p.name, type: typeToJson(p.type), required: p.required, model_allowed: p.modelAllowed })) }))) };
    if (uri === "soz://policy") return { mimeType: "application/json", text: canonicalJson({ actor: this.g.actor,
      rules: this.g.policy.map(r => ({ name: r.name, operations: r.operations, effects: r.effects, actor_role: r.actorRoles,
        actor_not_role: r.actorNotRoles, args: r.args, then: r.decision })) }) };
    throw new RpcError(-32002, `unknown resource ${uri}`);
  }

  private findPreview(id: unknown): Preview | null {
    if (typeof id !== "string" || id.length < 12) return null;
    const hits = [...this.g.previews.entries()].filter(([k]) => k.startsWith(id)).map(([, p]) => p);
    return hits.length === 1 ? hits[0] : null;
  }

  private unmetHere(p: Preview): Requirement[] {
    const reqs = p.steps.filter(s => !s.alreadyDone).flatMap(s => s.requires)
      .filter((r, i, all) => all.findIndex(x => x.role === r.role && x.fourEyes === r.fourEyes && x.rule === r.rule) === i);
    return unmetRequirements(reqs, this.g.actor ? [this.g.actor] : [], this.g.actor);
  }

  private executionText(e: Execution): string {
    return `Outcome: ${e.outcome}${e.message ? ` — ${e.message}` : ""}${e.stopReason ? `\nThe plan stopped: ${e.stopReason}` : ""}\nSteps: ${e.steps.map(s => `${s.index} ${s.status}`).join(", ")}`;
  }

  private run(p: Preview, by: string) {
    return execute(p, p.hash!, { implementations: this.g.implementations, journal: this.g.journal, audit: this.g.audit, approvedBy: by });
  }

  async callTool(name: string, args: { [k: string]: Json }) {
    const g = this.g;
    if (name === "soz_guide") return textResult(guideText(g));
    if (name === "soz_preview") {
      if (typeof args.plan !== "string") return textResult("plan is required", true);
      const p = await preview(args.plan, { message: typeof args.message === "string" ? args.message : null, operations: g.operations,
                                           implementations: g.implementations, journal: g.journal, audit: g.audit, policy: g.policy, actor: g.actor });
      if (p.hash) g.previews.set(p.hash, p);
      if (p.status === "invalid") return textResult(errorReport(p.check), true);
      if (p.status === "denied") return textResult(`${previewSummary(p)}The policy does not allow this plan. Tell the user why; do not try to get around it.`, true);
      if (p.hash) return textResult(`${previewSummary(p)}preview_id: ${p.hash}\n\nShow the user these steps. Call soz_execute with this preview_id only after they agree; `
        + (this.codeMode() ? "the user is then shown an approval code outside this chat, and you ask them for it." : "they will be asked to approve in their client."));
      return textResult(previewSummary(p), p.status === "error");
    }
    if (name === "soz_execute") {
      const p = this.findPreview(args.preview_id);
      if (!p) return textResult("No preview with that preview_id. Call soz_preview first and use the preview_id it returns.", true);
      if (p.used) return textResult("This preview was already executed. To run the plan again, preview it again; the user approves again.", true);
      const unmet = this.unmetHere(p);
      if (unmet.length) return textResult(`This plan needs ${requirementsText(unmet, g.actor)}. This gateway can only collect the approval of ${g.actor?.id ?? "the user"}. Nothing ran.`, true);
      if (this.codeMode()) return this.executeWithCode(p, args.approval_code);
      if (g.approval === "client") return textResult(this.executionText(await this.run(p, "user (client tool approval)")));
      if (!this.elicits()) return textResult("This client cannot ask the user for approval (MCP elicitation), and this gateway requires it. Nothing ran.", true);
      const r = await this.client.request("elicitation/create", {
        message: `${previewSummary(p)}The assistant based this on your message:\n  ${p.message ?? "(no message)"}\n\nApprove these steps?`,
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve", description: "Run exactly these steps" } }, required: ["approve"] },
      }, 10 * 60 * 1000).catch(() => null);
      const res = r && isObject(r.result) ? r.result : null;
      if (!(res && res.action === "accept" && isObject(res.content) && res.content.approve === true)) return textResult("The user did not approve. Nothing ran.");
      return textResult(this.executionText(await this.run(p, "user (MCP elicitation)")));
    }
    if (name === "soz_inspect_audit") return textResult(this.inspect(args.preview_id));
    const pass = g.passthrough.find(x => x.name === name);
    if (!pass) return textResult(`Unknown tool ${name}. Changes go through soz_preview and soz_execute.`, true);
    let r: Message;
    try { r = await pass.server.rpc.request("tools/call", { name: pass.tool.name, arguments: args }); }
    catch { return textResult(`${pass.server.name} did not answer.`, true); }
    if (r.error) return textResult(isObject(r.error) ? String(r.error.message) : "error", true);
    return r.result;
  }

  private executeWithCode(p: Preview, given: unknown) {
    const g = this.g, key = p.hash!, now = Date.now() / 1000, pending = g.codes.get(key);
    if (pending && pending.code === null) return textResult("Too many wrong approval codes for this preview; it is locked. Preview the plan again.", true);
    if (!normalizeCode(given)) {
      const code = newCode();
      const window = `Approval code: ${code}\n\n${previewSummary(p)}\nThe assistant based this on your message:\n  ${p.message ?? "(no message)"}\n\nIf you agree, type this code in the chat. If not, ignore it.\nThe code works once and expires in ${CODE_LIFETIME / 60} minutes.`;
      if (!showToUser("soz: approve these steps?", window)) return textResult("Could not show the approval code to the user on this system. Nothing ran.", true);
      g.codes.set(key, { code, expires: now + CODE_LIFETIME, wrong: 0 });
      return textResult("An approval code is now shown to the user in a window outside this chat. Ask them to read the steps there and, if they agree, to tell you the code. Then call soz_execute again with preview_id and approval_code. Nothing has run.");
    }
    if (!pending) return textResult("No approval code was issued for this preview. Call soz_execute with only the preview_id first; the user is then shown a code.", true);
    if (now > pending.expires) { g.codes.delete(key); return textResult("The approval code expired. Call soz_execute with only the preview_id to show the user a new one. Nothing ran.", true); }
    if (normalizeCode(given) === normalizeCode(pending.code)) {
      g.codes.delete(key);
      return this.run(p, "user (approval code)").then(e => textResult(this.executionText(e)));
    }
    pending.wrong++;
    if (pending.wrong >= CODE_ATTEMPTS) { pending.code = null; return textResult("Wrong approval code, too many times; this preview is locked. Nothing ran.", true); }
    return textResult(`Wrong approval code. Nothing ran. Ask the user to check the code in their window (${CODE_ATTEMPTS - pending.wrong} tries left).`, true);
  }

  private inspect(id: unknown): string {
    if (!existsSync(this.g.auditPath)) return "The audit record is empty.";
    const lines = readFileSync(this.g.auditPath, "utf8").split("\n").filter(l => l.trim());
    const chain = verifyAudit(this.g.auditPath);
    let picked: string[];
    if (typeof id === "string" && id.length >= 12) {
      // the preview and approval records name the hash; calls and the outcome follow the approval
      picked = [];
      let following = false;
      for (const l of lines) {
        const type = (parseJson(l) as { type: string }).type;
        if (l.includes(id)) { picked.push(l); following = type === "approval"; continue; }
        if (following) { picked.push(l); if (type === "outcome") following = false; }
      }
      if (!picked.length) return `No audit records for ${id}.`;
    } else picked = lines.slice(-20);
    return `Audit record ${this.g.auditPath}: ${lines.length} records, hash chain ${chain === true ? "intact" : `broken at record ${chain}`}.\n\n${picked.join("\n")}`;
  }
}

export async function main(configPath: string) {
  const g = await loadGateway(configPath);
  const server = new GatewayServer(g, process.stdout);
  createInterface({ input: process.stdin }).on("line", l => server.receive(l)).on("close", () => {
    for (const d of g.servers) d.proc.kill();
    process.exit(0);
  });
}
