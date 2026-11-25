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

Requires Node 18 or newer and git. Install it once per machine, then set it up in the project:

```sh
npm install -g soz-guard
cd path/to/your/project
soz-guard init
```

(Installed globally, not as a project dependency, so that the hook works the same on every machine,
whatever the project's own `node_modules` hold.)

(From a checkout of this repository, without installing: `node --experimental-strip-types
--disable-warning=ExperimentalWarning path/to/soz/guard/src/cli.ts init`, Node 22.6 or newer.)

`init` adds, without touching what is already there:

- a `SessionStart` and a `Stop` hook in `.claude/settings.json`;
- a `.soz-guard.json`, with `npm test` as a required check if the project has a test script;
- `.soz-guard/` in `.gitignore` (verdicts and caches stay local);
- a short "Finished means finished" section in `CLAUDE.md`.

Every Claude Code session in that project, in every tab, then runs it when the agent tries to stop.
The hook calls this Node by its full path, because a desktop app's PATH may not include it; after
moving Node or the package, run `init` again: it updates soz-guard's hooks to where they are now.

**In a team**, those full paths are one machine's. Each person runs, on their own machine:

```sh
soz-guard init --local
```

which puts the hooks in `.claude/settings.local.json` and adds that file to `.gitignore`, so no
machine's paths are committed for the others. (If `.claude/settings.json` already runs soz-guard from
the machine that committed it, `init --local` says so; the owner removes it there once everyone has
run `init --local`. A hook `settings.json` already runs on this machine is not added again: both
would run.) If `settings.local.json` is already in git, `.gitignore` does not take it out; `init --local`
says so and gives the one command that does. A hook written by hand that finds soz-guard itself, such as
`npx soz-guard hook`, works on every machine, and `init` leaves it as it is. Where soz-guard lives is
not part of what counts as finished: its hook pointed at another Node or another copy of soz-guard is not a change a person has to accept, as long as it is
this soz-guard, on this machine. Pointed at some other `cli.js`, it is.

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
| a test switched off or narrowed: `.skip`, `.only`, `xit`, `@pytest.mark.skip`, `@Disabled` | `open` | `open` |
| a real assertion swapped for one that cannot fail (`expect(true).toBe(true)`, `assert True`) | `open` | `open` |
| what runs the tests changed (see below) | `open` | `open` |

`"fewer"` catches a test being emptied; `"any-change"` also catches an expected value quietly bent to
fit the code (`toBe(80)` becoming `toBe(70)`), which `"fewer"` lets through. A live trial showed why
the strict mode does not excuse a removed line when the same text appears elsewhere: a new test can
assert the same line, and an edited old one would hide behind it. Start with `"fewer"`, measure with
`replay` how often `"any-change"` would stop you, and switch when the cost is acceptable.

