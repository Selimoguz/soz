// approval-helper.ts — For the Lisp gateway's test: keys and signed tokens made by the TypeScript side,
// so that the Lisp verifier is tested against Node's Ed25519.
//
//   approval-helper.ts keys DIR ID...                 writes DIR/ID.pem, prints {"ID": public key, ...}
//   approval-helper.ts sign DIR ID HASH [EXPIRES] [KEY-ID]   prints ID's token for HASH (signed with KEY-ID's key)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newKeyPair, openPrivateKey, signApproval } from "../src/approvals.ts";

const [cmd, dir, ...rest] = process.argv.slice(2);
if (cmd === "keys") {
  const out: Record<string, string> = {};
  for (const id of rest) { const k = newKeyPair("test passphrase"); writeFileSync(join(dir, `${id}.pem`), k.privatePem); out[id] = k.publicKey; }
  process.stdout.write(JSON.stringify(out) + "\n");
} else if (cmd === "sign") {
  const [id, hash, expires, keyId] = rest;
  const key = openPrivateKey(readFileSync(join(dir, `${keyId ?? id}.pem`), "utf8"), "test passphrase");
  process.stdout.write(signApproval(hash, id, expires ? Number(expires) : Math.floor(Date.now() / 1000) + 3600, key) + "\n");
} else {
  process.stderr.write("usage: approval-helper.ts keys DIR ID... | sign DIR ID HASH [EXPIRES] [KEY-ID]\n");
  process.exit(2);
}
