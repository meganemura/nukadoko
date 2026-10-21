# Helpers, parts, and splitting a step

## Helper, part, or step?

Because a chained value can only come from a step, `from` pushes an
operation toward "one step, one responsibility," and that can leave a
scenario with a line that exists only to move a value from one step to the
next, never to record anything the feature's reader cares about (say, "And
the project's billing page is fetched"). A feature file is written for
someone who is not necessarily an engineer; a line like that is a cost to
that reader, not information.

Ask two questions, in order. Does the operation mean something to the
person reading the scenario, not to the code moving data between steps?

- Yes: make it a step. The run gains a step record for it, and the run
  summary a line.
- No: ask the second question.

After a failure, what should be knowable about it?

- Its inputs and its result, under a contract worth stating: make it a
  **part**. Define it with `defineStep` and no `pattern`, list it in the
  calling step's `parts`, and run it with `await call(thePart, {...})`.
  Destructure `call` in that step's `run`, not in a fixture: `nuka check`
  reports a fixture that names it.
  Its args and its result are validated exactly as a step's are, and the
  call is recorded under `calls` on the calling step's own step record.
- Nothing a schema would help with: write an ordinary function under
  `features/steps/lib/` and call it directly. What is given up is that
  helper's own entry in the record; the HTTP it performs is still counted
  in the calling step's `observed`, and the `section` fixture can still
  mark how far execution got while running it. A function that formats a
  payload or picks a fixture file belongs here. Making it a part would
  buy a schema to maintain and nothing else.
  A helper that runs the CLI under test calls `runCommand` from
  `nukadoko` instead of `spawnSync` or `execFileSync`: it returns
  `{ exitCode, signal, stdout, stderr, files }` without throwing on a nonzero
  exit, so a step that needs the command to succeed checks `exitCode`
  itself, and each process it starts is listed in the calling step's
  `observed.processes`, so a failure record shows the command, its working
  directory, its exit code, and the files it changed (`files`, also on the
  result, so "writes nothing" needs no hand-rolled diff). A secret the step holds itself and passes
  as an argument goes in `redact: { NAME: value }`, so the record shows
  `{{secret.NAME}}` instead of the value.

A part is a step, not a new kind of thing. That is what makes the split
below cost the feature file nothing.

## Splitting a step a second scenario needs half of

The original step keeps its pattern, its `args`, and its `returns`. Only
its body moves.

1. Move each half into its own file under `features/steps/`, defined with
   `defineStep`, with no `pattern`. Give each one the `args` and `returns`
   it actually demands, not the ones its current caller happens to have.
2. List them in the original step's `parts`, and replace the moved code
   with `await call(thatPart, {...})`.
3. Run `nuka check`. A part the caller did not list is refused at the
   call, and a step declaring `mutates: false` while listing a part that
   declares `mutates: true` is an error: the composite's own flag has to
   account for what it may call.
4. Run the original scenario. Its feature file did not change, so a
   reviewer who approved that sentence has nothing new to read.

`parts` takes the imported step objects themselves, never their names,
the same way `from` names its producer:

```ts
import openAccount from "./open-account.ts";
import sendWelcomeMail from "./send-welcome-mail.ts";

export default defineStep({
  // pattern, description, args and returns are exactly what they were
  pattern: "a customer {email:string} is onboarded on the {plan:string} plan",
  args: z.object({ email: z.string(), plan: z.string() }),
  returns: z.object({ accountId: z.string(), mailId: z.string() }),
  parts: [openAccount, sendWelcomeMail],
  async run({ call }, args) {
    const { accountId } = await call(openAccount, {
      email: args.email,
      plan: args.plan,
    });
    const { mailId } = await call(sendWelcomeMail, { email: args.email });
    return { accountId, mailId };
  },
});
```

Get each part right on its own before wiring the composite back together.
A part with no `pattern` is still vocabulary, so it runs alone like any
other step: `nuka do open-account --args '{"email":"ada@example.com",
"plan":"team"}'`.

When the second scenario wants to name one half as a line of its own,
give that part a `pattern`. It stays callable from the composite at the
same time, so both granularities exist at once and neither scenario is
rewritten for the other.

Fixtures follow the parts: a composite whose part destructures `page` gets
a browser even though the composite itself never names `page`. That is why
`parts` is declared rather than read out of the body, and why a `call` to
a step the caller did not list is refused instead of run.

A read-only environment refuses a `mutates: true` part before it runs,
whatever the composite declared about itself. Splitting a step never moves
a mutation out of that policy's reach.

Everything measured stays on the calling step. `observed`, `sections`,
`used`, `required_env`, the evidence directory, and the trace are the
composite's, and they count the parts' work inside their totals. A part
shares its caller's `ctx`. `from` is never consulted for a call: the
caller passes every key itself.

## Generalizing a step that is too concrete

A step can sit at the right granularity for its scenario and still
hardcode a value the next scenario needs to vary. Add the `args` key,
describe it, and capture it in the pattern. `nuka check` refuses the
mismatch either way round, a required key nothing fills or a capture no
args key accepts, so the refactor is judged before anything runs.

This refactor does change the sentence in the feature file, which the
split above does not. Treat it as needing the same agreement that sentence
had in the first place: the changed line shows up in the pull request's
diff, and a person reads it again before approving. Prefer it anyway
when the hardcoded value is one the feature's reader should have been able
to see. Reach for the split instead when what varies is not a value, but
which half of the step the next scenario wants.

Nothing upstream ever runs on nukadoko's own initiative. If a step's `from`
key names a producer that never appears in the scenario, that is a `nuka
check` / `nuka run` error to fix in the feature file, never something
nukadoko inserts quietly to make the run succeed. A feature that doesn't
name everything that ran stops being the record this whole loop exists to
leave.
