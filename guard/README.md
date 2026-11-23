# soz-guard

**Work is finished when the checks say so, not when the agent does.**

A coding agent writes a lot of code, in many tabs at once, and then says "done". Often it is not:
a `TODO` here, a button whose handler is empty there, an error caught and dropped, an `example.com`
where real data should be; or the tests were never run; or the test that failed was quietly
deleted. soz-guard is a deterministic wrapper around the agent's "done":

1. **Unfinished work, said out loud.** It reads what the agent changed and finds the gaps people
   find in review: TODOs, empty handlers, swallowed errors, `// ...` in place of code, made-up data.
2. **Evidence, not claims.** The repository's owner names the checks that must pass (`npm test`, a
   linter, a build). soz-guard runs them itself, on exactly this change. The agent's "tests pass" is
   not evidence; a check soz-guard ran is.
3. **The goalposts stay where the owner put them.** An agent may add tests. It may not delete a test,
   remove more assertions than it adds, or change soz-guard's own rules to get its work accepted:
   that needs a person.

The verdict is one of four, and only the first two count as finished:

| Verdict | Means |
|---|---|
| `verified` | nothing open, and every check that applies ran on exactly this change and passed |
| `unchecked` | nothing open, and no check applies (none configured, or none for what changed) |
| `unverified` | a check could not give an answer: it timed out or could not start |
| `open` | unfinished work, a failed check, or the criteria changed without a person's acceptance |

The same change, the same rules and the same check results always give the same verdict. Each one
is written to `.soz-guard/last.json` with what it rests on: a fingerprint of the change, of the
rules, and every check's command, exit code and last lines of output.

soz-guard works in two places: as a **Claude Code hook** while the agent works, and as a **CI
check** on the pull request, where the same decision is enforced. It is a sibling of
[soz](../README.md), which checks an agent's actions before they run; soz-guard checks its work
before it counts as done. It does not depend on soz.

## Set up (Claude Code, also in VS Code)

Requires Node 18 or newer and git. soz-guard is not on npm yet; it comes as one file built from this
folder, with no dependencies:

```sh
npm pack                                   # here, in guard/: makes soz-guard-0.2.0.tgz
```

and on the machine that will use it, in the project:

```sh
npm install --save-dev path/to/soz-guard-0.2.0.tgz
npx soz-guard init
```

(From a checkout of this repository, without installing: `node --experimental-strip-types
--disable-warning=ExperimentalWarning path/to/soz/guard/src/cli.ts init`, Node 22.6 or newer.)

`init` adds, without touching what is already there:

- a `SessionStart` and a `Stop` hook in `.claude/settings.json`;
- a `.soz-guard.json`, with `npm test` as a required check if the project has a test script;
- `.soz-guard/` in `.gitignore` (verdicts and caches stay local);
- a short "Finished means finished" section in `CLAUDE.md`.

Every Claude Code session in that project, in every tab, then runs it when the agent tries to stop.
The hook calls this Node by its full path, because a desktop app's PATH may not include it; after
moving Node or the package, run `init` again.

## Required checks

`.soz-guard.json`, set by the repository's owner:

```json
{
  "checks": [
    {"name": "tests", "run": "npm test", "timeoutSeconds": 600},
    {"name": "types", "run": "npx tsc --noEmit", "when": ["src/**/*.ts"]}
  ]
}
```

A check runs when something it covers changed (`when`, glob patterns; without it, on any change),
through the shell, in the repository's folder. Exit 0 is passed; anything else failed; a check that
outlives `timeoutSeconds` (600) or cannot start leaves the work `unverified`. The checks run only once
the static part is clean (unfinished work has to be finished first anyway), and their results are
kept for exactly this change: stopping again without changing anything does not run them again.

When a check fails, the agent sees its name, the exit code and the last 30 lines of its output, and
is told to fix the code, not the check.

## Holdout checks: tests the agent does not see