Which files count: `.soz-guard.json`, `test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`,
`*_test.*`, `test_*.py`, `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, and whatever you add
under `"criteria"`. A file renamed out of them (`test/pay.test.ts` to `old/pay.ts`) no longer runs as
a test, so it counts as deleted. A line whose only change is its ending (LF and CRLF, as different
machines check files out) has not changed. With `"criteriaChanges": "report"` such changes are only
reported.

**What runs the tests is part of the tests.** A required check is a command such as `npm test`; what it
runs is decided elsewhere, and an agent that sets the test script to `exit 0`, or tells jest to leave a
folder out, has weakened the tests without touching one. So these are criteria changes too:

- in `package.json`, an existing script changed or removed (adding a script, or a dependency, is fine), and
  the runners' sections (`"jest"`, `"ava"`, `"mocha"`, `"vitest"`, `"c8"`, `"nyc"`). More commands added at
  the **end** of a script with `&&` are fine: they run only after everything before them passed, so they
  can add a failure but never hide one. A command put anywhere earlier could delete the tests that run
  after it, so that one is accepted by a person;
- a test runner's config file, any change, a new one included: `jest.config.*`, `vitest.config.*`,
  `playwright.config.*`, `cypress.config.*`, `karma.conf.*`, `.mocharc*`, `ava.config.*`, jest's and
  vitest's setup files, `pytest.ini`, `tox.ini`, `conftest.py`, `noxfile.py`, `phpunit.xml`, `.rspec`;
- pytest's section in `pyproject.toml` or `setup.cfg` (the rest of those files is free);
- whatever you add under `"runners"` in `.soz-guard.json` (a `Makefile`, if `make test` is your check).

A `soz-guard: ignore` comment does not excuse any of these: it is the agent's word that something is
unfinished, not a person's acceptance.

**A change is judged by the rules from before it.** `.soz-guard.json` is read as it is at the base (the
session's start, `HEAD`, or the pull request's base), not as the change leaves it: a branch that deletes
a test and, in the same commit, sets `"criteriaChanges": "report"`, switches a rule off, removes a check
or sets `"maxBlocks": 0`, is judged by the rules it tried to replace. Its new config is itself a criteria
change. Once a person accepts it, the new rules apply; after the merge, they are the base.

A test sometimes really is obsolete. Then a person accepts the change, in a terminal:

```sh
soz-guard accept "the old pricing test covered a rule we removed"
```

It asks to type `yes`, and refuses piped input: an agent runs commands without a terminal. The
acceptance is bound to exactly these changes; any further change to the tests or rules needs
accepting again. An acceptance lives in `.soz-guard/`, on the person's machine; one that is in git came
with a change and accepts nothing, so `accept` refuses until it is taken out of git. Be clear about what this is: on one machine an agent can do whatever its user can,
so locally this slows an agent down rather than stops it. **CI is where the rule is enforced**, on
the pull request, where the agent cannot accept anything.

The acceptance stays on the machine where it was typed (`.soz-guard/`, which git ignores). One that is
in git, or in the commit being judged, came with the change (an agent can write one and `git add -f`
it), so it accepts nothing and is reported as a change of its own, in CI and everywhere else.

## In CI

```sh
soz-guard ci --base origin/main             # exit 1 unless finished
soz-guard ci --base origin/main --checks    # run the required checks too
soz-guard ci --criteria report              # a team that reviews test changes in the PR itself
```

On GitHub Actions `--base` defaults to the pull request's base branch. The change is everything the
branch adds since it left the base (the merge base), up to its last commit: files lying uncommitted in
the folder are not the branch's and are not judged. In CI the tests usually run in their own step;
`--checks` is for when soz-guard should run them itself. The checks run on the folder, so `--checks` runs
them only when the folder is exactly the branch's last commit; otherwise the verdict is `unverified` and
names the files in the way. On a shared server, check the branch out on its own (a `git worktree`).
What builds and test runs leave behind (`dist/`, `build/`, `coverage/`, `__pycache__/` and the like) is
not in the way; add your own outputs to `"exclude"`. soz-guard needs the history back to the merge base:
with `actions/checkout`, set `fetch-depth: 0` (a shallow clone is said plainly, not as a git error).

**Run soz-guard in CI from a source the pull request cannot change**: a published version pinned by
number, or a commit of soz-guard's own repository pinned by hash. Never from a copy inside the
repository being checked, which the agent's branch could have edited. (`npx soz-guard@0.5.1 ci ...`, by
exact version.)

## On the server: the gate in front of what goes live

Where the repository lives on a server of your own (and a push to it is what goes live, or goes to the
tests before it), the gate sits in that repository as a git `pre-receive` hook. A push to a protected
branch is let in only when soz-guard says the work is finished: the pushed commit is checked out in a
folder of its own, the setup command installs what the checks need, and the checks run on exactly that
commit. Otherwise git turns the push down and the pusher sees why. Other branches are let in as they are,
for an integrator to look at.

```sh
cd /srv/git/shop.git                       # the repository on the server
soz-guard gate install --branches main --setup "npm ci"
soz-guard gate check feature/x --base main  # by hand: the verdict on a branch, before merging it
soz-guard gate approve 3f9c2a1b7e44 "the old pricing test covered a rule we removed"
soz-guard gate log --last 50                # every verdict, who pushed, what it found; --verify the chain
```

A change to the tests or rules is approved by a person on the server, in a terminal, for exactly that
commit (the hash the gate printed; git does not keep a push it turned down, the gate's report does).
An approval accepts those changes only: the checks still have to pass.

**The gate holds only if the people who push, and their agents, cannot write to it.** Make the repository
belong to a user of its own (`git`, say), let the developers reach it only through git over ssh
(`git@server:/srv/git/shop.git`, with `git-shell`), and install soz-guard for that user, outside any
project. This matters most when an agent works on the server itself, as with VS Code's Remote-SSH: the
agent then runs commands on the server as its developer, so the developer's user must not be able to
write the repository's hooks or `.soz-guard/` folder, nor become the `git` user without a password
(`sudo` that asks for one). Approving is then `sudo -u git soz-guard gate approve ...`, typed by a person.

## Tasks: what the user asked for, proved on the delivery

The checks say the code works; they do not say the user got what they asked for (the contract page is
there, but no menu links to it). With the gate, a task can say it, as [SPEC.md](SPEC.md) lays out:

1. The agent writes the task as 2 to 5 behaviours in the user's words, in `acceptance/<task>.json`, and one
   test per behaviour, named with the item's tag (`[A1] ...`), that writes a JUnit report to
   `$SOZ_GUARD_JUNIT` (`npx playwright test e2e/a1.spec.ts --reporter=junit`, with the runner's output
   file set to it). An item can instead be proved by a person.
2. The person approves the items in words, on the server: `soz-guard gate task approve T1 <branch>`.
   Changing an item, its test or its command afterwards voids the approval.
3. When the task is pushed to a protected branch, the gate runs each item's test **on what was live before
   the task** and **on the delivery**. An item is proven when its test failed before and passes now. A test
   that passed before too (the behaviour was already there) waits for the person to confirm it once
   (`gate task confirm T1 A1 <commit>`): a test that cannot fail looks the same. A test that cannot run
   proves nothing.
4. The push is let in only when every required item is proven, confirmed by the person, or taken out by
   them (`gate task descope T1 A1 "<why>"`). A `soz-guard: ignore` mark makes a gap visible; it never closes
   an item.

```
soz-guard gate: main 3f9c2a1b7e: open, not let in
Task T1 (Contract reachable from the Terms menu): incomplete, A1 missing
  MISS A1  In the Terms of Use menu, the Distance Sales Contract link opens the contract
         missing: the terms menu has no link to Mesafeli Satis Sozlesmesi
