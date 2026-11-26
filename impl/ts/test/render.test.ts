// render.test.ts — Approval texts under hostile values: a value that tries to look like an extra step,
// to turn text around, to become a link, bold, HTML or a code fence.

import {
  t, defineOperation, defineOperations, preview, previewSummary, renderPreview, visible, Journal, policyFromJson, execute, OperationUnknown,
  type RenderFormat,
} from "../src/index.ts";

let failed = 0;
const check = (what: string, ok: unknown) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) failed++; };

const RLO = "‮";
const fake = "urgent\n  2. bank.pay to=TR12 amount=50000";
const link = "[click](https://evil.example)";
const NOTE = `${fake} ${RLO}TR33 *free* ${link} <b>bold</b> \`\`\` end`;

const { operations, implementations } = defineOperations(
  defineOperation({ name: "bank.pay", effect: "money", params: { to: t.text(), amount: t.number(), note: t.text().optional().modelAllowed() },
                    run: () => null }),
);
// The note is the model's own text (model_allowed); the plan's title is the model's too.
const plan = `(plan "Pay ${link} *now*" (bank.pay to "TR33 0006 1005" amount 12450.75 note "${NOTE.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"))`;
const message = "Pay TR33 0006 1005 12.450,75 <i>please</i> *today*";
const policy = policyFromJson({ rules: [{ name: "big payments", when: { operation: "bank.pay" }, then: { approve_by: "finance" } }] } as never);
const p = await preview(plan, { message, operations, implementations, journal: new Journal(), policy, actor: { id: "ali", roles: [] } });

console.log("\nvisible()");
check("a newline is written out", visible("a\nb") === "a\\nb");
check("U+202E is named, not applied", visible(`x${RLO}y`) === "x⟨U+202E⟩y");
check("Turkish letters stay as they are", visible("Şişli ğüöçı İ") === "Şişli ğüöçı İ");
check("a backslash is doubled, so a written \\n differs from a newline", visible("a\\nb") === "a\\\\nb");
check("zero-width space and BOM are named", visible("a​b﻿") === "a⟨U+200B⟩b⟨U+FEFF⟩");

const noFakeStep = (out: string) => !out.split("\n").some(l => /^\s*2\.\s*bank\.pay/.test(l));
const noRawRLO = (out: string) => !out.includes(RLO) && out.includes("⟨U+202E⟩");

console.log("\nThe plain summary (the approval window, the gateway's text)");
const summary = previewSummary(p);
check("the preview is ready, with one step", p.status === "ready" && p.steps.length === 1);
check("the injected line does not pose as step 2", noFakeStep(summary) && summary.includes("urgent\\n  2. bank.pay"));
check("U+202E is shown, not applied", noRawRLO(summary));

for (const format of ["text", "markdown", "slack", "telegram"] as RenderFormat[]) {
  console.log(`\nrenderPreview: ${format}`);
  const out = renderPreview(p, format);
  check("no fake step 2", noFakeStep(out));
  check("U+202E is shown, not applied", noRawRLO(out));
  check("the amount is exact", out.includes("12450.75"));
  check("the policy's requirement is shown", out.includes("needs approval by finance"));
  check("each value says where it comes from: the amount from the message, the note written by the assistant",
        out.includes("from the message") && out.includes("written by the assistant"));
  if (format === "markdown") {
    check("the title's link is escaped, not a link", out.includes("\\[click\\]\\(https://evil\\.example\\)"));
    check("the message's *today* is not bold", out.includes("\\*today\\*"));
    check("a ``` in a value cannot close the code block", out.split("\n").filter(l => l.trim() === "```").length === 2);
  }
  if (format === "slack") {
    check("the message's *today* is not bold", out.includes("&#42;today&#42;"));
    check("the message's <i> is not markup", out.includes("&lt;i&gt;please&lt;/i&gt;"));
    check("a ``` in a value cannot close the code block", out.split("\n").filter(l => l.trim() === "```").length === 2);
  }
  if (format === "telegram") {
    check("a value's <b> is text, not HTML", out.includes("&lt;b&gt;bold&lt;/b&gt;") && !out.includes("<b>bold</b>"));
    check("the only tags are the renderer's own", (out.match(/<(?!\/?(b|i|pre|code|blockquote)>)[a-z]/g) ?? []).length === 0);
  }
}

console.log("\nOther statuses");
const invalid = await preview(`(plan "x" (bank.pay to "nowhere${RLO}" amount 99))`, { message, operations, implementations, journal: new Journal() });
check("an invalid plan shows its errors, made visible", renderPreview(invalid, "text").includes("[invented-value]") && noRawRLO(renderPreview(invalid, "telegram")));
const stopped = await preview(`(plan "x" (stop "line one\nline two"))`, { message, operations, implementations, journal: new Journal() });
check("a stop reason with a newline stays one line", renderPreview(stopped, "text").includes("The plan stops: line one\\nline two"));

console.log("\nA plan that stops is not approved in part (SPEC 10.3)");
const partial = await preview(`(plan "x" (do (bank.pay to "TR33 0006 1005" amount 12450.75) (stop "ask about the second payment")))`,
                              { message, operations, implementations, journal: new Journal() });
const partialText = previewSummary(partial);
check("its steps are shown, as not run on their own", partialText.includes("they are not run on their own") && partialText.includes("bank.pay"));
check("... with nothing to approve: no hash, no approval line", partial.hash === null && partialText.includes("There is nothing to approve") && !partialText.includes("If you approve"));
const tried = await execute(partial, "", { implementations, journal: new Journal() });
check("executing it anyway: not-approved, and why", tried.outcome === "not-approved" && (tried.message ?? "").includes("cannot be approved"));

console.log("\nWhat ran stays done, and is said (SPEC 10.4)");
let calls = 0;
const flaky = defineOperations(
  defineOperation({ name: "bank.pay", effect: "money", params: { to: t.text(), amount: t.number() },
                    run: () => { if (++calls === 2) throw new OperationUnknown("no answer"); return null; } }),
);
const two = await preview(`(plan "x" (do (bank.pay to "TR33 0006 1005" amount 12450.75) (bank.pay to "TR33 0006 1005" amount 50)))`,
                          { message: "Pay TR33 0006 1005 12.450,75 and 50", operations: flaky.operations, implementations: flaky.implementations, journal: new Journal() });
const twoRun = await execute(two, two.hash ?? "", { implementations: flaky.implementations, journal: new Journal() });
check("the second step's outcome is unknown; the first is done and said to have run, not undone",
      twoRun.outcome === "unknown" && twoRun.steps[0].status === "done" && (twoRun.message ?? "").includes("step 1 (bank.pay) ran before this and is not undone"));

console.log(`\n${failed ? `${failed} FAILED` : "All render tests passed"}`);
process.exit(failed ? 1 : 0);