An agent that sees a failing test's expected value can write code that produces that value and nothing
more. Against that, the owner can keep some tests out of the agent's sight:

```json
{"name": "hidden", "run": "node --test %USERPROFILE%/.soz-guard/holdout/shop/", "holdout": true}
```

The tests live outside the repository (Claude Code asks the user before the agent reads a file
outside the project). When such a check fails, the agent is told only that a hidden check failed, to
re-read the requirement and check its work against it, and to ask the user if it is unclear: not the
output, and not the command. The output goes to a file outside the repository,
`~/.soz-guard/holdout-results/<project>/<check>.txt` (`SOZ_GUARD_HOME` moves it), and `soz-guard
check` names that file. `.soz-guard/last.json`, the cache and the log in the repository hold only
passed or failed. A holdout check is never taken from the cache: its tests can change without the
repository changing.

Plainly: locally, this is a matter of not showing, not of locking. The command is in
`.soz-guard.json`, and an agent that insists can ask to read the folder; the user then sees it ask.
Holdout tests that must stay secret belong in CI, in a repository or a secret the pull request cannot
read.

## The criteria

What "finished" means is defined by the tests, the CI configuration and `.soz-guard.json`. These
belong to the repository's owner. soz-guard treats a change to them as a person's decision:

| Change | Verdict |
|---|---|
| Change | `"assertions": "fewer"` (default) | `"assertions": "any-change"` |
|---|---|---|
| a new test or a new assertion | fine | fine |
| an existing assertion changed (an expected value, a matcher), as many as before | fine | `open` |
| an existing assertion moved unchanged | fine | `open` (a diff cannot tell a move from a change) |
| fewer assertions in a file than before | `open` | `open` |
| a test or CI file deleted | `open` | `open` |
| `.soz-guard.json` changed | `open` | `open` |

`"fewer"` catches a test being emptied; `"any-change"` also catches an expected value quietly bent to
fit the code (`toBe(80)` becoming `toBe(70)`), which `"fewer"` lets through. A live trial showed why
the strict mode does not excuse a removed line when the same text appears elsewhere: a new test can
assert the same line, and an edited old one would hide behind it. Start with `"fewer"`, measure with
`replay` how often `"any-change"` would stop you, and switch when the cost is acceptable.