```

`soz-guard gate task status T1` gives the task's state on what is live, worked out then and there; the
model saying "done" changes nothing. Approving, confirming and taking out need a terminal, on the server:
an agent cannot do them. A decision to take an item out holds for the item as it was worded then: reworded
and approved again, it is judged again. A complete task says what it rests on ("2 proven on this delivery,
1 taken out by a person"), not that everything was proven.

### Only task deliveries

By default a push that carries no task is judged as any change. The owner can make a protected branch take
only the delivery of a task:

```sh
soz-guard gate install --branches main --require-task
```

Then a push to `main` goes in only when it carries a task (its `acceptance/<task>.json` added or changed, or
a commit message with a line `Task: T1`) and every task it carries is `complete` on exactly the pushed
commit. A push with no task is turned down, and so is `unchecked`: with nothing configured to run, the
task's own tests are the evidence. An urgent fix with no task goes in only when a person lets that one
commit in, with a reason, on the server: `soz-guard gate approve <commit> "<why it goes in without a task>"`.
So does the first push to an empty repository, which has nothing to judge a task against.
`--no-require-task` turns it off.

### The package: the same files the checks ran against

Passing tests show that the commit works. They do not show that the folder copied to the live server is
that commit's: an old build, a folder from another branch or a hand-edited file look the same from outside.
The gate can build the package itself, once, and judge that:

```sh
soz-guard gate install --branches main --build "mvn -q package -DskipTests" --package target/app.war
soz-guard gate install --branches main --build "npm run build" --package dist          # a folder works too
```

The checks and the task tests are given the package the gate built: its path is in `$SOZ_GUARD_PACKAGE`
(on the base, the base's own build). The gate does not start it. Whether a test starts or reads that
package, rather than the sources, is up to the test, so for the items that matter write the test to start
the package from that path and do the user's steps on it. The package's sha256 digest goes into the
verdict, the task's evaluation and the gate's log, and a person's confirmation of an item is for that
package too: if the same commit builds into a different package, the item waits for the person again. A
package that does not build is not let in.

Only a push that a protected branch lets in releases a package, once per commit; `gate check` by hand
judges a build but never replaces what was released. Packages are stored under their digest and never
rewritten. The newest 5 releases are kept whole (`--keep-packages N`), the manifests of all of them for good:

```sh
soz-guard gate package 3f9c2a1b7e44                        # its digest, its files, where they are kept
soz-guard gate package 3f9c2a1b7e44 --to D:/deploy/v928    # a copy to deploy, into an empty folder
soz-guard gate package 3f9c2a1b7e44 --verify D:/sites/erp --ignore logs,uploads
soz-guard digest D:/sites/erp --ignore logs,uploads         # on a live server that is another machine
```

`--verify` compares the live folder (or file) with the package file by file and names what is changed,
missing or not in the package; `--ignore` leaves out what the live server writes itself. Every copy and
comparison is in the gate's log, with who did it. The gate's last word is still "this package was judged";
whether it is the one running is what `--verify`, run after each deployment, answers.

## Integrity: soz-guard's own footing

The hooks that run soz-guard and the instructions that tell the agent the rules belong to the owner as
much as the tests do. A change to them is a criteria change (`guard`) that a person accepts:

| Change | Verdict |
|---|---|
| a hook removed or changed in `.claude/settings.json` or `.claude/settings.local.json` | `open` |
| soz-guard's own hook pointed at a soz-guard that is not on this machine | `open` |
| soz-guard's own hook run from another Node or copy of soz-guard on this machine (`init` again) | fine |
| `disableAllHooks` set in either | `open` |
| a hook removed or changed in `.codex/hooks.json`, or a line about hooks in `.codex/config.toml` | `open` |
| soz-guard's section in `CLAUDE.md` or `AGENTS.md` rewritten or removed | `open` |
| a permission granted (Claude Code writes it to `settings.local.json`), any other part of `CLAUDE.md` | fine |
| soz-guard's section added where there was none | fine |
| hooks added to a file that held none (a new `.codex/hooks.json`, say), unless they switch hooks off | fine |

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

## Several sessions in one folder

Some people run many Claude Code sessions in the same project at once (one for the ERP part, one for
the CRM, one that coordinates them). Then the difference from one session's snapshot holds the others'
work too, and a gap one session left would stop all of them. With

```sh
soz-guard init --sessions
```

each session answers for the files it touched. A `PostToolUse` hook records the files a session edits
(Edit, Write, MultiEdit, NotebookEdit), and for a shell command (Bash, PowerShell) the files that changed
while it ran, from a snapshot before and after it. When the session tries to finish, only those files
are judged; the verdict in `last.json` lists the rest under `foreign`, left to the sessions that made
them. A session that touched nothing answers for nothing.

What it cannot separate, plainly:

- **The checks run on the whole folder.** A test another session broke fails for this one too. The
  agent is then told which files other sessions changed and not to edit them; it says so and stops.
  Separate folders (a git worktree per session) are the only full isolation.
- **A shell command's window.** What another session changes while this one's command runs counts as
  this one's: it judges more, never less. A command left running in the background is not followed.
- **Changes made some other way** (an MCP tool that writes files, an editor) are nobody's, so they are
  not judged. That is why this is a choice (`--sessions`), not the default. Each shell command also
  costs two snapshots, well under a second each in a project of a few thousand files.

Sessions already open when it is installed do not have the hooks yet: Claude Code reads hooks when a
session starts. Close them and open them again from the conversation history; nothing is lost.

## The hook

When the agent tries to stop and the verdict is `open` or `unverified`, the hook exits with code 2
and tells the agent what is open, so it continues instead of stopping. To never trap an agent in a
loop, it does this at most `maxBlocks` times (3); after that it lets the agent stop and tells the
person, plainly, that the work is not finished. Outside a git repository it does nothing. If it
fails itself, it says so and does not block.

When the only thing open is a change to the tests or rules, the agent cannot resolve it: a person
accepts it. Then the hook stops the agent and tells it to say so in its final message. If it then
stops without changing anything else, it is let go, and the person is told each time that the change
still waits for them. If it goes on working instead, or changes the tests or rules further, it is
stopped again, within `maxBlocks` like any other stop. Without a session id (an older client), the
count of stops is kept per repository.

## Other agents: a git hook, and Codex

```sh
soz-guard init --git             # a git pre-commit hook, for any agent and for people
soz-guard init --git --checks    # ... that runs the required checks too
soz-guard init --codex           # Codex's SessionStart and Stop hooks, in .codex/hooks.json
soz-guard init --claude --codex --git    # any combination; without a flag, --claude
```

**The pre-commit hook** judges exactly what is being committed: the staged files against `HEAD`,
nothing left unstaged. A gap, a deleted test or a weakened rule in the commit stops it. With
`--checks` the required checks run as well, but only when the working tree is what is being committed;
otherwise it refuses and says so, since tests that pass on files left out of the commit say nothing
about the commit (`git stash --keep-index --include-untracked` sets the rest aside). The hook is
`.git/hooks/pre-commit` (or under `core.hooksPath`); one that is already there is never overwritten,
and `init` prints the line to add to it. Committing soz-guard's own setup changes the criteria, so that
first commit is the owner's: `git commit --no-verify`, deliberately.

This works with any agent that commits, but only at the commit: an agent that never commits, or one
that runs `git commit --no-verify`, passes it by. As everywhere locally, CI is where it is enforced.

**Codex** has lifecycle hooks much like Claude Code's: the same fields on standard input, and a Stop
hook that exits 2 makes the agent continue, with the reason as its next prompt. `init --codex` adds
soz-guard's two hooks to the project's `.codex/hooks.json` and its section to `AGENTS.md`; Codex asks
once, in `/hooks`, to trust them. A change to those hooks, or hooks switched off in
`.codex/config.toml`, is a `guard` change, as for Claude Code. (Written from Codex's documentation and
tested with Codex's input format; not yet tried in a live Codex session.)

## A pilot: replay the past

Before relying on it, see what it would have done:

```sh
soz-guard replay main~50..main          # each commit with its verdict
soz-guard replay main~50..main --json   # the same, for counting
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

