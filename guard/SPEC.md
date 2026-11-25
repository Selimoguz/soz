# soz-guard: tasks and acceptance — draft 0.1

Status: **approved; built in soz-guard 0.5.0 for deliveries that are commits** (`soz-guard gate task`, and
the gate judging every task a push carries), and in 0.5.1 for packages the gate builds, with a branch that
takes only task deliveries (§9.3, §9.6). Not built yet: the gate starting the package itself and evidence
from the live URL, screenshots as evidence (step 11), and feedback from the tasks in the local hook.
The proposed answers to §9.1, 9.2, 9.4 and 9.5 are what was built.

## 1. The promise

Today soz-guard answers "did the agent leave work unfinished, weaken the tests, or skip the checks?". It
does not answer "is what the user asked for there?": a change can pass every check and still miss the one
thing the user wanted (the contract page exists, but no menu links to it).

The promise this draft adds, and the only one it makes:

> A delivery counts as **complete** only when every required behaviour of the task was verified,
> independently, on the version that is delivered. Any behaviour without such evidence is shown to the
> person as unproven or missing, by soz-guard, whatever the agent says.

It does not promise that the software is correct beyond those behaviours. A requirement nobody wrote
down is still missed; the person decides what is required.

## 2. Who may say "complete"

**Rule 1. The model may ask for completion. Only soz-guard, running where the model cannot write,
changes a task's state.**

- The agent can always *say* "done" in a chat; soz-guard cannot stop a sentence. What it controls is the
  record the person relies on: the task's state, and through it whether a branch merges or a package
  ships.
- **The decision is made by the gate** (`soz-guard gate` on the server, or a CI job), running as a user the
  developers and their agents cannot act as. The local hook gives the agent early feedback; it decides
  nothing about the task.
- **Whatever closes, merges or publishes asks the gate**, for that task and that delivery. A `last.json`,
  a screenshot or a "tests pass" from the model's side is never evidence.

The four cases the gate must hold, whatever model is used:

| Case | Required behaviour |
|---|---|
| The model says "done" without running anything | The task stays open. Nobody has to ask the model to run a check: when completion is requested (a push, a merge, a release), the gate runs the checks itself. |
| The model changes an item, its test, or the command that runs it | The person's approval no longer applies. The task cannot become complete until the person approves the new version. The approval record lives where the model cannot write (the gate). |
| No check ran, a check crashed, or a required item was marked `ignore` | The agent may stop working. The task is **unverified** or **incomplete**, never complete. Reaching `maxBlocks` is never success. |
| A test passed, then the delivered code or package changed | The old result does not count for the new delivery. Evidence is bound to the task, the approved version of its items, and the delivery's digest (§5). |

## 3. Terms

- **Task**: one request from the user ("add the sales contract to the Terms menu"), with an id.
- **Item**: one observable behaviour the task requires, in the user's words ("In the Terms of Use menu,
  the contract link opens the contract"). An item is **required** unless the person marks it optional.
- **Proof** of an item: either a **check** (an automated test bound to the item, §4) or a **person**
  (someone looks at the delivery and confirms it; for what cannot be tested yet).
- **Binding**: for a checked item, the test's file and test name, the hash of the test file, and the
  command that runs it, recorded together.
- **Delivery**: what is being judged as the result: a commit, and, where the project ships a package (a
  ZIP, an image), that package, identified by its SHA-256.