Which files count: `.soz-guard.json`, `test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`,
`*_test.*`, `test_*.py`, `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, and whatever you add
under `"criteria"`. With `"criteriaChanges": "report"` such changes are only reported.

A test sometimes really is obsolete. Then a person accepts the change, in a terminal:

```sh
npx soz-guard accept "the old pricing test covered a rule we removed"
```

It asks to type `yes`, and refuses piped input: an agent runs commands without a terminal. The
acceptance is bound to exactly these changes; any further change to the tests or rules needs
accepting again. Be clear about what this is: on one machine an agent can do whatever its user can,
so locally this slows an agent down rather than stops it. **CI is where the rule is enforced**, on
the pull request, where the agent cannot accept anything.

## In CI

```sh
npx soz-guard ci --base origin/main             # exit 1 unless finished
npx soz-guard ci --base origin/main --checks    # run the required checks too
npx soz-guard ci --criteria report              # a team that reviews test changes in the PR itself
```

On GitHub Actions `--base` defaults to the pull request's base branch. The change is everything the
branch adds since it left the base (the merge base). In CI the tests usually run in their own step;
`--checks` is for when soz-guard should run them itself.

**Run soz-guard in CI from a source the pull request cannot change**: a published version pinned by
number, or a commit of soz-guard's own repository pinned by hash. Never from a copy inside the
repository being checked, which the agent's branch could have edited. (soz-guard is not on npm yet;
until it is, pin a commit of this repository.)

## Integrity: soz-guard's own footing

The hooks that run soz-guard and the instructions that tell the agent the rules belong to the owner as
much as the tests do. A change to them is a criteria change (`guard`) that a person accepts:

| Change | Verdict |
|---|---|
| a hook removed or changed in `.claude/settings.json` or `.claude/settings.local.json` | `open` |
| `disableAllHooks` set in either | `open` |
| soz-guard's section in `CLAUDE.md` or `AGENTS.md` rewritten or removed | `open` |
| a permission granted (Claude Code writes it to `settings.local.json`), any other part of `CLAUDE.md` | fine |

`settings.local.json` is usually ignored by git, so within a session these are compared with what the
files held when the session started, not with the diff. Every verdict, every decision of the hook and
every acceptance is appended to `.soz-guard/log.jsonl`, each line chained to the one before by its
SHA-256; `soz-guard log --verify` shows where the chain breaks if a line was removed or edited.

What this does not cover, plainly: on one machine an agent can do whatever its user can. It can edit
soz-guard's own source, your user-level `~/.claude/settings.json`, or the log and its chain from the
start. Locally, soz-guard makes such moves visible and slows them down; CI, running soz-guard from
outside the change, is where they are stopped.

## Only what the agent changed

When a Claude Code session starts, the `SessionStart` hook records the working tree as it is, tracked
and untracked files alike, as a git tree. When the agent tries to finish, the verdict is about what
changed since then, committed or not, and about nothing else. Work that was already uncommitted
before the session, yours or an earlier agent's, is not held against this one: a project does not
have to be clean to use soz-guard.

The snapshot is taken with a copy of git's index, so the working tree, the real index and the branch
are never touched; git only stores the files' contents as objects, as `git stash` does. It takes well
under a second. A resumed session keeps its own snapshot; snapshots older than 14 days are removed.
Without one (soz-guard installed in the middle of a session), the verdict is about what changed since
`HEAD`, as before.

One limit: what a person changes in the same folder while the agent works counts as the agent's
change. Git cannot tell the two apart.

## The hook

When the agent tries to stop and the verdict is `open` or `unverified`, the hook exits with code 2
and tells the agent what is open, so it continues instead of stopping. To never trap an agent in a
loop, it does this at most `maxBlocks` times (3); after that it lets the agent stop and tells the
person, plainly, that the work is not finished. Outside a git repository it does nothing. If it
fails itself, it says so and does not block.

## A pilot: replay the past

Before relying on it, see what it would have done:

```sh
npx soz-guard replay main~50..main          # each commit with its verdict
npx soz-guard replay main~50..main --json   # the same, for counting
```

Take commits where an agent said "done" and something turned out missing, and commits that were
fine. Count both: how many gaps soz-guard catches, and how many good changes it would have stopped
for nothing. (Replay judges the static rules and the criteria; it does not run checks on the past.)

## Unfinished is allowed; unsaid is not

Sometimes something cannot be finished now: the API it needs does not exist yet, or only the user
can decide. Then the line stays, marked:

```ts
return 0; // soz-guard: ignore the stock service has no release call yet
```

and the agent says so in its final message. The marker is the point: the gap is now visible in
the code, in the diff and in review.

## The static rules

Only what changed: the lines the change adds, and new files whole. Old TODOs already committed are
not its business.

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

Markdown, lock files, `node_modules`, `dist` and `build` are skipped. Your own rules and settings:

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

## By hand

```sh
npx soz-guard check              # the verdict on what changed since HEAD, checks run; exit 1 unless finished
npx soz-guard check --json
npx soz-guard scan               # the static rules only
npx soz-guard log                # the last verdicts, hook decisions and acceptances
npx soz-guard log --verify       # whether the log's chain is intact
```

## What it is not

It finds work left unfinished without saying so, runs the checks the owner requires, and keeps the
agent from weakening them. It does not know whether the checks are good enough: a requirement no
test covers can still be missed, which is why the owner, not the agent, decides what the checks
are. Its static rules read lines, not programs, so a determined way of hiding a gap will pass; they
make the common, unintended gaps visible, which in practice are most of them. And a flaky test makes
a flaky verdict: the record in `.soz-guard/last.json` shows which check said what.
