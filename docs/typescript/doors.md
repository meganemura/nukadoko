# Bringing an existing suite in

The two doors through which an existing JavaScript suite comes into the
TypeScript engine: its cucumber-js step definitions, run as they are, and a
Playwright Test suite that shares its code with typed steps. Moving a suite
across step by step is [migration.md](migration.md) for the first door and
[migration-playwright-test.md](migration-playwright-test.md) for the second.
The Ruby engine has a compat door of its own, for a cucumber-ruby suite
([reference.md](../ruby/reference.md)), and no door from Playwright Test.

## Compat steps (the migration door)

An existing Cucumber and Playwright suite can adopt nukadoko by changing
one import:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

- Compat steps keep their existing pattern syntax and World (`this`). The
  nukadoko harness provides and manages `page` and `request`. Custom World
  classes use `setWorldConstructor` to extend the nukadoko base. A throw
  while that World is constructed fails that one scenario: stderr gets one
  setup line, the scenario record is failed and cites no step record, later
  scenarios in the run still execute, and the messages export is finalized.
  The API
  supports the commonly used subset: Given, When, Then, World, Before,
  After, and AfterStep. New demand determines when this subset grows.
- `Given`, `When`, and `Then` are three names for one registration
  operation. A keyword has no meaning during registration. As in Cucumber,
  the scenario position determines its meaning at run time. A pattern can
  be a plain cucumber-expression string or a RegExp. Compat strings do not
  require named captures because that rule belongs to typed steps. RegExp
  support admits legacy glue that uses regular expressions. Compat accepts
  both cucumber-js call forms: `Given(pattern, fn)` and
  `Given(pattern, { timeout }, fn)`. It applies the specified timeout and
  throws on an unknown option key. Discovery imports each file and assigns
  its registrations to that file. The pattern text identifies a compat
  step. `nuka steps` lists its kind, and `nuka describe` shows that it has
  no contract. `nuka do` refuses the compat step by name. Promotion to
  `defineStep` enables single-step execution.
- `defineParameterType` in compat code and `config.parameterTypes` use one
  registry. Moving a registration to the config does not change pattern
  matching, so a team can make this move early. A registration that sets
  `preferForRegexpMatch` is the exception (below). The config is their
  final location. A transformer's `this` is that scenario's World, the
  same object the step and its hooks run against. A Promise the
  transformer returns is awaited before the step runs. This holds for a
  string pattern and a RegExp pattern alike. `preferForRegexpMatch` on a
  compat registration picks the type for a RegExp group that several types
  match, as in cucumber-js. `config.parameterTypes` has no such key, so a
  registration that sets it stays in compat code while a RegExp step
  relies on it. Moved to config with the key, it is a config error; moved
  without it, a RegExp group that two types match fails again. Two types
  that prefer one regexp, or a type that prefers a built-in type's regexp
  such as `{int}`'s, are a `parameter-type-invalid` error.
