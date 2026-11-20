// render.ts — A preview as a person approves it, for chat apps and approval screens: Markdown, Slack,
// Telegram (HTML) or plain text.
//
// Everything in a preview that the model or a tool wrote (the title, the message, argument values,
// the stop reason) is untrusted text on an approval screen. So it is passed through visible() (a
// newline in a value cannot pose as a new step, U+202E cannot turn an IBAN around), and the steps sit
// in a code block, where "*bold*" or "[click](https://...)" in a value is shown as written and never
// becomes formatting or a link.

import { visible } from "./exact.ts";
import { type Preview, valueText, requirementsText } from "./run.ts";

export type RenderFormat = "text" | "markdown" | "slack" | "telegram";

type Doc = {
  title: string; status: string; message: string | null; effects: string[];
  steps: string[]; notes: string[]; stop: string | null; problems: string[]; code: string | null;
};

const STATUS: Record<string, string> = {
  ready: "Ready to approve", stopped: "Stops partway; the steps before the stop can be approved",
  nothing: "Nothing to do", denied: "Not allowed by the policy", error: "Cannot run", invalid: "The plan has errors",
};

function doc(p: Preview): Doc {
  const steps: string[] = [], notes: string[] = [];
  for (const s of p.steps) {
    steps.push(`${s.index}. ${s.operation.name}${s.alreadyDone ? "   (already done; will not run again)" : ""}`);
    for (const [k, v] of s.args.fields) steps.push(`     ${k}: ${visible(valueText(v))}`);
    if (s.requires.length && !s.alreadyDone) notes.push(`Step ${s.index} needs ${requirementsText(s.requires, p.actor)}.`);
  }
  return {
    title: visible(p.check.title ?? "(no title)"), status: STATUS[p.status] ?? p.status,
    message: p.message === null ? null : visible(p.message),
    effects: [...new Set(p.steps.map(s => s.operation.effect))],
    steps, notes, stop: p.stopReason === null ? null : visible(p.stopReason),
    problems: p.status === "invalid"
      ? p.check.errors.map(e => `line ${e.line}, column ${e.column} [${e.code}]: ${visible(e.message)}`)
      : p.problems.map(x => visible(x.message)),
    code: p.hash ? p.hash.slice(0, 12) : null,
  };
}

// --- Escaping per format -------------------------------------------------------------------------------

/** CommonMark: a backslash before every punctuation character that could mean something. */
const md = (s: string) => s.replace(/[\\`*_{}\[\]()#+\-.!|<>~=]/g, c => "\\" + c);
/** Slack mrkdwn has no backslash escapes, so the characters that could format or link are entities. */
const slack = (s: string) => s.replace(/[&<>*_~`]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "*": "&#42;", "_": "&#95;", "~": "&#126;", "`": "&#96;" })[c]!);
/** Telegram parse_mode HTML: & < > only. */
const html = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
/** Inside a fenced block nothing is formatting, except a fence: a run of backticks is spaced out, visibly. */
const fenced = (s: string) => s.replace(/`{3,}/g, m => m.split("").join(" "));

export function renderPreview(p: Preview, format: RenderFormat = "markdown"): string {
  const d = doc(p);
  const lines: string[] = [];
  if (format === "text") {
    lines.push(`Plan: ${d.title}`, `Status: ${d.status}`);
    if (d.message !== null) lines.push(`Based on the message: ${d.message}`);
    if (d.effects.length) lines.push(`Effects: ${d.effects.join(", ")}`);
    if (d.steps.length) lines.push("", ...d.steps, "");
    lines.push(...d.notes);
    if (d.stop) lines.push(`The plan stops: ${d.stop}`);
    lines.push(...d.problems.map(x => `Cannot run: ${x}`));
    if (d.code) lines.push(`Preview ${d.code}`);
    return lines.join("\n") + "\n";
  }
  if (format === "telegram") {
    lines.push(`<b>Plan:</b> ${html(d.title)}`, `<i>${html(d.status)}</i>`);
    if (d.message !== null) lines.push(`<blockquote>${html(d.message)}</blockquote>`);
    if (d.effects.length) lines.push(`<b>Effects:</b> ${html(d.effects.join(", "))}`);
    if (d.steps.length) lines.push(`<pre>${html(d.steps.join("\n"))}</pre>`);
    lines.push(...d.notes.map(n => `⚠️ ${html(n)}`));
    if (d.stop) lines.push(`<b>The plan stops:</b> ${html(d.stop)}`);
    lines.push(...d.problems.map(x => `❌ ${html(x)}`));
    if (d.code) lines.push(`Preview <code>${d.code}</code>`);
    return lines.join("\n");
  }
  const esc = format === "slack" ? slack : md;
  const bold = (s: string) => format === "slack" ? `*${s}*` : `**${s}**`;
  const italic = (s: string) => format === "slack" ? `_${s}_` : `*${s}*`;
  lines.push(`${bold("Plan:")} ${esc(d.title)}`, italic(esc(d.status)));
  if (d.message !== null) lines.push(`> ${esc(d.message)}`);
  if (d.effects.length) lines.push(`${bold("Effects:")} ${esc(d.effects.join(", "))}`);
  if (d.steps.length) lines.push("```", fenced(format === "slack" ? html(d.steps.join("\n")) : d.steps.join("\n")), "```");
  lines.push(...d.notes.map(n => `${format === "slack" ? ":warning:" : "⚠️"} ${esc(n)}`));
  if (d.stop) lines.push(`${bold("The plan stops:")} ${esc(d.stop)}`);
  lines.push(...d.problems.map(x => `❌ ${esc(x)}`));
  if (d.code) lines.push(`Preview \`${d.code}\``);
  return lines.join("\n") + "\n";
}
