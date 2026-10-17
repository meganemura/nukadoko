# Worked example: a stateful workflow

A finished project for a sign-up flow whose steps call the module under
test directly, built with nukadoko 0.16.1 on Node 24.22.0. Every output
block below is copied from a real run of that project. The rules it
follows are in `../scenario-rules.md`.

## The ticket

A registration issues a confirmation link, and sign-in works only after
the link is opened. An email can be registered once. A password shorter
than 8 characters is refused. A wrong password is refused with the same
message as an unknown email.

## The feature

`features/signup.feature`. Each refusal reason is the exact text the
ticket's owner agreed to; a reason the ticket did not give was asked for,
not read off the program.

```gherkin
Feature: sign-up

  Acceptance criteria (from the request):
  - A registration issues a confirmation link; sign-in works only after the link is opened
  - An email can be registered once
  - A password shorter than 8 characters is refused
  - A wrong password is refused with the same message as an unknown email

  Scenario: sign in after confirming
    Given a registration for "ada@example.com" with password "correct horse" is submitted
    And the confirmation link is opened
    When "ada@example.com" signs in with password "correct horse"
    Then the sign-in is accepted

  Scenario: sign in before confirming
    Given a registration for "ada@example.com" with password "correct horse" is submitted
    When "ada@example.com" signs in with password "correct horse"
    Then the sign-in is refused because "email not confirmed"

  Scenario: the same email twice
    Given a registration for "ada@example.com" with password "correct horse" is submitted
    When a registration for "ada@example.com" with password "other secret" is submitted
    Then the registration is refused because "email already registered"

  Scenario: a short password
    When a registration for "ada@example.com" with password "short" is submitted
    Then the registration is refused because "password shorter than 8 characters"

  Scenario: a wrong password after confirming
    Given a registration for "ada@example.com" with password "correct horse" is submitted
    And the confirmation link is opened
    When "ada@example.com" signs in with password "wrong horse"
    Then the sign-in is refused because "unknown email or wrong password"
```

## The steps and the fixture

- `store` (a config fixture, scoped per scenario): a new, empty user store.
- `register` (Given in four scenarios, When in two): submits a
  registration and returns `accepted`, `token`, and `reason`. It does not
  throw on a refusal, so a Then can claim the reason (S6, S10).
- `confirm` (Given): opens the link, reading `token` from `register`
  through `from`.
- `sign-in` (When): returns `accepted` and `reason`, and does not throw on
  a refusal.
- `sign-in-is-accepted`, `sign-in-is-refused`,
  `registration-is-refused` (Then): read the outcome through `from` and
  compare it with `node:assert/strict`, with both values in the message.

`features/steps/register.ts`:

```ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Submit a registration; returns the outcome, never throws on refusal",
  pattern: "a registration for {email:string} with password {password:string} is submitted",
  args: z.object({
    email: z.string().describe("The email registered"),
    password: z.string().describe("The password chosen"),
  }),
  returns: z.object({
    accepted: z.boolean().describe("Whether the registration was accepted"),
    token: z.string().nullable().describe("The confirmation token issued, when accepted"),
    reason: z.string().nullable().describe("Why it was refused, when refused"),
  }),
  run({ store }, { email, password }) {
    const r = store.register(email, password);
    return r.ok ? { accepted: true, token: r.token, reason: null } : { accepted: false, token: null, reason: r.reason };
  },
});
```

`features/steps/registration-is-refused.ts`:

```ts
import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
import register from "./register.ts";

export default defineStep({
  description: "The last registration was refused with exactly this reason",
  pattern: "the registration is refused because {expected:string}",
  args: z.object({
    expected: z.string().describe("The expected reason"),
    accepted: register.returns.shape.accepted,
    reason: register.returns.shape.reason,
  }),
  from: { accepted: [register, "accepted"], reason: [register, "reason"] },
  mutates: false,
  run({}, { expected, accepted, reason }) {
    assert.equal(accepted, false, `registration: expected refused because "${expected}", got accepted`);
    assert.equal(reason, expected, `reason: expected "${expected}", got "${reason}"`);
  },
});
```

## The commands, in order

```
$ npx nuka check
ok: no issues found
$ npx nuka run
...
scenario 3/5  features/signup.feature:20  the same email twice
  step 1/3  ok  0.0s  a registration for "ada@example.com" with password "correct horse" is submitted
  step 2/3  ok  0.0s  a registration for "ada@example.com" with password "other secret" is submitted
  step 3/3  ok  0.0s  the registration is refused because "email already registered"
...
5 scenarios: 5 passed, 0 failed  (0s)
```

In "the same email twice", `register` runs twice, and the Then reads the
second result. A probe with two registrations and then `When the
confirmation link is opened` showed which token `from` picked, read from
the step records:

```
register {"email":"a@example.com","password":"correct horse"} {"accepted":true,"token":"tok-1","reason":null}
register {"email":"b@example.com","password":"correct horse"} {"accepted":true,"token":"tok-2","reason":null}
confirm {"token":"tok-2"} {"email":"b@example.com"}
```

`nuka tend` reported one note, and it was not acted on:

```
$ npx nuka tend
scanned: features
bed: typed 6, compat 0, read-only 4
declared: describe 19/19
note	repeated-scenario-prefix	features/signup.feature	2 scenarios begin with the same 2 steps, which took 0 seconds across them, 11% of this run's summed scenario time. The shared steps: "a registration for "ada@example.com" with password "correct horse" is submitted", "the confirmation link is opened". "a registration for "ada@example.com" with password "correct horse" is submitted" does not declare mutates: false, so a later scenario may read what this opening writes: a "process"-scope fixture would share that state between scenarios. A Background keeps the shared steps in one place and still runs them for each scenario.
  do: No change is necessary. A Background can hold the shared steps. A process-scope fixture fits only an opening whose steps all declare mutates: false.
```

Four scenarios also share the registration line alone. The note names
the opening that covers the most step executions, and on a tie the
longer one: 2 scenarios of 2 steps against 4 of 1, so the two lines. It
names the same opening on every run, whatever the steps took.

Not every scenario of the file opens with these lines, so a
Background does not fit. Both lines write to the store the scenario then
reads, so a process-scope fixture does not fit either, as the note says
(S8).

## Decisions

| Date | Decision | Chosen | Why | Became |
| --- | --- | --- | --- | --- |
| 2026-10-16 | The same action as a Given in one scenario and the When in another | one step, `register` | the keyword says what the line does in this scenario | S10 |
| 2026-10-16 | A step that is refused: throw, or return the outcome | return `accepted` and `reason` | a thrown refusal leaves the Then nothing to read | S6 |
| 2026-10-16 | A refusal reason in the sentence, or a bare `is refused` | in the sentence | the ticket gives the message, and two refusals differ only by it | S6 |
| 2026-10-16 | `from` when the producer ran twice | the most recent result | measured with the probe above | Shapes: the same producer twice |
| 2026-10-16 | Two shared Given lines: Background, or repeat them | repeat | they are not shared by every scenario of the file | Shapes: Outline or scenarios |
| 2026-10-17 | Messages for an outcome that was not refused | name the expected reason and `got accepted` | the first line is all `nuka run` prints | S11 |