The marker is the point: the gap is now visible in the code, in the diff and in review. It needs its
reason after it (what is left, and why); a bare `soz-guard: ignore`, or one with a reason that says
nothing, excuses nothing and the line is reported as before.

What was left is not left to the agent's final message either. Every marked line the change adds is
recorded in the verdict (`deferred` in `.soz-guard/last.json`: file, line, what it would have been reported
as, the reason) and in the log, and when the hook lets the agent stop, soz-guard tells the person itself:

```
soz-guard: the agent may stop (unchecked), but it left work as it is:
Left as it is, on the agent's word (soz-guard: ignore), 1 line(s):
  src/stock.ts:12  [todo]  the stock service has no release call yet
```

`soz-guard check`, `ci` and the gate show the same list. A marked line does not keep the work open: it is
the agent saying what it left, which a person then sees.

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
| `empty-function` | `function f() {}`, `save() {}`, `onClick={() => {}}`, `handleSave = () => {}`, `const cancel = () => {}` | `useEffect(() => {}, [])`, `if (x) {}`, `constructor() {}`, `const noop = () => {}`, `done = () => {}` as a default |

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
soz-guard check              # the verdict on what changed since HEAD, checks run; exit 1 unless finished
soz-guard check --json
soz-guard scan               # the static rules only
soz-guard log                # the last verdicts, hook decisions and acceptances
soz-guard log --verify       # whether the log's chain is intact
```

## What it guards against, and what it does not

soz-guard is a seatbelt for an agent that cuts corners: one that says "done" with work left, or makes a
failing test pass by weakening it. That is the common failure, and it catches it. It is **not a security
boundary against an agent set on getting past it**, and should not be taken for one:

- **On the machine where the agent works, the agent can do whatever its user can.** It can write
  `.soz-guard/accepted.json` itself (the fingerprint is computed from data it can read), append to the log
  (anyone can compute the chain), or delete the hook's state. The terminal check in `soz-guard accept`
  guards the command, not the file. Locally, soz-guard slows a determined agent down and leaves traces; it
  does not stop it.
- **The gate is where the rule holds**: `soz-guard ci` run where the agent cannot write (a CI runner, the
  server's own user for its git hooks), from a soz-guard the change cannot edit, on the branch's commits.
  There a committed acceptance accepts nothing and the rules are those from before the change.
- **Even there, it judges what changed, not whether the code is right.** Code written to the tests
  (`if (n === 2) return 2`) passes them; holdout checks, which the agent never sees, are the answer to that.
  The static rules read lines, so unfinished work written without the words they look for passes them.
- A person still looks at the change before it goes live. soz-guard tells them where to look.

## What it is not

It finds work left unfinished without saying so, runs the checks the owner requires, and keeps the
agent from weakening them. It does not know whether the checks are good enough: a requirement no
test covers can still be missed, which is why the owner, not the agent, decides what the checks
are. Its static rules read lines, not programs, so a determined way of hiding a gap will pass; they
make the common, unintended gaps visible, which in practice are most of them. And a flaky test makes
a flaky verdict: the record in `.soz-guard/last.json` shows which check said what.
