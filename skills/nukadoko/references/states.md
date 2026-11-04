# States a step requires, gives, and ends

Some steps need what an earlier line did rather than a value it returned:
a person signed in, a tab in the room, a book open on the page. `from`
cannot carry that, because nothing is returned. Declare it as a state, and
`nuka check` judges the order of the lines before any browser opens.

## Declaring one

```ts
requires: [["signed-in", "person"]],   // on the step that cannot work without it
gives: [["signed-in", "person"]],      // on the step that leaves it holding
ends: [["signed-in", "person"]],       // on the step that undoes it
```

The second element names the args key whose value tells holders apart, so
aki signed in says nothing about ben. A state one reader holds is the bare
name: `requires: ["book-open"]`. Write each state the same way in every
step, keyed everywhere or bare everywhere; `state-shape-mismatch` names
the steps that differ. A claim step may `requires`; it has no `gives` or
`ends`, because it changes nothing.

Three rules decide what to declare:

- `requires` is what the step's own `run` or `observe` cannot do its work
  without, whatever the program does: the button it clicks is not there,
  the tab does not exist. It is never a business rule a scenario breaks on
  purpose to see the program refuse. That scenario uses a step that
  requires nothing ("aki tries to open the settings page").
- `from` or `requires`: when `run` reads a value an earlier step returned,
  `from`; when it needs only that an earlier line did something,
  `requires`.
- `gives` covers what the step does through its parts and the fixtures it
  builds. A state every scenario starts with (a seeded account, a context
  fixture that loads a signed-in storage state) is not one a step
  requires: no line gives it.

## Composing a scenario with them

`nuka steps --json` and `nuka describe <step>` list each step's
`requires` with `given_by`, the steps with a pattern whose `gives` name
it: one of those lines goes before the line that requires it, for the
same holder. A line that ends a state needs the giving line again before
the next line that requires it.

## When `nuka check` reports `state-missing`

The finding is at the requiring line and says why it can only run without
the state: no step gives it (often a typo; the fix lists the names steps
give), no earlier line gives it to this holder (it names the lines that
gave it to someone else), or an earlier line ended it. Its `fix:` names
the line to paste and where. A later line that needs the same state for
the same holder is folded into it ("line 12 requires it too"): one line
settles both. When the fix also names an earlier step that "gives it
without saying so", read that step: if it does sign the person in, add the
state to its `gives` instead of adding a line.

`nuka run` refuses the scenario before any step runs, `--no-check`
included. Never satisfy the finding by deleting a `requires`: a step that
truly needs the state fails in the browser instead, minutes later.

The check stays silent where it cannot read what happened: after a compat
step or a line no step matches, when a compat Before or AfterStep hook or
a custom World applies, and after a composite whose parts give or end the
state while the composite says nothing (`parts.md`). Silence there is not
a pass; declare the composite's `gives` so the lines after it are judged.
