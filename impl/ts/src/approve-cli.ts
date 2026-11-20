// approve-cli.ts — soz-approve: for the other person a plan needs (approval by finance, four eyes).
// Runs on their own machine, with their own key; never a tool the model gets.
//
//   soz-approve keygen ID                  a key pair: the private key (passphrase protected) in ID.soz-key,
//                                          the public key printed for the gateway's "approvers"
//   soz-approve show REQUEST               shows what a request asks to approve
//   soz-approve REQUEST --key ID.soz-key [--hours 24]
//                                          shows it, asks, and prints an approval token
//
// Approving needs a terminal: a passphrase typed by a person, never piped in by a program.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { canonicalJson, isObject, parseJson, visible, Rational, type Json } from "./exact.ts";
import { newKeyPair, openPrivateKey, readRequest, signApproval, type ApprovalRequest } from "./approvals.ts";

const out = (s: string) => process.stdout.write(s);
const fail = (s: string): never => { process.stderr.write(`soz-approve: ${s}\n`); process.exit(2); };

function valueText(v: Json): string {
  if (typeof v === "string") return v;
  if (v instanceof Rational) return v.decimal() ?? `${v.n}/${v.d}`;
  return canonicalJson(v);
}

function requestText(r: ApprovalRequest): string {
  let o = `Approval request ${r.hash.slice(0, 12)} (created ${visible(r.created)})\n`;
  o += `Gateway: ${visible(r.gateway)}   (your approval is valid only there, only for this request)\n`;
  o += `Asked by: ${r.actor ? `${visible(r.actor)} (${r.actorRoles.map(visible).join(", ")})` : "(not given)"}\n`;
  o += `Their message: ${r.message === null ? "(none)" : visible(r.message)}\n\nSteps:\n`;
  r.steps.forEach((s, i) => {
    const step = isObject(s) ? s : {};
    o += `  ${i + 1}. ${visible(String(step.operation))}\n`;
    if (isObject(step.args)) for (const [k, v] of Object.entries(step.args)) o += `       ${visible(k)}: ${visible(valueText(v))}\n`;
  });
  if (r.requires.length) o += `\nIt needs: ${r.requires.map(x => `approval by ${visible(x.role)}${x.fourEyes ? " (four eyes)" : ""} (rule "${visible(x.rule)}")`).join("; ")}\n`;
  return o;
}

/** Reads a line from the terminal; with HIDDEN, nothing is echoed. */
function ask(question: string, hidden = false): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || !stdin.setRawMode) fail("this needs a terminal: a person types the answer");
  out(question);
  return new Promise(done => {
    let line = "";
    stdin.setRawMode!(true); stdin.setEncoding?.("utf8"); stdin.resume?.();
    const onData = (chunk: unknown) => {
      for (const c of String(chunk)) {
        if (c === "\u0003") { out("\n"); process.exit(130); }
        if (c === "\r" || c === "\n") {
          stdin.setRawMode!(false); stdin.pause?.(); stdin.removeListener?.("data", onData); out("\n"); done(line); return;
        }
        if (c === "\u007f" || c === "\b") { if (line) { line = line.slice(0, -1); if (!hidden) out("\b \b"); } continue; }
        line += c; if (!hidden) out(c);
      }
    };
    stdin.on("data", onData);
  });
}

async function keygen(id: string | undefined) {
  if (!id || /\s/.test(id)) fail("usage: soz-approve keygen ID   (an id without spaces, as the gateway's config names you)");
  const path = `${id}.soz-key`;
  if (existsSync(path)) fail(`${path} exists already; it is not overwritten`);
  const pass = await ask("Passphrase for the new key (at least 10 characters): ", true);
  if (pass.length < 10) fail("the passphrase is too short");
  if (await ask("The same passphrase again: ", true) !== pass) fail("the passphrases differ");
  const k = newKeyPair(pass);
  writeFileSync(path, canonicalJson({ soz_key: 1, id, private_key: k.privatePem }) + "\n", { flag: "wx", mode: 0o600 });
  out(`\nThe private key is in ${path}. Keep it to yourself; nobody else needs it, not even the gateway.\n`
    + `Give this line to whoever runs the gateway, for its "approvers" (they fill in your roles):\n\n`
    + `  ${canonicalJson({ id, roles: [], public_key: k.publicKey })}\n`);
}

async function approve(requestPath: string, args: string[]) {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const keyPath = flag("--key") ?? fail("which key? --key ID.soz-key");
  const hours = Number(flag("--hours") ?? "24");
  if (!(hours > 0 && hours <= 24 * 7)) fail("--hours is between 0 and 168");
  let r: ApprovalRequest;
  try { r = readRequest(readFileSync(requestPath, "utf8")); } catch (e) { return fail((e as Error).message); }
  const key = parseJson(readFileSync(keyPath, "utf8"));
  if (!isObject(key) || typeof key.id !== "string" || typeof key.private_key !== "string") fail(`${keyPath} is not a soz key`);
  const k = key as { id: string; private_key: string };
  out(requestText(r));
  if (r.actor && r.actor === k.id && r.requires.some(x => x.fourEyes))
    out(`\nNote: you asked for this yourself; four eyes means someone else approves it. The gateway will not count it.\n`);
  const yes = await ask(`\nApprove exactly these steps as ${k.id}? Type yes: `);
  if (yes.trim().toLowerCase() !== "yes") { out("Not approved.\n"); process.exit(1); }
  let pk;
  try { pk = openPrivateKey(k.private_key, await ask("Passphrase: ", true)); } catch { return fail("wrong passphrase"); }
  const expires = Math.floor(Date.now() / 1000 + hours * 3600);
  out(`\nYour approval (valid for ${hours} hours, only for these steps, for ${visible(r.actor || "this request")} at ${visible(r.gateway)}).`
    + ` Give it to the person who asked:\n\n  ${signApproval(r, k.id, expires, pk)}\n`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "keygen") await keygen(rest[0]);
else if (cmd === "show" && rest[0]) {
  try { out(requestText(readRequest(readFileSync(rest[0], "utf8")))); } catch (e) { fail((e as Error).message); }
}
else if (cmd && cmd !== "show") await approve(cmd, rest);
else fail("usage: soz-approve keygen ID | soz-approve show REQUEST | soz-approve REQUEST --key ID.soz-key [--hours 24]");
