// approval-helper.ts — For the Lisp gateway's test: keys and signed tokens made by the TypeScript side,
// so that the Lisp verifier is tested against Node's Ed25519.
//
//   approval-helper.ts keys DIR ID...                  writes DIR/ID.pem, prints {"ID": public key, ...}
//   approval-helper.ts sign DIR ID REQUEST [EXPIRES] [KEY-ID] [FIELD=VALUE ...]
//       prints ID's token for the approval request REQUEST, signed with KEY-ID's key (default: ID's);
//       FIELD=VALUE changes the context signed (hash, nonce, gateway, actor, policy), for tests that
//       try an approval of something else

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newKeyPair, openPrivateKey, readRequest, signApproval, type ApprovalContext } from "../src/approvals.ts";

const [cmd, dir, ...rest] = process.argv.slice(2);
if (cmd === "keys") {
  const out: Record<string, string> = {};
  for (const id of rest) { const k = newKeyPair("test passphrase"); writeFileSync(join(dir, `${id}.pem`), k.privatePem); out[id] = k.publicKey; }
  process.stdout.write(JSON.stringify(out) + "\n");
} else if (cmd === "sign") {
  const [id, request, expires, keyId, ...changes] = rest;
  const r = readRequest(readFileSync(request, "utf8"));
  const context: ApprovalContext = { hash: r.hash, nonce: r.nonce, gateway: r.gateway, actor: r.actor, policy: r.policy };
  for (const c of changes) { const i = c.indexOf("="); (context as Record<string, string>)[c.slice(0, i)] = c.slice(i + 1); }
  const key = openPrivateKey(readFileSync(join(dir, `${keyId || id}.pem`), "utf8"), "test passphrase");
  process.stdout.write(signApproval(context, id, expires ? Number(expires) : Math.floor(Date.now() / 1000) + 3600, key) + "\n");
} else {
  process.stderr.write("usage: approval-helper.ts keys DIR ID... | sign DIR ID REQUEST [EXPIRES] [KEY-ID] [FIELD=VALUE ...]\n");
  process.exit(2);
}
