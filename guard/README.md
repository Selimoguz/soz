# soz-guard

**Unfinished work, said out loud.**

A coding agent that writes a lot of code, in many tabs at once, tends to leave things unfinished
without saying so: a `TODO` here, a button whose handler is empty there, an error caught and
dropped, a `// ... rest of the screen`, an `example.com` where real data should be. Then it says
"done". soz-guard is a Claude Code hook that does not let it say "done" while its changes still
contain such gaps: it shows the agent what is open, line by line, and asks it to finish or to
**declare** what has to stay.

It is a sibling of [soz](../README.md) with the same idea, no silent errors, applied to code an
agent writes rather than to actions an agent takes. It does not depend on soz.

## Set up (Claude Code, also in VS Code)

Requires Node 22.6 or newer and git.

```sh
node --experimental-strip-types path/to/soz/guard/src/cli.ts init
```

in your project adds, without touching what is already there:

- a `Stop` hook in `.claude/settings.json`;
- a `.soz-guard.json` for your own settings;
- a short "Finished means finished" section in `CLAUDE.md`.

Every Claude Code session in that project, in every tab, then runs it when the agent tries to stop.

## What it looks at

Only what changed: the lines your working tree adds against `HEAD`, and new files whole. Old TODOs
already committed are not its business.

| Rule | Catches | Does not catch |
|---|---|---|
| `todo` | `// TODO`, `# FIXME`, `@todo` in comments | "TODO" in a string or a test name |
| `not-implemented` | `throw new Error("not implemented")`, `NotImplementedException`, `todo!()` | |
| `swallowed-error` | `catch (e) {}`, `.catch(() => {})`, `except: pass` | a catch block that does something |
| `skipped-test` | `test.skip(`, `it.todo(`, `xit(`, `@Disabled`, `pytest.mark.skip` | |
| `deferred` | comments that put work off: "for now", "hard-coded", "wire this up later", "şimdilik", "yapılacak", "bağlanacak" | "retried later", "a temporary folder" |
| `elided` | `// ...` and `// ... rest of the code` | spread syntax `...rest` |
| `fake-data` | lorem ipsum, example.com, test@test, John Doe, 123456789 (outside tests) | the same in tests and fixtures |
| `empty-function` | `function f() {}`, `save() {}`, `onClick={() => {}}`, `handleSave = () => {}` | `useEffect(() => {}, [])`, `if (x) {}`, `constructor() {}` |

Markdown, lock files, `node_modules`, `dist` and `build` are skipped.

## Unfinished is allowed; unsaid is not

Sometimes something cannot be finished now: the API it needs does not exist yet, or only the user
can decide. Then the line stays, marked:

```ts
return 0; // soz-guard: ignore the stock service has no release call yet
```

and the agent says so in its final message. The marker is the point: the gap is now visible in
the code, in the diff and in review.

## The hook

When the agent tries to stop and its changes contain unfinished work, the hook exits with code 2
and tells the agent what is open, so it continues instead of stopping. To never trap an agent in a
loop, it does this at most `maxBlocks` times (3); after that it lets the agent stop and shows the
person what is still open. Outside a git repository it does nothing. If it fails itself, it says
so and does not block.

## Settings

`.soz-guard.json`:

```json
{
  "disable": ["empty-function"],
  "exclude": ["legacy/**"],
  "maxBlocks": 3,
  "rules": [
    {"id": "debug-log", "pattern": "console\\.log\\(", "message": "a debug log left in", "extensions": [".ts", ".tsx"]}
  ]
}
```

A rule with the id of a built-in rule replaces it.

## Also by hand

```sh
node --experimental-strip-types path/to/soz/guard/src/cli.ts scan           # exit 1 if anything is open
node --experimental-strip-types path/to/soz/guard/src/cli.ts scan --json
node --experimental-strip-types path/to/soz/guard/src/cli.ts scan --base main   # everything since main, e.g. in CI
```

## What it is not

It finds work left unfinished without saying so. It does not find wrong logic, a wrong business
rule or a screen that does the wrong thing; tests do that. It reads lines, not programs, so a
determined way of hiding a gap will pass. It makes the common, unintended gaps visible, which in
practice are most of them.
