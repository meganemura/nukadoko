# Before you say a change is done

Reading your own code is not the claim. The claim is a run of the tree
you have, or a named list of what no run judged.

## nuka verdict

`nuka verdict` answers from records alone whether the newest run that
ended speaks for the working tree you have, and it never starts a run.
Every run records that tree as one git tree id, `commit.working_tree` in
run.json: tracked files as they are on disk and untracked files
`.gitignore` does not leave out, with the state directory left out. A
commit does not move it; any other edit does.

- Exit 0: the newest run judged exactly this tree, ran whole files (no
  `:line`, `--tag`, or `--step`), and left no row `failed`, `unproven`, or
  `moved`.
- Exit 1: `run-missing`, `run-stale` (the tree moved after the run
  started), `run-partial`, or the run's own red findings, each with its
  `do:` line. Run again, or end by naming each criterion that stays
  unproven, failed, or not run, and why.

Run it last, after the run you will report and after any edit that
followed it. A `run-stale` after a run that changed nothing you did means
a step or the program writes a file git counts: leave that file out in
`.gitignore`, or every run will be stale.

## What a pass does not say

A pass is narrower than "done". It does not say the change has a
criterion of its own: a change no scenario touches passes while the old
ones still hold. Under `--base`, `criteria-unchanged` notes a run in which
no criterion is new or changed; without it, `run-without-base` notes that
no new criterion was proven against a base. Whether the change needed a
criterion is a question for the person, and a change of behaviour does.
It does not say which feature files the run named either. Outside git, or
before the first commit, there is no tree id: `working-tree-unknown` notes
it, and the verdict is the newest run's own.

## The change's intent

A pass does not say the change did only what it meant to either. Declare
that in `INTENT.md` at the repository's top, in the change's first commit,
before the code: one row per thing the change means to do differently,
`| Target | Observation | Before | After |`, where the observation is a
kind of execution event, and a row with Before and After empty says it
does not change (`docs/intent.md`). A refactor writes
`| | x_decision x_result | | |`. The person approves the rows; the run
compares them with what the program did. A `@tag` in the target only
narrows which scenarios a row covers: write the behavior as
`field<op>value` terms on the observed line (`x_input.plan=team`, with
the decision carrying its inputs), since a tool with no scenarios reports
a `@tag` row as `not_reached`. A value change that also changes the
count is two rows, one for the count and one for the value.

`nuka run --base` then reads the file when the base does not hold the same
text, and `run.json`'s `intent` lists each row's result: `as_intended`,
`not_happening`, or `not_reached` (no compared criterion is aimed at it).
`intent-unintended` names a criterion that did something no row and no
sentence declares, and `intent-not-happening` a row that did not happen
where its target aims; both fail the run, as `intent-unread` does when a
row or git cannot be read. Fix the code, or tell the person the intent
was wrong: a commit that changes the file after the first is a
change of intent, and the summary names it. Never widen a row to make a
difference you did not mean pass.

## Asking for it from a Claude Code host

`scripts/claude-code-verdict-hook.mjs` beside `SKILL.md` is an example
hook, and nothing installs it: the Agent Skills format has no hooks, so a
project that wants it names it in its own `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/nukadoko/skills/nukadoko/scripts/claude-code-verdict-hook.mjs\"" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/nukadoko/skills/nukadoko/scripts/claude-code-verdict-hook.mjs\"" }] }]
  }
}
```

On a prompt it keeps the tree id the turn started from, under the system
temp directory. On a stop it holds the turn once, with the open findings as
the reason, when the tree changed during the turn and `nuka verdict`
exits 1. A turn that changed nothing is not held, and the stop after a
hold goes through, so the agent can end by naming what stays unproven.
It runs the project's own `node_modules/.bin/nuka`, does nothing in a
project with no nukadoko config, and costs one `nuka verdict` (about
0.3 s) per prompt and per stop. The fields it reads and writes are Claude
Code's hook fields as of 2.1.317 (`hook_event_name`, `session_id`, `cwd`,
`stop_hook_active`; `decision: "block"` with `reason`); check them against
the version you run.
