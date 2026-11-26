#!/usr/bin/env node
// journal-cli.ts — For a person to see and resolve steps the journal holds as pending or unknown
// (SPEC 10.8). Deliberately not a tool the model gets: deciding whether something happened is the
// person's, after checking the system the operation acts on.
//
//   soz-journal JOURNAL                     lists unresolved steps
//   soz-journal JOURNAL done KEY-PREFIX     it did happen: never run it again
//   soz-journal JOURNAL release KEY-PREFIX  it did not happen: it may run again

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { Journal, type JournalEntry } from "./run.ts";
import { parseJson } from "./exact.ts";

const [path, action, prefix] = process.argv.slice(2);
if (!path) {
  process.stderr.write("usage: soz-journal JOURNAL [done|release KEY-PREFIX]\n");
  process.exit(2);
}
const journal = Journal.open(path);

function unresolved(): JournalEntry[] {
  const keys = new Set<string>();
  if (existsSync(path))
    for (const line of readFileSync(path, "utf8").split("\n")) if (line.trim()) keys.add((parseJson(line) as { key: string }).key);
  if (existsSync(path + ".d"))
    for (const f of readdirSync(path + ".d")) keys.add((parseJson(readFileSync(`${path}.d/${f}`, "utf8")) as JournalEntry).key);
  return [...keys].map(k => journal.get(k)).filter((e): e is JournalEntry => !!e && e.status !== "done");
}

const open = unresolved();
if (!action) {
  if (!open.length) process.stdout.write("No unresolved steps.\n");
  for (const e of open) process.stdout.write(`${e.status.padEnd(8)} ${e.key}\n`);
  process.exit(0);
}
if (action !== "done" && action !== "release") {
  process.stderr.write(`unknown action ${action}: use done or release\n`);
  process.exit(2);
}
const hits = open.filter(e => prefix && e.key.startsWith(prefix));
if (hits.length !== 1) {
  process.stderr.write(hits.length ? `${hits.length} unresolved steps start with that; give more of the key\n` : "No unresolved step starts with that.\n");
  process.exit(1);
}
if (action === "done") journal.put(hits[0].key, "done", null);
else journal.release(hits[0].key);
process.stdout.write(`${action === "done" ? "Marked done (it will not run again)" : "Released (it may run again)"}: ${hits[0].key}\n`);
