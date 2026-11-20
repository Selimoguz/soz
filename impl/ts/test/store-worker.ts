// store-worker.ts — One process of the store test: claims a key, or appends to an audit record.
//   claim  JOURNAL KEY START_MS        prints "won" or "lost"
//   crash  JOURNAL KEY                 claims, then exits without completing (as a host that died)
//   append AUDIT COUNT START_MS        appends COUNT records

import { Journal, Audit } from "../src/run.ts";

const [mode, path, arg, start] = process.argv.slice(2);
const until = (t: number) => { while (Date.now() < t) { /* wait for the others, to collide */ } };

if (mode === "claim") {
  until(Number(start));
  process.stdout.write((await Journal.open(path).claim(arg)) === null ? "won" : "lost");
} else if (mode === "crash") {
  await Journal.open(path).claim(arg);
  process.exit(3);
} else if (mode === "append") {
  until(Number(start));
  const a = Audit.open(path);
  for (let i = 0; i < Number(arg); i++) await a.append("call", { worker: process.argv[5] ?? "", i });
}