- Execution supports two forms. Glue that starts its own Playwright
  continues to work, with no trace and no page log. A World subclass assigns that
  page and request with `this.page = ...` and `this.request = ...`, and
  the getter returns the assigned value ahead of anything `openPage()` or
  `openRequest()` stored. The assigned page gets no trace or screenshot;
  a request a step sends through the assigned request context is still a
  `node:http` or `node:https` line in http.jsonl (see docs/spec.md "Records"). `await
  this.openPage()` and `await this.openRequest()` return the measured
  page and request from the harness. With no assignment, reading
  `this.page` or `this.request` before the matching opener has resolved
  throws. Typed steps in a mixed scenario share the same context and
  cookies. Tables use a small, dependency-free `DataTable` with
  raw/rows/hashes/rowsHash/transpose. This preserves glue that calls
  `table.hashes()` after the import change. Docstrings remain plain strings.
  Before and After hooks support all three cucumber-js forms:
  `Before(fn)`, `Before({ tags }, fn)`, and `Before("@tag", fn)`. They
  also accept `{ name }` beside `tags` and `timeout`. The string is stored
  on the registration and, when it is non-empty, on that invocation's
  `hooks` entry. Allure fixture names, run summary rows, trace chunk
  titles, and hook failure messages use it as the title. It does not change
  which scenarios the hook runs for, its timeout, or its order. `AfterStep`
  does not accept `name`: cucumber-js step-hook options have no such field.
  They receive Cucumber's hook parameter. A hook can filter only on `@tag` or
  `not @tag`. More complex expressions fail explicitly to prevent a silent
  mismatch. Hooks appear in the scenario record's `hooks` array and do not
  create step records. Their network traffic remains outside all step
  boundaries. The http.jsonl lines remain scenario-wide and do not
  identify one hook invocation. Playwright traces
  use a narrower boundary. Each Before, After, or AfterStep invocation that
  uses `this.openPage()` gets a separate trace chunk and `actions` list in
  its `hooks` entry. The entry has `trace`, `actions`, and `truncated`, which
  use the shape of a step record (see docs/spec.md "Records"). Each chunk is separate
  from step chunks and sibling hook chunks. A hook has no fixture bag for
  `section` or `poll`, so its entry has no `sections` or `polls`. Only the
  `actions` read from the trace chunk are available. `AfterStep` supports
  the same three registration forms and tag filters. Before and After
  bracket a scenario, while AfterStep runs after each pickle step that
  executed. It does not run for a step skipped after an earlier failure
  because that step never began. This is also the rule for a hook whose tag
  does not match. Each `AfterStep` entry has `step_index`, the zero-based
  index of the executed step in that record's `steps` array. Allure and
  cucumber-messages preserve this index. The hook parameter's
  `result.status` uses the `TestStepResultStatus` strings from
  `@cucumber/messages`. `nukadoko/compat` re-exports the same enum as
  `Status`, so `result.status === Status.FAILED` imports and compares
  correctly. `After` and `AfterStep` also receive `result.duration`,
  cucumber's `Duration` (seconds and nanos) for the step whose outcome
  `result` describes, measured from that step's own start and finish.
  When that outcome is a failure, `result.message` is the failure text
  the executor already recorded, and `error` is the thrown value when
  the failure was a throw. `Before` receives neither `result` nor
  `error`. `error` is present on `After` and `AfterStep` even when the
  step passed, and the value is `undefined` then, because cucumber-js
  assigns the key whenever it assigns `result`. `AfterStep` also
  receives `pickleStep`, the pickle step that just ran, and
  `testStepId`, that step's step record id. The id is the same kind of
  stand-in `testCaseStartedId` already is: a real stable id the
  executor holds, not the id the cucumber-messages stream assigns
  later. `SKIPPED` matches in one place: the `After` hooks of a scenario
  a walk stopped, whose steps did not all run (see docs/spec.md "A walk with a
  person"). The other members, `PENDING`, `UNDEFINED`, and `AMBIGUOUS`,
  cannot match. Nukadoko has no corresponding concept for a hook result.
  Migrated glue never takes a branch that compares these values, and
  this behavior is not a compat gap. `BeforeAll` and `AfterAll`
  bracket the full run. They accept `{ timeout }` and `{ name }`. They
  reject `tags` and `on`. `on` would choose which process runs the hook,
  and nukadoko does not offer that choice. A non-empty `name` is the title
  in their failure messages. They have no World, and do not run
  when no scenario is selected. They report through the exit code because
  they do not belong to a scenario record. `setDefaultTimeout` sets the
  default for items without a specific timeout. A negative value means no
  timeout, matching cucumber-js: `setDefaultTimeout(-1)` and a step or hook
  `{ timeout: -1 }` turn the limit off, and zero still times out. If the
  glue does not call it, or calls it with a negative value, steps have no
  time limit. This avoids applying Cucumber's five-second limit to a slow
  suite only because the suite migrated.
- Nukadoko always measures the World. Each compat step record lists the
  World keys that the step read and wrote, in access order. This exposes
  data flow through `this.foo`. Measurement covers the bag's own data
  properties. By construction, it does not include `#private` state.
  `defineWorld({ key: zodSchema })` enables validation for individual keys.
  A write that fails its schema fails the step and does not appear as a
  write. `class MyWorld extends defineWorld({...})` adds a type to `this`.
  Cucumber reserves `attach`, `log`, `link`, and `parameters`. These keys
  cannot be measured or declared, and an overwrite causes an error.
  `parameters` is `worldParameters` from config, and the default is `{}`.
  `page` and `request` are harness getters, not bag fields. `defineWorld`
  refuses either name when the step file is imported. `nuka check` reports
  that refusal as `step-file-import-failed`, and `nuka run` stops with the
  same message. The message names the field. A subclass can still assign
  them. `await this.openPage()` and `await this.openRequest()` still return
  the harness objects.
- `this.attach` and `this.link` follow cucumber-js. `attach` takes a
  string, a `Buffer` or `Uint8Array`, or a readable stream. A media type
  that starts with `base64:` means the string is base64, and the file is
  the decoded bytes. The second argument is that media type, or
  `{ mediaType, fileName }`. `fileName`, when present, is the file written
  under the step record. A missing media type is `text/plain` for a string
  or a buffer. A stream returns a promise the step has to await, and a
  stream with no media type throws, because the bytes are not known until
  the stream ends and the type was never given. `link` takes one URL or
  several. Each argument is its own declared link, with no display name.
- The harness owns the browser and request objects. Therefore, compat steps
  get measured step records without code changes. These records contain the
  status, timing, trace, screenshots, and HTTP log.
- Compat steps lack typed contracts, a validated `result` in the step
  record, and single-step CLI execution. A team can add these properties
  one step at a time by promoting a frequently used step to `defineStep`.
- An audit measured the width of this door. It inspected the glue text of
  eight public cucumber-js suites without running them. At that time, none
  worked after only the import change. Fixes for the observed blockers have
  since brought two suites to a state where compat rejects none of their
  glue. [docs/typescript/migration.md](migration.md) lists the remaining requirements.
  The audit established a rule: unsupported compat behavior must fail
  during import or the first run. A migrating team can respond to an
  explicit failure, but it cannot see a silent behavior change. A silent
  change costs more trust than a missing feature costs time. Import
  failures and the findings below meet this rule. Some value-level
  differences remain. They do not fail, so [docs/typescript/migration.md](migration.md)
  "Known limits" lists each measured one.
- Explicit failures divide into static findings and failures that require
  step execution. `nuka check` reports only static findings.
  **`nuka check` can report these failures**: a step file that throws during
  import becomes a `step-file-import-failed` error. Causes include a value
  import that `nukadoko/compat` does not export, a CommonJS `require` in ESM
  glue, and a deep subpath import. A hook tag expression more complex than
  one `@tag` or `not @tag` becomes an
  `unsupported-hook-tag-expression` error. The file text establishes both
  failures before execution. Two additional findings describe the area
  that discovery scans:
  `step-file-unsupported-extension` reports a `.cjs` or `.cts` file under
  `featuresDir` (see docs/spec.md "Typed steps" for the import rule).
  `no-step-files-found` reports a scan that found no candidate files. Each
  finding identifies what discovery inspected, so that a reader can verify
  the finding; the `pattern-unbound` note names its scanned directories for
  the same reason.
  An `undefined-step` finding can also identify a missing pair of quotes.
  The finding applies when one registered pattern fits the same position and
  all its captures are `{...:string}` parameters. It names the step and
  pattern and gives the rewritten Gherkin line. It stays silent when two or
  more patterns can explain the line, because that choice belongs to the
  author.
  **`nuka check` can also report a done callback**, as
  `done-callback-arity`. A compat hook is over the limit when Before, After,
  or AfterStep declares two or more parameters, or when BeforeAll or AfterAll
  declares one or more. A matched compat step is over the limit when its
  function declares more parameters than the line's captures plus a table or
  docstring. That count is known from the function and the matched line, so
  the finding can only end one way. An unmatched step stays silent, because
  the capture count comes from the line that selected it.
  **Only `nuka run` can report these failures**: a step or hook returns
  `"pending"` or `"skipped"`. Those values depend on what the function does
  during execution. Import analysis cannot identify them. **The following case is not a gap**: esbuild removes a
  name that appears only in a type annotation or an unused import before
  nukadoko imports the file. The import does not occur at run time, and the
  glue runs as compiled. `tsc` still resolves the name against compat
  exports. A missing name is therefore a compile error. The audit found
  `IWorldOptions` and `ITestCaseHookParameter` in this category. Exporting
  them prevents a user typecheck failure even though `nuka` cannot observe
  that failure during a run.
- A permanent design rule applies to all migration work. A working compat
  asset must continue to work after a team adopts nukadoko or moves another
  asset to typed steps. A transition can place related definitions in two
  locations. Examples include parameter types in support code and the
  config, or a World bag beside typed results. Both locations must share one
  mechanism. `nuka check` must expose the split. Each migration step must
  preserve semantics so a team can make it early and safely. A team must
  also be able to restore the original import.
- [docs/typescript/migration.md](migration.md) gives a step-by-step procedure for an
  existing cucumber-js and Playwright suite. [docs/typescript/upgrading.md](upgrading.md)
  explains how to move an existing nukadoko project to a newer release.

## The second door: a Playwright Test suite

The first door serves a suite built on cucumber-js by changing an import.
A suite written directly for Playwright Test has no such import. Its tests
use `test("...", async ({ page }) => {...})`, with no glue layer to
redirect. This suite requires a different migration method.

[docs/typescript/migration-playwright-test.md](migration-playwright-test.md) gives the
step-by-step procedure for this door. `docs/typescript/migration.md` covers the first
door. The documents serve different readers because a Playwright Test suite
has no compat steps, World, or Cucumber hooks.

**Share the implementation.** Move an operation from a spec file to a plain
async function. The function accepts only Playwright objects. Both the spec
and a typed step's `run` call this function. Each runner loads only its own
files.

```
e2e/cart.spec.ts  ──▶  features/steps/lib/cart.ts  ◀──  features/steps/add-item.ts
   (Playwright)              (plain functions)               (nukadoko)
```

The arrows intentionally point one way. The Playwright suite does not
import nukadoko. After the move, it still depends only on Playwright and a
function in its repository. To reverse the compat migration, restore an
import. To reverse this migration, delete the feature files and steps. The
Playwright suite remains unchanged because its dependencies never include
nukadoko.

The shared API shape makes this arrangement work. `page`, `context`,
`request`, and `baseURL` are Playwright objects on both sides (see docs/spec.md "Context
API"). Both callers can use a function that accepts these objects. No
adapter, wrapper, or re-export is necessary.

Do not share anything above this API boundary. A spec must not call
`step.run(bag, args)` directly. Such a call works only while the step uses
Playwright fixture names. It fails when the step uses `call`, `section`,
`resultOf`, or `requireEnv`. These fixtures provide much of the value of a
typed step. A spec also cannot share the fixture map because of the typing
constraint described in "Fixtures."

Place the contract in the shared unit. A step's `args` and `returns` are
plain zod schemas. The function file can export them, and the step can
declare them:

```ts
// features/steps/lib/cart.ts
export const openCartReturns = z.object({ id: z.string() });
export async function openCart(request: APIRequestContext) { ... }

// features/steps/open-cart.ts
export default defineStep({ returns: openCartReturns, run: ({ request }) => openCart(request) });
```

The spec and step import one definition, which keeps their shapes aligned.
The shared file depends only on Playwright and zod, so the dependency
direction stays unchanged.

This migration opens both nukadoko paths. `nuka run` fixes a path in a
feature file, and `nuka do` runs each step alone. Operations that the
existing suite already trusts become the vocabulary that an agent uses for
exploration (see docs/spec.md "Single steps").

Both trees can exist in one repository. A team can put them side by side.
Alternatively, it can put `featuresDir` *inside* the directory that already
contains the specs. The second arrangement requires less movement when the
Playwright suite is the primary asset.

```
e2e/
  cart.spec.ts          <- Playwright finds this
  lib/cart.ts           <- shared, owned by neither runner
  nukadoko/             <- featuresDir
    cart.feature
    steps/add-item.ts   <- Playwright does not find this
```

Each runner loads only recognized files. Playwright collects files that
match its `testMatch`. A step file named after its step does not match.
Discovery imports each `.ts`, `.mts`, `.js`, or `.mjs` file under
`featuresDir`. A spec outside that directory is outside the discovery
area. These naming and placement rules do not conflict.

Nukadoko reports two incorrect arrangements explicitly.

Discovery imports a spec **inside** `featuresDir`. Playwright's `test()`
then refuses to run outside the Playwright runner, so the import fails.
`nuka check` identifies the file and includes the Playwright message.
`run` and `do` refuse execution as they do for other broken glue.

A step file **named like a spec** causes a different conflict. The file
basename defines the step name. Therefore, `open-cart.spec.ts` defines a
second step named `open-cart.spec` with the first step's pattern.
`nuka check` reports `ambiguous-step` and identifies both steps. The error
is one pattern that matches multiple steps. Rename the file to fix it.

In both arrangements, place the shared file outside `featuresDir`.
Discovery could import it without harm because the module defines no step.
However, its location shows that the existing suite owns it.

