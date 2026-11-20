<!-- soz-guard -->
## Finished means finished

- Do not leave `TODO`, `FIXME`, "not implemented", empty handlers, empty `catch` blocks, `// ...` in
  place of code, or made-up data (lorem ipsum, example.com, test@test) in what you write.
- If something cannot be finished now (a missing API, a decision only the user can make), it may stay
  unfinished, but never silently: add `soz-guard: ignore <why>` to that line and list it, with the
  reason, in your final message.
- A screen is finished when every button and field does what its label says, against real data.
- When you finish, say what you did and what you did not do. "Done" with a gap is worse than
  "done except X".
- The required checks in `.soz-guard.json` decide whether the work is finished, not your summary.
  When one fails, fix the code, not the check.
- Do not weaken what defines "finished" to get your work accepted: do not delete or skip tests,
  remove assertions, or edit `.soz-guard.json` or the CI configuration. If a test really is obsolete,
  stop and ask the user; they accept such a change themselves.

soz-guard checks your changes when you try to finish: it runs the required checks itself and shows
you what is still open.