- **Base**: the version before the task (the live branch's commit when the task started).

## 4. A task, step by step

### 4.1 Items, approved in words

1. The agent proposes 2 to 5 items from the user's request, in plain language: what a user does and what
   they see. Not "the contract was added" but "clicking the contract link in the Terms of Use menu opens
   the contract".
2. The person approves them, in words. **The person is not asked to read test code** to approve items.
3. The items are written to `acceptance/<task-id>.json` in the repository, which is a criteria file:
   removing or weakening an item later is a criteria change.
4. The approval itself (task id, the hash of the items, who, when) is kept by the gate, not in the
   repository: the agent cannot write it.

### 4.2 Tests, bound to items

5. The agent writes one test per checked item, tagged with the item's id in its name (`[A1] the Terms
   menu links to the contract`), and records the binding (file, test name, file hash, command) in
   `acceptance/<task-id>.json`.
6. The binding is locked with the items: changing the bound test's content, its command, or which item it
   proves voids the approval (§2). This does not require `"assertions": "any-change"` for the whole
   project; only the bound tests are held to it.
7. **A test proves an item only if it exercises the user's path.** For a web item that means starting
   where the user starts (the menu), not at the end (the contract's URL). The gate cannot judge this
   alone; §4.3 tells it when to ask.

### 4.3 Run on the base first: missing for the right reason

8. The gate runs each bound test on the **base**, before the agent's change. Three outcomes:

| On the base | Means | What happens |
|---|---|---|
| the test **fails** (an assertion did not hold) | the behaviour was missing, for the reason the item names | fine; the test is accepted as evidence |
| the test **passes** | the behaviour was already there | fine, and reported as such ("already true before this task"). The agent must not break code to show red. Because a test that passes from the start is also what a hollow test looks like, the gate shows the person what this test does (its steps, and a screenshot for web items) and asks them to confirm it once. |
| the test **errors** (could not start: no browser, a syntax error, a missing fixture) | nothing is known about the behaviour | the test is not evidence yet; the item is **unproven** until it runs |

9. Telling "failed" from "errored" needs the test runner's own report, not its exit code: the gate reads a
   JUnit XML report (which Jest, Vitest, Playwright, pytest and most others write), where an assertion
   failure and an error are separate. (Open decision, §9.)

### 4.4 Run on the delivery

10. When completion is requested (a push to a protected branch, a merge, a release), the gate builds the
    delivery in a clean folder: the commit checked out, the setup command run, and, if the project ships
    a package, the package built the way it is shipped, then unpacked and started from it.
11. It runs every bound test on that delivery and records, per item: the result, the binding's hash, the
    delivery's commit and package digest, and the evidence (the runner's report; for a web item that
    failed, a screenshot of the step that failed).

## 5. Item states, and the task's verdict

| Item state | When |
|---|---|
| `proven` | its bound test passed on this delivery (and, if it already passed on the base, the person confirmed the test) |
| `missing` | its bound test failed on this delivery |
| `unproven` | no bound test, the test errored or was skipped, or its binding changed since approval |
| `awaiting-person` | a person-proved item nobody has confirmed on this delivery yet |
| `confirmed` | a person confirmed it on this delivery |
| `descoped` | the person removed it from the task, or put it off explicitly (recorded by the gate, with a reason, for the item as worded then: reworded, it is judged again) |

The task's verdict:

- **complete**: every required item is `proven`, `confirmed` or `descoped`;
- **incomplete**: some required item is `missing`;
- **unverified**: otherwise (something is `unproven` or `awaiting-person`).

A `soz-guard: ignore` mark never changes an item's state. It makes something visible ("the menu link is
left for later", told to the person, as 0.4.1 does); if the menu link is a required item, the task is
still incomplete until the person descopes it.

Evidence is bound to `(task id, approved items hash, delivery commit, package digest)`. Change any of
them and the evidence is gone; the gate runs again.

What the gate proves ends at the delivery. If copying the package to the live server is a manual step,
the gate's last word is "package verified", not "live". Evidence from the live system is a separate item
(a check against the live URL), if the person wants one.

## 6. The first three examples

All three use one task from a real case: **T1: "The distance sales contract must be reachable from the
Terms of Use menu."** One required item:

> **A1**: On the site, opening *Terms of Use* from the menu and clicking *Distance Sales Contract* opens
> the contract, with its heading.

Bound test (Playwright, in `e2e/a1-contract.spec.ts`): start at the home page of the delivered package,
open the menu, click *Terms of Use*, click *Distance Sales Contract*, expect the heading.

### E1. No work was done

| | |
|---|---|
| What is tried | The agent stops without changing anything, or changes something unrelated. |
| On the base | A1 fails: no link in the menu (missing for the right reason). |
| On the delivery | The delivery is the base, or the same as it for A1: A1 fails. |
| Verdict | **incomplete**: "A1 missing". If the agent did not even write the test, A1 is **unproven** and the task **unverified**. Either way, not complete. |
| Evidence, from which version | A1's report and a screenshot of the menu without the link, on delivery commit `<sha>`, package `<sha256>`. |
| soz-guard 0.4 today | `unchecked`, exit 0: the agent may stop, and nothing says the task was not done. |

### E2. Code was written, the menu link is missing

| | |
|---|---|
| What is tried | The agent adds the contract page and a KVKK page, and the type check passes, but no menu links to the contract. |
| On the base | A1 fails (no contract, no link). |
| On the delivery | A1 fails at "click *Distance Sales Contract*": the link is not in the menu. Opening the contract's URL directly would work, which is why the test starts at the menu. |
| Verdict | **incomplete**: "A1 missing: the Terms of Use menu has no link to the contract". |
| Evidence, from which version | A1's report, the screenshot of the menu, on the delivery's commit and package digest. |
| soz-guard 0.4 today | `verified`: the type check ran and passed. |

### E3. The behaviour was already there

| | |
|---|---|
| What is tried | The user asks for A1, but the link already exists. |
| On the base | A1 passes. |
| What happens | The gate reports "A1 already true before this task (passed on base `<sha>`)" and shows the person the test's steps and the screenshot of the contract opened from the menu, once, to confirm the test is real. The agent is not asked to break anything to show red. |
| On the delivery | A1 passes. |
| Verdict | **complete** once the person confirmed the test; **unverified** until then. |
| soz-guard 0.4 today | `unchecked` if nothing changed: the same answer as E1, though here the work really is done. |

### E0. The acceptance test of this whole draft

> The model says "done" without running any check. In the person's view of the task (the gate's task
> record, `soz-guard task status T1`), T1 is still open, and says why.

This is the first test to write, before any of the machinery above.

## 7. Cost to the person

The risk to this design is that checking it costs the person more than checking the work by hand. The
targets:

- items are approved in words, 2 to 5 per task, in under a minute;
- the person reads a test only in E3's case (a test that passes from the start), and then its steps and a
  screenshot, not its code;
- the person looks at what is `missing` or `unproven`, and at nothing that is `proven`;
- a small task (a question, a typo, a refactor with no user-visible change) has no items: soz-guard
  behaves as 0.4 does, and says plainly "no acceptance items: completion not verified".

## 8. Proving it is worth it: a pilot

Twenty real tasks, on the person's own project and two others, with the gate deciding in the background
while releases go out as they do today. Counted per task:

1. real gaps it caught that the existing tests passed, before a user found them;
2. correct deliveries it would have stopped for nothing;
3. the person's time spent on items and confirmations, against the time saved on checking and fixing.

## 9. Open decisions (for the person to make before building)

1. **Result format**: JUnit XML from the test runner (proposed: most runners write it, and it separates a
   failure from an error), or a small format of soz-guard's own.
2. **Where approvals live** without a server gate (a project with only the local hook): proposed, nowhere:
   tasks and acceptance need the gate; locally, soz-guard only reports.
3. **The delivery**: how the project builds its package. Built in 0.5.1, in the gate's own configuration
   rather than `.soz-guard.json`, so an agent's branch cannot change how its delivery is built: `gate install
   --build "<command>" --package <path>`. The gate builds once; the checks and task tests run against it
   (`$SOZ_GUARD_PACKAGE`; starting it is the tests' part); its digest is recorded with the verdict; the
   packages let in are kept, copied out with `gate package REV --to`, and a live copy compared with
   `--verify`. Not built: the gate starting the package itself, and evidence from the live URL.
4. **Who writes the tests**: the agent (proposed), with the person able to hold one out (a holdout test
   the agent never sees) for items that matter most.
5. **The name and place of the task record**: `acceptance/<task-id>.json` in the repository (proposed).
6. **A push that does not carry the task.** The gate judges the tasks a push carries: their file added or
   changed in it, or named in a commit message (`Task: T1`). By default a push that carries none is judged as
   any change. Built in 0.5.1, as the person's choice: `gate install --require-task` makes a protected branch
   take only pushes that carry a task, each `complete` on exactly the pushed commit (`unchecked` is not
   enough); one commit with no task goes in only when a person approves it, with a reason.
