// criteria.ts — Did the change move the goalposts? The files that define what "finished" means (tests,
// CI, soz-guard's own config) belong to the repository's owner. An agent may add to them: a new test,
// a new assertion. It may not quietly weaken them to get its work accepted: delete a test file, remove
// more assertions than it adds, or change the config that decides what counts as finished. Such a
// change is not wrong in itself (a test can be obsolete), but it is a person's decision, not the agent's.

import { createHash } from "node:crypto";
import { type Diff, type Config, CONFIG_FILE } from "./scan.ts";
import { matchesAny } from "./rules.ts";

/** EVIDENCE is the SHA-256 of exactly what changed in the file (its removed and added lines): a person's
 * acceptance is bound to it, so a further change, even of the same kind, needs accepting again. */
export type CriteriaChange = { file: string; kind: "config" | "deleted" | "assertions-removed"; detail: string; evidence: string };

const evidenceOf = (diff: Diff, file: string) =>
  createHash("sha256").update(JSON.stringify([diff.removed.get(file) ?? [], diff.added.get(file) ?? []]), "utf8").digest("hex");

/** A line that asserts something, in most test frameworks. */
const ASSERTION = /\b(expect|assert\w*|check|verify|should)\s*[.(]|\.(to|not\.to)(Be|Equal|StrictEqual|Have|Throw|Match|Contain)\w*\s*\(|\bassert\b|\bt\.(is|true|false|deepEqual|equal|throws)\s*\(/;

export function criteriaChanges(diff: Diff, config: Config): CriteriaChange[] {
  const out: CriteriaChange[] = [];
  for (const [file, status] of [...diff.status].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const evidence = evidenceOf(diff, file);
    if (file === CONFIG_FILE) {
      out.push({ file, kind: "config", evidence,
                 detail: `the rules that decide what counts as finished (${CONFIG_FILE}) were ${status === "D" ? "deleted" : status === "A" ? "added" : "changed"}` });
      continue;
    }
    if (!matchesAny(file, config.criteria)) continue;
    if (status === "D") { out.push({ file, kind: "deleted", evidence, detail: "a test or CI file was deleted" }); continue; }
    const removed = (diff.removed.get(file) ?? []).filter(([, t]) => ASSERTION.test(t));
    const added = (diff.added.get(file) ?? []).filter(([, t]) => ASSERTION.test(t));
    if (removed.length > added.length)
      out.push({ file, kind: "assertions-removed", evidence,
                 detail: `${removed.length - added.length} assertion(s) fewer: ${removed.slice(0, 3).map(([n, t]) => `line ${n} "${t.trim().slice(0, 80)}"`).join(", ")}` });
  }
  return out;
}

export function criteriaReport(changes: CriteriaChange[]): string {
  return changes.map(c => `  ${c.file}  [${c.kind}] ${c.detail}`).join("\n");
}
