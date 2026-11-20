// approvals.ts — Another person's approval, collected by the gateway (SPEC 11.6).
//
// When a policy needs someone besides the user (approval by finance, four eyes), the gateway writes an
// approval request: the plan, the message, the steps and the preview hash. A person with that role
// opens it with soz-approve on their own machine; the tool computes the hash again from what it shows,
// so an edited request cannot be passed off, and signs (Ed25519) a short token:
//
//   soz1.<approver id>.<expires, Unix seconds>.<signature, base64url>
//
// over "soz approval 1\n<hash>\n<id>\n<expires>". The gateway knows only public keys, and the roles come
// from its configuration, not from the token. So a token may travel through any channel, the chat
// included: the model can carry it but cannot make one, and cannot change what it approves.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { Rational, canonicalJson, isObject, parseJson, sha256Hex, type Json } from "./exact.ts";
import { type Preview, type Requirement } from "./run.ts";
import { type Actor } from "./checker.ts";

export type Approver = Actor & { publicKey: string };
export type ApprovalRequest = {
  hash: string; plan: string; message: string | null; steps: Json[]; actor: Actor | null; requires: Requirement[]; created: string;
};

const TOKEN = /^soz1\.(\S+)\.(\d{1,12})\.([A-Za-z0-9_-]{86})$/;

const signedText = (hash: string, id: string, expires: number) => new TextEncoder().encode(`soz approval 1\n${hash}\n${id}\n${expires}`);

/** What the preview hash is computed from (SPEC 10.3), as JSON. */
export function hashedSteps(p: Preview): Json[] {
  return parseJson(canonicalJson(p.steps.map(s => ({ operation: s.operation.name, args: s.args, key: s.key })))) as Json[];
}

export function requestFor(p: Preview, requires: Requirement[], now = new Date()): ApprovalRequest {
  return { hash: p.hash!, plan: p.text, message: p.message, steps: hashedSteps(p), actor: p.actor, requires, created: now.toISOString() };
}

export function requestJson(r: ApprovalRequest): string {
  return canonicalJson({
    soz_approval_request: 1, hash: r.hash, plan: r.plan, message: r.message, steps: r.steps, created: r.created,
    actor: r.actor, requires: r.requires.map(x => ({ role: x.role, four_eyes: x.fourEyes, rule: x.rule })),
  }) + "\n";
}

/** Reads a request and checks that its hash is the hash of what it shows. */
export function readRequest(text: string): ApprovalRequest {
  const j = parseJson(text);
  if (!isObject(j) || !(j.soz_approval_request instanceof Rational && j.soz_approval_request.eq(Rational.of(1)))) throw new Error("this is not a soz approval request");
  const { hash, plan, message, steps, created } = j;
  if (typeof hash !== "string" || typeof plan !== "string" || !(message === null || typeof message === "string")
      || !Array.isArray(steps) || typeof created !== "string")
    throw new Error("the approval request is incomplete");
  if (sha256Hex(canonicalJson({ plan, message, steps })) !== hash)
    throw new Error("the approval request was changed: its steps do not match its hash. Do not approve it.");
  const actor = isObject(j.actor) && typeof j.actor.id === "string"
    ? { id: j.actor.id, roles: Array.isArray(j.actor.roles) ? j.actor.roles.filter((x): x is string => typeof x === "string") : [] } : null;
  const requires = (Array.isArray(j.requires) ? j.requires : []).filter(isObject)
    .map(x => ({ role: String(x.role), fourEyes: x.four_eyes === true, rule: String(x.rule) }));
  return { hash, plan, message, steps: steps as Json[], actor, requires, created };
}

// --- Keys and tokens ----------------------------------------------------------------------------------

/** A new key pair: the private key as PKCS#8 PEM encrypted with the passphrase, the public key as base64url. */
export function newKeyPair(passphrase: string): { privatePem: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase }),
    publicKey: publicKey.export({ format: "jwk" }).x!,
  };
}

export function openPrivateKey(pem: string, passphrase: string): KeyObject {
  return createPrivateKey({ key: pem, passphrase });
}

export function signApproval(hash: string, id: string, expires: number, key: KeyObject): string {
  if (/\s/.test(id) || !id) throw new Error("an approver id has no spaces");
  return `soz1.${id}.${expires}.${Buffer.from(sign(null, signedText(hash, id, expires), key)).toString("base64url")}`;
}

/** The approver a token proves for this hash, or why it does not. */
export function verifyApproval(token: string, hash: string, approvers: Approver[], nowSeconds = Math.floor(Date.now() / 1000)):
    { ok: true; approver: Approver } | { ok: false; why: string } {
  const m = TOKEN.exec(token.trim());
  if (!m) return { ok: false, why: "this is not a soz approval token" };
  const [, id, exp, sig] = m;
  const approver = approvers.find(a => a.id === id);
  if (!approver) return { ok: false, why: `${id} is not an approver of this gateway` };
  let good = false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: approver.publicKey }, format: "jwk" });
    good = verify(null, signedText(hash, id, Number(exp)), key, Buffer.from(sig, "base64url"));
  } catch { good = false; }
  if (!good) return { ok: false, why: `the token is not ${id}'s approval of this preview` };
  if (Number(exp) < nowSeconds) return { ok: false, why: `${id}'s approval has expired` };
  return { ok: true, approver };
}

export function approversFromJson(j: Json | undefined): Approver[] {
  if (j === undefined || j === null) return [];
  if (!Array.isArray(j)) throw new Error("approvers must be a list");
  return j.map(a => {
    if (!isObject(a) || typeof a.id !== "string" || !a.id || /\s/.test(a.id) || typeof a.public_key !== "string" || !Array.isArray(a.roles))
      throw new Error(`an approver needs an id without spaces, roles and a public_key: ${canonicalJson(a)}`);
    try { createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: a.public_key }, format: "jwk" }); }
    catch { throw new Error(`the public_key of ${a.id} is not an Ed25519 key`); }
    return { id: a.id, roles: a.roles.map(String), publicKey: a.public_key };
  });
}
