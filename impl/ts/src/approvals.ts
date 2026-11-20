// approvals.ts — Another person's approval, collected by the gateway (SPEC 11.5).
//
// When a policy needs someone besides the user (approval by finance, four eyes), the gateway writes an
// approval request: the plan, the message, the steps, the preview hash, and the context the approval is
// for. A person with that role opens it with soz-approve on their own machine; the tool computes the hash
// again from what it shows, so an edited request cannot be passed off, and signs (Ed25519) a short token:
//
//   soz2.<approver id>.<expires, Unix seconds>.<signature, base64url>
//
// over "soz approval 2", the preview hash, the preview's nonce, the gateway's id, the user who asked, the
// policy's digest, the approver's id and the expiry, one per line. So an approval is for this preview of
// this plan, at this gateway, for this user, under this policy, and for nothing else: not for the same
// plan previewed again, by someone else, at another gateway or tenant, or after the policy changed.
// The gateway knows only public keys, and the roles come from its configuration, not from the token. A
// token may travel through any channel, the chat included: the model can carry it but cannot make one.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { Rational, canonicalJson, isObject, parseJson, sha256Hex, type Json } from "./exact.ts";
import { type Preview, type Requirement } from "./run.ts";
import { type Actor } from "./checker.ts";

export type Approver = Actor & { publicKey: string };

/** What an approval is bound to, besides the steps. */
export type ApprovalContext = {
  hash: string;     // the preview hash (SPEC 10.3): the plan, the message, the steps
  nonce: string;    // this preview's own random id: the same plan previewed again is another preview
  gateway: string;  // the gateway's id (gateway_id): another gateway or tenant is another context
  actor: string;    // the id of the user who asked ("" without one)
  policy: string;   // SHA-256 of the policy's canonical JSON
};

export type ApprovalRequest = ApprovalContext & {
  plan: string; message: string | null; steps: Json[]; actorRoles: string[]; requires: Requirement[]; created: string;
};

const TOKEN = /^soz2\.(\S+)\.(\d{1,12})\.([A-Za-z0-9_-]{86})$/;
const OLD_TOKEN = /^soz1\./;

function signedText(c: ApprovalContext, id: string, expires: number): Uint8Array {
  return new TextEncoder().encode(["soz approval 2", c.hash, c.nonce, c.gateway, c.actor, c.policy, id, String(expires)].join("\n"));
}

/** The policy's digest, as both implementations compute it: SHA-256 of its canonical JSON. */
export function policyDigest(policyJson: Json | undefined): string {
  return sha256Hex(canonicalJson(policyJson ?? []));
}

export function checkContext(c: ApprovalContext): ApprovalContext {
  const context = { hash: c.hash, nonce: c.nonce, gateway: c.gateway, actor: c.actor, policy: c.policy };
  for (const [k, v] of Object.entries(context))
    if (typeof v !== "string" || /[\r\n]/.test(v)) throw new Error(`approval context: ${k} must be text on one line`);
  if (!context.gateway) throw new Error("approval context: the gateway needs an id (gateway_id)");
  return context;
}

/** What the preview hash is computed from (SPEC 10.3), as JSON. */
export function hashedSteps(p: Preview): Json[] {
  return parseJson(canonicalJson(p.steps.map(s => ({ operation: s.operation.name, args: s.args, key: s.key })))) as Json[];
}

export function requestFor(p: Preview, context: ApprovalContext, requires: Requirement[], now = new Date()): ApprovalRequest {
  return { ...checkContext(context), plan: p.text, message: p.message, steps: hashedSteps(p),
           actorRoles: p.actor?.roles ?? [], requires, created: now.toISOString() };
}

export function requestJson(r: ApprovalRequest): string {
  return canonicalJson({
    soz_approval_request: 2, hash: r.hash, nonce: r.nonce, gateway: r.gateway, policy: r.policy,
    actor: r.actor ? { id: r.actor, roles: r.actorRoles } : null,
    plan: r.plan, message: r.message, steps: r.steps, created: r.created,
    requires: r.requires.map(x => ({ role: x.role, four_eyes: x.fourEyes, rule: x.rule })),
  }) + "\n";
}

/** Reads a request and checks that its hash is the hash of what it shows. */
export function readRequest(text: string): ApprovalRequest {
  const j = parseJson(text);
  const version = isObject(j) && j.soz_approval_request instanceof Rational ? Number(j.soz_approval_request.decimal()) : null;
  if (!isObject(j) || version === null) throw new Error("this is not a soz approval request");
  if (version !== 2) throw new Error(`this approval request is of version ${version}; ask for a new one`);
  const { hash, nonce, gateway, policy, plan, message, steps, created } = j;
  if (typeof hash !== "string" || typeof nonce !== "string" || typeof gateway !== "string" || typeof policy !== "string"
      || typeof plan !== "string" || !(message === null || typeof message === "string") || !Array.isArray(steps) || typeof created !== "string")
    throw new Error("the approval request is incomplete");
  if (sha256Hex(canonicalJson({ plan, message, steps })) !== hash)
    throw new Error("the approval request was changed: its steps do not match its hash. Do not approve it.");
  const actor = isObject(j.actor) && typeof j.actor.id === "string" ? j.actor.id : "";
  const actorRoles = isObject(j.actor) && Array.isArray(j.actor.roles) ? j.actor.roles.filter((x): x is string => typeof x === "string") : [];
  const requires = (Array.isArray(j.requires) ? j.requires : []).filter(isObject)
    .map(x => ({ role: String(x.role), fourEyes: x.four_eyes === true, rule: String(x.rule) }));
  return { ...checkContext({ hash, nonce, gateway, actor, policy }), plan, message, steps: steps as Json[], actorRoles, requires, created };
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

export function signApproval(context: ApprovalContext, id: string, expires: number, key: KeyObject): string {
  if (/\s/.test(id) || !id) throw new Error("an approver id has no spaces");
  return `soz2.${id}.${expires}.${Buffer.from(sign(null, signedText(checkContext(context), id, expires), key)).toString("base64url")}`;
}

/** The approver a token proves for this context, or why it does not. */
export function verifyApproval(token: string, context: ApprovalContext, approvers: Approver[], nowSeconds = Math.floor(Date.now() / 1000)):
    { ok: true; approver: Approver } | { ok: false; why: string } {
  const t = token.trim();
  if (OLD_TOKEN.test(t)) return { ok: false, why: "this token is of an older version, which did not bind the approval to its context; ask for a new one" };
  const m = TOKEN.exec(t);
  if (!m) return { ok: false, why: "this is not a soz approval token" };
  const [, id, exp, sig] = m;
  const approver = approvers.find(a => a.id === id);
  if (!approver) return { ok: false, why: `${id} is not an approver of this gateway` };
  let good = false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: approver.publicKey }, format: "jwk" });
    good = verify(null, signedText(context, id, Number(exp)), key, Buffer.from(sig, "base64url"));
  } catch { good = false; }
  if (!good) return { ok: false, why: `the token is not ${id}'s approval of this preview (for this gateway, user and policy)` };
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
