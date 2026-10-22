# nukadoko specification

> nukadoko, a living pickling bed for your Gherkin: typed steps, step records, and an agent-first CLI.

Status: M1 (engine core) implemented (`steps`/`describe`/`do`/`run`/
`check`/`init`/`scaffold`, environments, secrets). M2 (compat,
below) is implemented too (`nukadoko/compat`, typed World measurement, and
a migration guide). Both real-world gates have now been run: typed steps
drafted against real feature files, and the compat door audited against
real cucumber-js glue (below). Still 0.x; of M3+, the Allure results and the
messages stream are both implemented (rendered by `nuka report`), and so are both of M5's skills. Compat gap detection in `nuka check` (the
migration skill's own prerequisite) is implemented too (see "Compat steps"
and docs/migration.md's "The dashboard is `nuka check`"), closing out
M1-M5.

## What nukadoko is

nukadoko is an agent-first engine that runs Gherkin. Humans write and review
the durable artifacts: feature files and typed step definitions, reviewed
in a pull request beside the run summary CI posts there. Agents execute
those artifacts. The runtime supports an agent's
trial-and-error loop. Every step has a typed contract and can run alone from
the CLI. Every execution leaves a step record that the tool wrote, not the
agent. An agent with shell access can write any file, so it can forge this
record. The distinction is that nobody had to ask the agent to produce the
record (see "Out of scope").

Agent-first is a design constraint, not a slogan. An agent must complete the
whole loop without assistance. It discovers the vocabulary
(`nuka steps --json`), reads a contract (`nuka describe`, with schemas as JSON
Schema), and executes one step (`nuka do`, with a step record on stdout and a
meaningful exit code). It then reads the validated result and decides the next
call. If the vocabulary lacks an operation, the agent scaffolds and implements
a new step. A human reviews the PR. Every interface has a machine-readable
form (`--json`), while Allure provides rich reports for humans.

One consequence of that constraint directs how this tool grows.
End-to-end execution needs a browser, a real target, and minutes of time.
Unit tests do not have these costs. In practice, iteration speed depends on
how much of a scenario can be judged wrong **without running it**. For an
agent, this directly determines how quickly its loop of cheap commands can
correct its work. Each declaration in this spec helps pay that cost.
`pattern` and `args` let `check` reject a line before a browser opens.
`mutates` lets it question a Then. `from` lets it reject a scenario when the
step order can only fail. Expanding what `nuka check` can settle is therefore
a first-class goal, not a convenience. After each failed run, the standing
question is whether a check could have caught the failure first. Honesty sets
the limit. `check` only makes a claim when there is only one possible outcome,
because a check that guesses trains people to ignore reliable checks.
A scenario outline with no Examples row is one of those outcomes.
`compile()` either leaves the placeholder text in place or drops the
scenario, and neither result is a boundary that ran. `nuka check` reports
that as `outline-does-not-run`. The feature file keeps the rows. nukadoko
does not generate them, and it does not run a property test. A property
test of the decision stays in the project under test, on the function that
decides. The feature's Examples rows are the boundaries nukadoko itself runs.
Two shapes are warnings, not errors, because each can be what the author
meant. A scenario with a Given or a When of its own and no Then is
`scenario-without-then`: it passes whenever its steps run without an
error, so nothing in it checks an outcome. A Then in the Background
counts as the scenario's Then. A `*` line is neither a Then nor a Given,
and a scenario of only `*` lines is left alone, even under a Background
that holds a Given. An outline
with more than one Examples row and no `<column>` in its name is
`outline-rows-share-name`: every row runs under the same name, so the run
summary shows rows that cannot be told apart.

A nukadoko is the fermented rice-bran bed that turns cucumbers into pickles.
It is alive. Daily care makes it mature, while neglect makes it die. This tool
makes the same claim about step definitions. They are a living culture, not a
write-once test asset, and the agent tends them.

nukadoko deliberately owns as little as possible:

| Concern | Owner |
|---|---|
| Gherkin syntax (Background, Scenario Outline, tables, docstrings, tags) | `@cucumber/gherkin`: the official parser compiles features into flat "pickles" |
| Step pattern matching (`{string}`, `{int}`, custom parameter types) | `@cucumber/cucumber-expressions` |
| Pretty reports | Allure: nukadoko emits `allure-results`, never renders HTML |
| Approval of what-would-prove-what, and where it is recorded | the team's own process: a pull request review, CODEOWNERS, a change ticket, an audit log |
| **Typed step contracts** | **nukadoko** |
| **Execution and measurement (records)** | **nukadoko** |
| **Environments and secrets** | **nukadoko** |
| **Keyword semantics (Then must not mutate)** | **nukadoko** |
| **The run summary: the evidence of what ran, and which criteria and step files changed since the approved base, as far as its comparison reaches** | **nukadoko** |

## Problem

Two independent forms of rot meet here.

**BDD rot.** In Cucumber, patterns bind step definitions as glue to prose.
The glue library decays without a visible signal. Duplicate steps accumulate,
and undefined steps appear only at run time. Nothing defines the types that a
step consumes or produces. The report can only say "passed" because it has no
record of what was sent or received. Keywords are decoration. Cucumber
executes a Then exactly like a Given, so nothing prevents an assertion step
from mutating state.

**Agent rot.** When an AI agent improvises browser automation for acceptance
checks, it becomes both the executor and the result reporter. The structure
does not prevent the agent from reporting a plausible result without executing
anything. The improvised operations also leave no reviewable artifact.

nukadoko closes both gaps. The operation vocabulary is committed, typed, and
reviewed. The tool owns execution and measures what happened instead of
trusting a person's account.

## Artifacts

Everything nukadoko touches belongs to one of four kinds. The kind depends on
who writes it, whether it belongs in the repository, and its intended lifetime:

| Purpose | Artifact | Written by | Committed | Lifetime | Read by |
|---|---|---|---|---|---|
| Contract | `.feature`, step definitions, `nukadoko.config.ts` | a human | yes | permanent | humans, the engine |
| Measurement | `.nukadoko/runs/<run_id>/`, one directory per `nuka run` (`run.json`, the run's result; `summary.md`, its Markdown summary; `steps/<id>/`, each step record with its evidence; `scenarios/<id>/`, a scenario's own evidence, when it wrote any; `sources.json`, the feature text the run parsed; `exports`, which export files `nuka report` wrote of that run), and `.nukadoko/do/<id>/` (a `nuka do` step record) | the tool | no | the newest `retention.runs` runs; a `nuka do` record or an unfinished run, `retention.adHocDays` days | a person reviewing the run (its summary), `nuka report`, `nuka do --use`, `nuka tend` |
| Export | `.nukadoko/export/allure-results/`, and any other file `nuka report --out` writes under `.nukadoko/export/` | the tool | no | with the run it renders | other tools |

The table names files. The distinctions between its columns answer two
questions: "what happens if this is deleted" and "who gets to change it":

- **Export is disposable because it is derived.** Delete it, and
  `nuka report` renders it again from the run directory. It exists for readers outside nukadoko,
  such as Allure's CLI or a CI formatter. Nukadoko never reads it itself.
- **Only Contract is committed.** Contract is the promise that a human wrote
  and reviewed. Whether the promise ran green is in the run summary CI posts
  on the pull request (see "Review"), kept by the forge with the pull
  request rather than in the repository. Measurement is never committed. `nuka init`
  gitignores its state directory because the working record from one run says
  nothing about the next run.
- **Measurement has a lifetime, and `nuka run` enforces it.** The unit is
  a whole run directory: a run leaves with everything it measured, and
  nothing inside a kept run is removed on its own. At the end of every
  run, the newest `retention.runs` runs (default 20) are kept. A run that
  ended is a `runs/<run_id>/` with the `run.json` it wrote when it ended
  (see "Scenarios (the scripted path)"), dated by its `started_at`: the
  same rule `nuka tend` uses to name the newest run, so the two commands
  never disagree about which run that is. Every older run directory is
  removed whole, with the export files its own `runs/<run_id>/exports`
  lists and its messages stream. A `run.json` that cannot be read, or
  whose `started_at` does not parse, dates no run. A run that may still
  be writing is never ranked: a run in flight and a run that was killed
  have no `run.json` that reads as one, and nothing here removes what it
  cannot prove finished. Such a run directory falls to the age rule below,
  dated by its mtime. The run that applies retention is never removed by
  its own pass, even when newer runs ended first. A `nuka do` record
  (`do/<id>/`) and a run directory with no `run.json` are removed once
  they are older than `retention.adHocDays` (default 7). `nuka do --use`
  reads `do/` records across days by design, which is why they get days
  rather than a run count, and a `--use` on a record that aged out is
  refused with the policy in force, never answered with nothing. Neither
  number has an "off" value; a project that wants more history raises it.
  The defaults are a judgment: the heaviest suite measured so far costs
  about 50 MB per run, so 20 runs is about 1 GB, and fewer would lose the
  failure a person was chasing an hour ago on a suite that runs every few
  minutes. An export file
  is removed only through a run's own manifest, never by age: a results
  directory can be shared with another tool's Allure output, and a file
  nukadoko did not write is not nukadoko's to remove. A manifest line is
  followed only when it resolves, symlinks included, to a file inside
  `export/`, and a manifest only when it is a file of a run directory that
  is not itself a symlink: a run directory copied in from elsewhere does
  not get to name a project file for removal. The line must also name
  what `nuka report` could have written: a regular file, not a directory
  or a symlink, and never a file named `allure-history.jsonl`, in any
  case and under any directory alias. Retention skips
  any other line and goes on removing old runs.
  `nuka clean [--dry-run] [--json]` is the whole-category operation that
  remains. It cleans all three categories together. `--dry-run` prints the
  same plan that the real run would use, but removes nothing. A report
  `nuka report --out` wrote outside the state directory is the caller's
  file, and `clean` does not read or remove it. Under `export/`, `clean`
  removes the files a run's manifest names and the contents of
  `allure-results/`, and nothing else. `export/allure-history.jsonl` sits
  beside `allure-results/`, not inside it, so neither retention nor
  `clean` removes it. It is the only artifact here that a new run cannot
  reproduce.
- **Step records and run.json share one row.** They differ only in
  grain. A scenario's entry in `run.json` and each of its step records
  answer the same question at two resolutions, not two different questions.
  `nuka do` has no scenario or run to write, so it writes only a step
  record. The file split represents grain, not a second concept.

## Typed steps

nukadoko follows Cucumber's layout convention. Feature files and their support
code live together under `features/`. A migrating team can keep its mental
model and directory tree. Typed steps belong in `features/steps/`, with one
step per file: `features/steps/<name>.ts`. The file uses kebab-case, and its
name is the step name.

Discovery walks `featuresDir` for each `.ts`, `.mts`, `.js`, and `.mjs` file.
The step name omits the file's extension. At every depth, discovery skips
`node_modules` and dot-directories such as `.git`, `.nukadoko`, and `.vscode`.
It also excludes `.d.ts`, `.d.mts`, and `.d.cts` type declarations because
they are not step definitions.

Discovery and the `.feature` walk follow symbolic links, so a
monorepo can link shared steps or features into `featuresDir`. A walk enters
each directory once, so a link back up the tree does not loop and two links
to one directory do not list its files twice. A feature that
`featuresDir` or `additionalFeatureDirs` reach by more than one path
is read once, under the first path reached, because files are told apart by
their real path. A link whose target is missing stays in the walk: its import
or read fails, and that failure names the link.

Discovery identifies each `.cjs` and `.cts` file but never imports it. Both
extensions are CommonJS by definition, and nukadoko is ESM-only. See "Compat steps" below for the same CommonJS decision. `nuka check`
reports the file as `step-file-unsupported-extension`. This report prevents its
definitions from resurfacing as unexplained `undefined-step` findings.

Node loads the config and the step files itself, by type stripping: it
replaces each type annotation with spaces and runs what is left, so the
Node floor is the first release that does that without a flag (22.18 on the
22 line, 23.6 otherwise). Four rules follow from it.

- A step file imports another by its own file name, `.ts` included
  (`import createProject from "./create-project.ts"`). That is the spelling
  `nuka scaffold --from` writes and the one plain `node` resolves. When
  `tsconfig.json`, through its `extends` chain, sets neither option below
  to true, `scaffold --from` writes the `.js` name instead and says so in
  one `note:` line on stderr, so the file it writes passes the project's
  own `tsc` as it stands. A file in that chain that cannot be read (it
  does not parse, or an `extends` names no file) also leads to the `.js`
  name, and the `note:` names that file and why. `tsc`
  accepts the `.ts` name with `rewriteRelativeImportExtensions` or
  `allowImportingTsExtensions`; `nuka init` adds the first when
  `tsconfig.json` names neither. It follows `extends` to ask: a base
  file that names either option is the project's choice. When the
  options come only through `extends`, `init` writes no new
  `compilerOptions` and says on stderr that no file in the chain sets
  either option, or that it could not read one of them. The `.js` spelling TypeScript writes under
  `"module": "nodenext"` (`./create-project.js` for `create-project.ts`)
  still loads under `nuka`, which tries the `.ts` file when the `.js` one
  is absent, but a program run with plain `node` does not.
- Syntax with run-time behavior does not load: an `enum`, a `namespace`,
  and a constructor parameter property. `nuka check` reports the file as
  `step-file-import-failed` at the line Node names, with the rewrite to
  make. `"erasableSyntaxOnly": true` makes `tsc` report the same syntax.
  Node 23.x names no file in that report. When the step file itself fails
  to strip, the line is the one Node names, since Node strips a file
  before the files it imports. Otherwise the finding has no line and
  says the error is in a module the step file imports.
- A name imported without `type` stays an import after stripping, so
  importing a type that way fails with Node's "does not provide an export
  named" error. `import type` (or `"verbatimModuleSyntax": true`, which
  makes `tsc` require it) avoids that. When the name is a type that
  `nukadoko`, `nukadoko/compat`, or `nukadoko/matching`
  exports, such as `IWorldOptions`, the finding says to write
  `import type`. For any other module it cannot tell a type from a typo,
  so it adds nothing.
- A `package.json` with no `"type"` makes Node parse each `.ts` or `.js`
  file twice and print a `MODULE_TYPELESS_PACKAGE_JSON` warning on every
  load. The files still load, so `nuka tend` reports it, as
  `package-type-missing`, and names the `package.json` to add
  `"type": "module"` to.

Each discovery run loads its files in a module graph of its own, so a
process that discovers twice (a test, a config edited under a running process) runs
every file's top-level code again, and two runs never share a module.

A wide `featuresDir`, such as a repository root, widens the same walk. A build
artifact anywhere in that tree can become glue when its name has one of the
four supported extensions. `node_modules` and all dot-directories remain
excluded for every `featuresDir` setting.

A wider setting changes what `nuka check` does, not only what it finds.
Discovery imports every file that it walks. Thus, a module can read an
environment, open a connection, or write a file during an otherwise read-only
command. If `featuresDir` contains the application and the glue, discovery
executes the application's top-level code. A file a scenario runs as a
process, such as a fake server or a fixture script, belongs outside
`featuresDir` for the same reason: discovery would import it on every
`nuka check`, and a module that starts a child process or listens on a
socket at its top level would do so there.

```ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "a project {name:string} exists",  // named capture, see below
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,                               // default true; see keyword semantics
  async run({ request }, args) {
    const res = await request.post("/projects", { data: args });
    return res.json();
  },
});
```

- `pattern` binds the step to Gherkin text. `patterns: [...]` allows
  aliases; giving both concatenates them, `pattern` first. A step may omit
  patterns entirely: then it is CLI-only
  vocabulary for agents, invisible to feature files but importable by other
  steps: a typed building block, whose `args`/`returns` schemas keep the
  composition checked.
- Every parameter in a pattern is named: `{key:type}` binds that capture to
  the args key `key`. Matching strips the names and hands plain `{type}` to
  `@cucumber/cucumber-expressions`: the syntax owner is unchanged, names
  are a thin layer above it. Names are required (an unnamed `{string}` in a
  pattern is a `nuka check` error) because the alternative (binding
  captures to schema keys by declaration order) swaps two same-typed
  values silently when keys are reordered, and no static check can catch
  that. The binding must survive review by being visible in the pattern
  itself. Aliases must all bind the same key set. The same key captured
  twice in one pattern is an error. One args field holds one value, and
  keeping the last capture would drop the earlier one with nothing to
  show that it happened. `nuka check` reports that pattern and `nuka run`
  refuses the binding before the step body runs. Both name the key.
- A pattern's literal text is still cucumber-expressions syntax, not free
  prose: bare `(` `)` mean optional text and bare `/` means alternation, so
  literal occurrences must be escaped, as `\\(`, `\\)`, `\\/` in the
  `pattern` string literal (one backslash in the parsed expression means
  two in TS source), to match literally. Unlike a schema mismatch, an
  unescaped occurrence still compiles and the step registers, and the pattern
  then never matches the pickle text it was written for (hit independently in
  two corpora during validation). `nuka check` does not stay silent: a feature
  line that would match if the pattern were escaped is reported as
  `undefined-step`, with a hint that names the step and the escape. A bare `()`
  with no text inside is an error of its own, `pattern-syntax-error`. A pattern
  no feature line uses is not reported.
- A parameter cannot appear inside an optional group: an inherited
  cucumber-expressions constraint. The constraint binds the group syntax,
  not the parameter itself: a custom parameter type whose own regexp is
  optional (a `{dir:from-dir}` matching `( from '…')?` or nothing) is
  legal, and is the intended way to fold "the same step with a trailing
  location clause" into one definition: pair it with an `.optional()`
  args key. Without a custom type, each variant needs its own step
  definition.
- Aliases are for prose that is genuinely interchangeable at the args
  level: same keys, same `run()` behavior no matter which phrasing
  matched. If `run()` needs to know which variant matched (behavior forks
  on the phrasing itself), give each variant its own step even when their
  key sets coincide; folding them into one alias would hide that fork from
  reviewers.
- Plurals: a pure suffix plural (`message(s)`) uses cucumber-expressions'
  own optional text `(s)`, no alias needed. When the noun itself changes
  shape rather than just gaining a trailing `s`, use a `patterns` alias
  instead.
- The capture-stripping-and-matching pipeline above is also exported on its
  own, as `nukadoko/matching`'s `resolveStaticPattern`: given one pattern
  (`kind: "typed"` or `"compat"`, string or RegExp), it returns either a
  plain text-match predicate or a traceable `ok: false` reason, never a
  silent `false`. It calls the exact matching machinery `nuka run` already
  builds, not a second implementation, so a caller outside this package (an
  editor resolving which step a Gherkin line binds to, for instance) and
  `nuka run` itself can never disagree about what a pattern matches.
  Resolution uses built-in parameter types only: a workspace's own
  `config.parameterTypes` or compat `defineParameterType` calls need that
  workspace's code running to resolve, out of scope for a purely static
  caller.
- `args` / `returns` are zod schemas, validated at the run boundary (args
  before execution, returns after). A validation failure is a failed run; no
  result is stored. Captures are coerced by the parameter type (`{int}` →
  number, custom types by their transformer), then the schema is the
  contract; the mapping is statically checkable (`nuka check`) in both
  directions. A disagreement between the JS type of a built-in capture
  (`{int}`, `{float}`, `{double}`, `{byte}`, `{short}`, `{long}` give a number;
  `{word}`, `{string}`, the anonymous `{key:}`, and `{bigdecimal}` give a string;
  `{biginteger}` gives a bigint) and a number, string, boolean, or bigint
  schema is reported only when the schema does not coerce the captured value.
  A pipe or transform is read through its input side. A union, `z.any()`,
  a preprocess, and a custom parameter type are never reported. `z.coerce.number()` accepts
  a `{string}` and `z.coerce.string()` accepts an `{int}`, and whether
  that particular value parses is settled by the run, so the static check
  stays silent there. A capture with no schema key is an error. So is a **required**
  schema key that nothing on a given line could fill (no capture, no
  table/docstring, no `from`), because that line can only ever fail args
  validation. The second direction went unchecked for a while, on the
  reasoning that a key might be filled some way the tool could not see;
  `from` closed that gap by making the remaining way visible, so what is
  left is genuinely unfillable rather than merely unexplained. A table
  reaches its key as `string[][]` and a docstring as a `string`, so a table
  on a plain string key, or a docstring on an array, number, boolean, or
  object key, is reported as `table-docstring-key-mismatch`. An array key
  with a table, a coercing schema, a pipe, a transform, and a union stay
  silent.
- An args key that the pattern, a table/docstring, or `from` did not fill,
  and that the schema does not declare, follows the contract `nuka
  describe` publishes for that schema. `nuka describe` publishes each object `args`
  schema through `z.toJSONSchema`. A plain `z.object(...)` comes out as
  `additionalProperties: false`, and every path that turns a step's `args`
  into a validated value parses against that same closed shape (`nuka do`,
  `nuka run`, and the `call`
  fixture a part is invoked through, see "Parts"): an undeclared key is
  refused, not silently dropped. `nuka describe` renders that strict args
  schema as the input a caller must supply, so `required` names only keys
  the caller cannot omit: a key with `.default(...)` is absent from it.
  `returns` stays the output schema, where a defaulted key remains
  required, because the value the step produced always includes it. A
  schema that already says what an extra key is (`z.looseObject`,
  `.passthrough()`, or `.catchall(...)`) is published with that catchall,
  `additionalProperties` of `{}` or of the catchall's own schema, and
  those same paths leave the catchall in place. Forcing it closed would
  refuse a key the published contract allows. A key
  `from`/`--use` fills is never flagged, since either can only ever name a
  key the step itself declared. A successful record's own `args` is the
  validated value, so a key a schema's own `.default(...)` filled in shows
  up even when nothing on the line typed it; a failed record keeps exactly
  what was given, which is where a reader needs the raw thing most. A
  part's own `CallEntry.args` (see "Records") stays raw on both outcomes
  regardless: what changed here is what gets accepted, not what gets
  written down.
- A data table or docstring attached to the step binds to the one required
  args key that neither a named capture nor a `from` declaration speaks for
  (tables as `string[][]`, docstrings as `string`), validated by the schema
  like everything else. A step can therefore take one key from an earlier
  step and another from the attachment on the same line.
  Gherkin tables get types for the first time. Zero or several unconsumed
  required keys with an attachment present is a `check`/`run` error; no
  reserved key name exists.
- `from` declares where an args key's value comes from when the pattern
  did not capture it: `from: { projectId: [createProject, "id"] }` reads as
  "`projectId` is the `id` of whatever `createProject` returned earlier in
  this scenario". The executor fills the key in before args validation, so
  the key stays required and the schema keeps saying what the step actually
  demands. A key name, never a transform, and a key may list several
  mutually exclusive producers (see "Chaining steps" for why that limit is
  the point, for how alternatives are resolved, and for what to do when a
  key name is not enough).
- What `returns` carries decides what a failure can be diagnosed from, so
  "return what later steps cite" is the wrong rule to design it by. That
  rule drops every value this step's own correctness depends on but
  nothing downstream reads (the date it computed, the id it picked, the
  name it resolved before sending), and those are precisely the values a
  step record is interrogated for once a run has gone wrong. Returned, they
  are on the step record as validated facts and the question "what did it
  actually send" has an answer; withheld, the answer has to be
  reconstructed from an error message written by someone else's system.
  This is `observed` and `sections`' own measure-and-keep reasoning
  applied to the one field the step itself fills in.
- An observation that claims absence (`visible: false`, `count: 0`, an
  empty string) is ambiguous in exactly the way its presence-claiming
  counterpart is not: the target may genuinely not be there, or the page
  may simply not have finished rendering yet, and those two situations
  produce the identical value on the step record unless the step says
  otherwise. A step whose `returns` can carry absence should carry, beside
  it, whatever proves the read itself was valid: that the page had
  reached a state where absence was a real answer rather than a symptom of
  asking too soon. Without that, every hypothesis a reviewer could form
  from the step record is equally consistent with it, which is what
  unfalsifiable means in practice. Presence needs no such companion:
  `visible: true` is its own proof that the read landed on a rendered
  page, since neither a hidden nor an unrendered element can produce
  `true`. That asymmetry (a positive claim vouches for itself, a negative
  one does not) is the reason to treat the two differently rather than
  applying one convention to both. It bites hardest exactly where it looks
  irrelevant: an acceptance criterion phrased "hidden unless the condition
  holds" is satisfied by the same `false` an unrendered page also
  produces, so a scenario asserting it can go green while the page never
  finished loading: green for the wrong reason, indistinguishable from
  green for the right one without readiness evidence on the step record. A
  tool whose purpose is tying acceptance criteria to an execution that
  either happened or did not cannot treat that as a minor gap; it is the
  gap.
- `mutates` (default `true`): whether the step changes state anywhere it
  touches. Read-only steps declare `mutates: false`.
- `parts` (default `[]`) lists the steps this step's own `run` may call
  through the `call` fixture (see "Parts"). A step that calls none of
  them omits it, the same convention `from` follows.
- `returns` may be omitted. It then defaults to an empty object schema,
  and a `run` that returns nothing is recorded as `{}`. This fits a step
  with nothing a later step cites and nothing a failure would be diagnosed
  from: typically a Then step whose observed values already arrived as
  args through `from`. A step that observes something still returns it
  (see above). A `run` that returns an object with keys fails the step
  with `result_invalid`, whose message names the keys: the record would
  otherwise hold `{}` and the value would be lost while the step passed.
  A declared `returns` keeps its meaning: `run` returns the
  value that schema validates, and returning nothing fails the step with
  a message that says `run` returned nothing. A key whose value is a
  Promise adds that the call inside `run` needs an `await`.
- The `run` body is free TypeScript on the fixtures it destructured.
  Composition is importing another step module and calling its `run` with
  the same fixture bag. Shared helpers live in ordinary modules (e.g.
  `features/steps/lib/`).
- Semantic correctness (whether the implementation truthfully performs what
  the description and pattern claim) is guaranteed by PR review, not by the
  tool. Protect `steps/` with CODEOWNERS.

### Context API

A step's `run` takes a **fixture bag** in a plain destructuring pattern:
`run({ page, section }, args)`. Names use alphabetical order. The executor
builds only the fixtures that the step destructures. If the step names none of
`page`, `context`, and `pageAs`, the executor does not launch a browser for
that step.

The browser behavior is a consequence of the main design goal.
`run({ page }, args)` does not mean "give me the page." The object pattern is
a static declaration that `check` parses without calling `run`. It already
parses `pattern`, `args`, `returns`, and `from` without execution.

Thus, a step declares `page` when the author writes the file. The step does not
request it through an action at run time. `check` parses the source text of
`run`, and the executor builds fixtures from the same declaration. The static
check and execution therefore use one source of information.

`from` established this design for a step's output (see "Chaining steps"). A
static declaration controls execution instead of describing it later. The
fixture bag applies the same design to a resource.

Playwright fixtures use the same destructuring syntax, but this similarity did
not determine the design. For Playwright, the pattern tells its runner what to
construct. For nukadoko, the pattern first gives `check` a declaration. It
becomes a construction instruction as a consequence.

The fixture names:

- `page: Page`: a Playwright Page in a fresh browser context, built from
  `config.browserContext`. The configured baseURL is wired into the browser context, so
  `page.goto("/path")` resolves against it. The standard URL rule applies: a
  leading slash replaces baseURL's own path instead of appending to it.
  This behavior was measured with Playwright 1.61.1 and `baseURL:
  "https://demo.playwright.dev/todomvc/"`. `goto("/")` lands on
  `https://demo.playwright.dev/`, the host's own root. It does not land on
  the app under `/todomvc/`. Both `goto("./")` and the absolute
  `goto("/todomvc/")` land on `https://demo.playwright.dev/todomvc/#/`.
  A suite whose app lives under a path uses one of those two forms for its
  first navigation. It never uses a bare leading slash there. The browser
  launches when the step's own bag is built. It launches only when `page`
  or `context` (below) is one of the names the step destructured. It never
  launches earlier or for a step that names neither fixture.
- `context: BrowserContext`: the `BrowserContext` that `page` already belongs
  to (`page.context()`). It is never a second context. It lets a step open a
  second tab with `context.newPage()`. The step does not need the `browser`
  that the executor does not expose (below).
- `await pageAs(name, options?)`: the `Page` of a browser context of its
  own, named `name`, in the same browser as `page`. Its cookies and storage
  are its own, so two people in one scenario stay two people to an app
  that remembers a person by a cookie. `options` is Playwright's own
  `BrowserContextOptions` for that one context, such as
  `{ javaScriptEnabled: false }`, applied over `config.browserContext`.
  `baseURL` is wired in as for `page`; a `storageState` in
  `config.browserContext` is not, because the context is somebody else. The context opens on the first
  call for `name` in the scenario, and a later call returns the same page.
  A later call with other `options` throws `ContextOptionsConflictError`:
  Playwright fixes a context's options when it creates it, so the second
  set could only be ignored. The comparison reads the options as they were
  at the first call, and a key whose value is `undefined` counts as absent.
  A `name` is 1 to 64 lowercase letters, digits,
  and hyphens, starting with a letter or a digit, because it becomes part
  of file names; another name throws `InvalidContextNameError`. The context
  is `page.context()` of the page it returns. Destructuring `pageAs` launches
  nothing; the first call does. See "Several people in one scenario" below.
- `request: APIRequestContext`: a Playwright APIRequestContext built from
  `config.requestContext`. As with `page` above, `baseURL` is optional. A suite that
  calls only absolute URLs across multiple hosts has no single baseURL to
  state. Nukadoko does not force one into config only to satisfy this fixture.
  If `baseURL` is unset and a step passes a relative path, Playwright produces
  the failure. Nukadoko does not re-implement Playwright's URL resolution to
  prevent that failure first.
- `env`: read-only environment variables from the configured envFiles. The
  file format is under "Environments and secrets". This fixture
  enforces determinism: the process environment is never merged. It
  also enforces secrets redaction: only values that nukadoko loaded are
  redactable. It is not a convenience. The object a step receives is a
  frozen copy of that merged map. Assigning a property throws, so a write
  in one step is not visible to a later step or a later scenario. Reading
  a configured key still returns the loaded value.
- `requireEnv(name)`: returns the same value as `env[name]`. It provides the
  presence check that each step reading a required variable would otherwise
  write. It returns `string`, never `undefined`, because it throws when the
  value is missing. An empty string also counts as missing. An envFile line of
  `KEY=` parses to `""`, not to "key omitted." A step that declares the
  variable as required is equally broken in both cases. The error names only
  the key, never a value. A missing value gives it no value to show. A form
  that never carries values cannot later become a redaction gap. The error
  cannot identify which envFile to fix. This fixture sees only the merged
  result, never the `config.envFiles` list. `env` remains available for the
  rare step that needs every key at once. Every name passed to `requireEnv` is
  recorded in the step record's `required_env` (see "Records"). This happens
  whether the call finds a value or throws. The names use read order and are
  deduplicated. Reading the same value directly from `env` leaves no trace.
  That path is a plain object, so the library never sees the read.
- `baseURL`: the configured baseURL for the occasional URL assembled by hand.
  The common paths receive it as described above. It is `undefined` when
  `config.baseURL` is unset. This is valid for a suite that uses only absolute
  URLs. It is not an error state.
- `resultOf(stepModule)`: returns the validated result from that step's most
  recent successful execution in the current scenario. It returns `undefined`
  under `nuka do` or when the step has not succeeded yet. This is the scenario
  path's data channel. It is deliberately not a World. Nothing can write to
  it. Code can read only results that passed their `returns` schema. The
  dependency is a visible `import` of the other step module. That step's own
  schema types the dependency, and the diff exposes it for review. A feature
  line such as "that listing is closed" is implementable exactly when its
  referent produced a validated result. `from` (see "Chaining steps") is the
  declarative form of the same read. Use it first. `resultOf` remains for reads
  that a key name cannot express. Passing a `Step` that discovery never
  registered throws instead of returning `undefined`. See "Chaining steps"
  for the mistake that this rule catches.
- `await call(stepModule, args)`: runs one of this step's declared `parts` and
  returns its validated result (see "Parts"). The part's own `args` schema
  validates the args. Its `returns` schema validates the result. The call is
  recorded under `calls` on this step's own step record. A step that `parts`
  does not declare throws instead of running. A step that discovery never
  registered also throws instead of running.
- `section(label: string): void`: marks that execution reached a named stage.
  It is synchronous and has no return value. It has no matching "end" call.
  Every call is appended to the step record's `sections` in call order (see
  "Records"). A step that never calls it has no `sections` key. This is the
  same convention that `used` follows. It is intentionally a bare marker, not
  a function that wraps a block (`section(label, fn)`). A wrapper would have
  to define the meaning of nesting, an early `return`, and an `await` that
  crosses its boundary. Those definitions are not required for the question
  that this fixture answers. It records where execution stopped, not the
  shape of the block that stopped.
- `await poll(fn, { description, timeout, interval })`: the submit-poll-fetch
  loop for a requested state that does not exist yet. `fn` returns `undefined`
  until the state exists. `poll` returns the first defined value. If the
  `timeout` budget ends first, `poll` throws `PollTimeoutError`. The budget
  includes the attempt in flight, so that attempt ends when the budget ends,
  and a value that arrives later is not returned. `timeout` and `interval`
  must each be a finite number of milliseconds greater than zero. Omitting
  either one uses its default: 30000 for `timeout`, 500 for `interval`.
  `NaN`, `Infinity`, zero, or a negative number throws `InvalidPollOptionsError`
  before the first attempt. Every completed
  call is stored in the step record's `polls` (see "Records"). The record shows
  the attempt count, the wait duration, and the outcome. The value that `fn`
  polls for is a contract choice, not an implementation detail. It cannot be
  the observed target's own presence. A target whose correct passing state is
  absence would then be indistinguishable from one that has not rendered yet.
  Polling for presence would prevent `fn` from returning the answer that the
  step must give. Instead, poll for the condition that makes a verdict about
  the target possible. Examples include a loading flag becoming false, a
  count becoming defined, or anything the page always renders after its data
  arrives. Read the target only after that condition resolves. A direct browser
  wait through `page.waitForSelector` or `waitForLoadState` waits in the same
  way, but it leaves no record. Using `poll` adds `at`, `attempts`, `waited_ms`,
  and `outcome` to the step record. These fields provide the only way to
  distinguish "resolved on the first attempt, the wait did nothing" from
  "resolved four seconds in" after the event. This is the same boundary between
  self-reporting and measurement that the Allure results mark with their
  `declared:` prefix (see "Allure results"). Here, that boundary separates a
  wait that the tool measured from one that occurred invisibly in Playwright.
- `evidence.attach(name, body)` / `evidence.path(name)`: fills the one gap that
  the other fixtures do not cover. Every other fixture above returns something
  that the harness collects by itself. Previously, no fixture accepted
  application-specific evidence that only a step can produce. Examples include
  an API response body, a DB snapshot, and a generated file's contents.
  `attach` writes `body` (`string | Uint8Array`) into this execution's own
  evidence directory. It records the file in the step record's
  `evidence.attachments` (see "Records"). Two calls with the same `name` keep
  both files and never overwrite the first file. A `name` that differs only
  by case is the same name for this purpose, so the second call is suffixed
  the same way and the two cannot land on one file on a case-insensitive
  volume. `path` is Playwright's own
  `testInfo.outputPath()`. It allocates a collision-free absolute path under
  the same directory without writing anything. The step record lists only a
  path that a step wrote to before execution ended. A call to `path()` without
  a later write adds nothing. Both methods are on one object because they need
  the same information from the executor: the directory for this step's own
  evidence. A step needs one method about as often as it needs the other. A
  `name` that contains a path separator is refused. A `name` equal to `.`,
  `..`, or the empty string is also refused. A `name` of `record.json`,
  `final.png`, `trace.zip`, or `http.jsonl` is refused too, including a
  spelling that differs only by case (`ReservedEvidenceNameError`). Those
  are files the harness writes in that directory, and a step name that
  landed on one of them would replace it. Nukadoko never silently rewrites
  these names. A loud error at the call is better than letting a step trust a
  name that it did not request.
- `scratch.dir(prefix?)` / `scratch.copy(source)`: temporary directories a
  step can write into freely. `dir` creates an empty directory under the OS
  temporary directory and returns its absolute path; the name starts with
  `prefix` (default `nukadoko-scratch`), and a prefix that holds a path
  separator throws `InvalidScratchPrefixError`. `copy` copies `source` into a
  new directory and returns that directory: a directory's contents land at
  its top, a file lands in it under its own name. A relative `source`
  resolves against the project root. Every directory is removed when the
  scenario ends, whether it passed or failed (for `nuka do`, when the
  execution ends). The step
  record lists each one in `evidence.scratch` (see "Records"). Cleanup is
  the executor's job because only the executor knows when a scenario has
  ended; a step that removed its own directory would put cleanup into the
  scenario, and one that forgot would leak it.

Where a wait belongs is a contract question, not a convenience one. A step
that writes to a system whose effect lands elsewhere asynchronously is not
finished when the write is accepted; it is finished when the effect is
visible to whatever the next step will look at, and the wait belongs
inside that step, the same rule as "a contract says what the step
demands", read forward instead of backward. Putting it in a later step
instead appears to work, because that step waits and the scenario passes,
but the wait is then attached to a path rather than to the operation that
needed it: another scenario reaching the same state by a route that skips
that step waits for nothing and fails. What surfaces is one scenario going
red while its siblings stay green, which reads like a property of that
scenario and is not one. A green scenario is no evidence that its waits
are placed correctly, every wait it needed could have been supplied by
coincidence, further down. Only a route that does not pass through them
can show where they actually belong.

`page` and `request` hand back Playwright's own `Page` and
`APIRequestContext` rather than types of nukadoko's own. That is a choice
with a cost, and it is stated as one (see "Out of scope").

`expect` is not a fixture. A step imports it directly, `import { expect }
from "playwright/test"`. Whether a matcher asserts exactly as it would in
a Playwright test does not follow from what it is called on:
`toMatchAriaSnapshot` (a locator), `toHaveScreenshot` (`page`), and
`toMatchSnapshot` (a plain value) each throw `"<name>() must be called
during the test"` outside the runner (measured against Playwright 1.61.1),
the same three shapes `toBeVisible`, `toBe`, and `expect.poll` take
without incident. What decides it is whether the matcher reads or writes a
snapshot file keyed to the runner's current test, and a step has none.
This follows from the same rule every other fixture answers to: a
fixture carries only what the executor must inject, and `expect` needs
nothing the executor owns (assertion evidence already reaches the step
record through the trace, `actions`, see "Records"), so making it a fixture would
add a member with nothing behind it but Playwright's own already-public
export.

`browser` is not a fixture either, and this one is a refusal, not an
omission. `context` is a fixture (the one `page` already belongs to,
nothing new to launch), so a step that needs a second tab reaches for it
via `context.newPage()`. `browser` itself would let a step call
`browser.newContext()` and mint a context the executor never sees:
unmeasured, untraced, outside every step record the run writes. Leaving the
name out of the bag is what keeps that path always unreachable, rather
than a convention a step has to remember not to break.

#### Several people in one scenario

Some acceptance criteria have more than one person in them: a host and a guest, a buyer and a seller. Each acts
from a device of their own, and the app tells them apart by a cookie.
`context.newPage()` gives a second tab in the same cookie jar, so it cannot
play a second person. `pageAs(name)` is the measured way to a second
context. The executor opens it in the browser it launched and gives it
every subscription the default context has, so it records into the same
step records:

- request counts (`observed`) and http.jsonl lines, each line with
  `"as": "<name>"`;
- `page_events` entries, each with `as`;
- one trace chunk per step or hook that called `pageAs(name)`, written as
  `trace.<name>.zip` beside `trace.zip` and listed in
  `evidence.named_traces`; its `actions` join the default context's on one
  timeline, each with `as`;
- a final screenshot, `final.<name>.png`, in the scenario's
  `evidence.screenshots`, with `as`.

The contexts close when the scenario ends, after their screenshots, and
the browser closes after them. A chunk opens on a step's first call for
that name, the same lazy rule as `page`: a step that does not call
`pageAs("aki")` has no `trace.aki.zip`, even when aki's page is still open
from an earlier step.

Four other shapes were considered and refused.
`ctx.page({ as: "aki" })` changes `page` from a value into a function,
which breaks every step that destructures it, and a typed step has no
`ctx`. A `browser` fixture is refused above. A context per person declared
in `nukadoko.config.ts` puts the scenario's people into project
configuration, where a new person is a config change instead of a line in
the feature file. A project fixture that gives each person a host name of
their own (`aki.localhost`) in the one context works only for an app that
scopes its cookies to the host, needs a DevTools Protocol call per tab to
turn scripts off, and is a fixture that touches the app
(`fixture-touches-app`). `pageAs` takes a name at run time because the
people are the scenario's data, not something a destructuring pattern can
list; destructuring `pageAs` is still the static declaration that `check`
reads (`needs_browser`, `playwright-missing`).

`check` adds no finding for `pageAs` itself. The name is an argument in
the step body, which `check` does not read, so a wrong name is not
something it can know before the run. The run refuses it at the call.

Two shapes are refused outright rather than silently mis-parsed: a
destructured fixture with a default value (`{ page = ... }`) and one
collected through a rest property (`{ ...rest }`). Both defeat the same
static reading this section opened with: a default value corrupts the
name `check` would otherwise read cleanly, and a rest property's own bound
names are not knowable without actually running the destructuring, which
`check` must not do. Neither loses anything a fixture legitimately needs:
a fixture is always present once it is named, so a default value has
nothing to default from, and every fixture a step needs can always be
named explicitly. `check` and `nuka run`/`nuka do` share one judgment for
all of this (the same "one judgment, two callers" shape "Chaining steps"
already uses for `from`), so a step never passes `check` and then fails
this refusal at run time, or the reverse. An unknown fixture name, a
default value, or a rest property refuses execution before it begins, the
same "never began" outcome an undefined step already gets, never a step
failure.

An unknown name that is one of the step's own args keys gets the fix in
the same message: args are `run`'s second parameter, so a step that needs
no fixture writes `run({}, { sum })`. There is no one-parameter `run`
that takes args alone. `run({ page })` with one parameter already means a
step that needs `page` and no args, and TypeScript cannot type one
parameter position as either the fixture bag or the args.

That reading is exposed outside `check` too: `nuka steps --json` reports
each typed step's own destructured names as `needs` (alphabetized, `[]`
when the step needs none) and `needs_browser` (whether `page`, `context`,
or `pageAs` is one of them). An agent picking a scenario can therefore see which ones
never open a browser at all before running any of them; a browser-using
scenario costs minutes and a real target that an API-only one does not.
`needs` is `null`, not `[]`, for the one `run()` this same static reading
cannot parse (a default value, a rest property, a bare identifier where a
destructuring pattern belongs); `needs_error` on that entry carries why,
and `needs_browser` is absent alongside it, since a browser-need verdict
this file cannot derive is not one it states. That step's own
name/patterns/description still come through: one unreadable `run()` does
not take the rest of the listing down with it. The call's own top level is
the envelope every `--json` prints, with `steps` beside `findings`, not a
bare array of steps; a `step-file-import-failed` finding (with `file` and
`message`) names every step file whose own import failed, and `findings`
is `[]` when nothing did (see "Tolerant reporting, fail-fast execution"
below).

For the one un-migrated shape among those, `run(ctx, args)`'s own bare,
un-destructured first argument, the same call also reports `needs_inferred`: a
lexical guess at that step's fixture needs, read by scanning `run`'s own
source text for that argument's member accesses (`ctx.page`) and filtered
down to known fixture names. It is a field of its own, never merged into
`needs`: `needs` is read from a destructuring pattern and is what the
executor actually builds before a step runs, while `needs_inferred` is a
guess about a step that cannot run yet, and folding the two together would
state something as certain that this reading cannot back. `needs_browser` is
never inferred alongside it, the same absence `needs: null` already gets
above. The scan is not exhaustive on purpose: it never follows an alias
(`const c = ctx; c.page()` goes unseen), so a reader must take it as a
starting inventory, not a finished one. It is present only when the throw
carried an identifier to scan by at all; a default-value or rest-property
throw leaves nothing to key a scan on, so `needs_inferred` is simply omitted
for those, exactly as it is for a step with no error to infer from in the
first place.

A local variable that happens to share a name with a fixture shadows it,
and only one shape of that mistake is caught before anything runs:
declared directly in `run`'s own top-level body, it collides with the
destructured parameter itself, and esbuild refuses to transform the file
at all (`The symbol "page" has already been declared`). Declared inside a
nested block instead, an `if`, a loop, a callback, the same collision
loads without complaint: `tsc` sees an ordinary local binding, typed
consistently on its own terms, and has nothing to flag, and `check` parses
only `run`'s first-argument pattern, never the body behind it, so it has
nothing to read there either. What surfaces is only the moment execution
reaches the shadowed name, and it does not reliably fail even then:
Playwright deliberately mirrors method names like
`click`/`fill`/`hover`/`screenshot` across `Page` and `Locator`, so a
`page` shadowed by a `Locator` goes on answering to the same calls the
step would have made against the real one, and can silently act on a
different element instead of throwing. Receiving the fixture through the
destructuring pattern's own alias syntax avoids the collision entirely:
`run({ page: pwPage, section }, args)` leaves `page` free to bind to
anything inside a nested scope, because there is nothing left for it to
collide with. This changes nothing about the contract: `fixtureParameterNames`
reads the name to the left of the colon, so `{ page: pwPage, section }` and
`{ page, section }` both read as `["page", "section"]`, and `needs`,
`needs_browser`, and fixture resolution all follow from that same list.
nukadoko does not detect the shadowing itself today; nothing above should
be read as a claim that it does.

### Fixtures

The fixture bag in "Context API" is closed.
It contains only `page`, `context`, `pageAs`, `request`, `env`, `requireEnv`,
`baseURL`, `resultOf`, `call`, `section`, `poll`, `evidence`, and `scratch`.
`page`, `context`, and `request` are Playwright's own objects, `pageAs`
returns one, and `playwright` is an optional peer dependency of this package.
A project installs it only when a step or fixture uses one of the four.
The package is loaded when one of them is first built, never when a command
starts, so `nuka init`, `nuka check`, and a run with no such step work without it.
When it is missing, building the fixture fails the step with one line that
names the step and the command `npm install -D -E playwright@<version>`.
`nuka check` reports the same line first, as the error `playwright-missing`,
once for each step that a checked feature line binds and whose fixtures build
`page`, `context`, `pageAs`, or `request`, directly or through `config.fixtures`.
It resolves `playwright` the way the run loads it and builds nothing, so
`nuka run` stops before any step runs.
A step defined in a step file that no checked line binds is not reported.
A step file that imports `playwright`, `playwright-core`, or
`@playwright/test` itself does not import at all when that package is
missing. `nuka check` reports that file as `playwright-missing` too, in
place of `step-file-import-failed`, with the install line for the package
it imports and one message for every such file, so the text output prints
them as one group with one install line.
A step file that reaches the package through another project file (a
helper, or another step file) is reported the same way, with the same
install line; its message names the file that imports the package. An
import from inside `node_modules` keeps Node's own message, because an
installed package that cannot find its own dependency is a broken
install that this install line is not known to fix.
The commands that import step files without running the check
(`nuka run --no-check`, `nuka do`, `nuka steps`, and `nuka describe`)
report such a file with the same message, and `nuka run --no-check` and
`nuka do` name the install line as their `do:` line, a command a shell runs as written.
The type declarations follow the same rule: the three are typed as
Playwright's own types when `playwright` is installed and as `any` when it
is not, so a project's own `tsc` passes without it, `skipLibCheck: false`
included.
A step can also need a project resource, such as a tenant, a seeded database,
or an uploaded fixture file.
Previously, the step had no suitable place for the cleanup code.
Cleanup inside the step adds something that is not an acceptance condition to
the feature file.
Omitted cleanup leaks the resource.
`nukadoko.config.ts` provides the required place:

```ts
export default defineConfig({
  fixtures: {
    tenant: async ({ request }, use) => {
      const t = await createTenant(request);
      await use(t);
      await destroyTenant(request, t);
    },
    seededDb: [async ({}, use) => { await use(await seedDb()); }, { scope: "process" }],
  },
});
```

A fixture is a bare function or a `[function, options]` tuple.
Playwright fixture definitions use these two shapes too.
Therefore, `base.extend()` accepts an unchanged fixture when all its
dependencies are `page`, `context`, `request`, or `baseURL`.
This shared subset describes the definition shape only.
It is not a broader compatibility promise.
Playwright's runner does not understand a fixture that destructures `env`,
`section`, `poll`, `resultOf`, `call`, `evidence`, `scratch`, or another nukadoko-only name.
nukadoko also refuses `auto: true` and explains the reason in its message.
That option lets Playwright build a fixture that no consumer requested.
The feature file must name everything that ran, so nukadoko cannot build an
unrequested fixture.
This package claims only that it accepts the same definition shape.
It does not claim broader Playwright fixture compatibility.

Do not put one shared `fixtures.ts` behind both runners.
TypeScript applies contextual typing only to an inline object literal.
A fixture map in a plain `export const` loses that typing and fails under
`strict`.
For nukadoko, pass the same object literal through `defineFixtures` from the
`nukadoko` package.
TypeScript then treats the object literal as inline.
Both `request` and `use` get full types without manual annotations.
A dependency on another user-defined fixture still has the type `unknown`.
Its declared type would require self-referencing inference.
This package does not implement that inference because it only worked through
an undocumented compiler behavior during measurement.

A step that destructures a project fixture needs that fixture's type too.
A step's `run` receives `FixtureBag`, and a project adds a fixture to it by
augmenting `StepFixtures` in `nukadoko.config.ts`:

```ts
declare module "nukadoko" {
  interface StepFixtures {
    tenant: Tenant;
  }
}
```

`tsc` needs the augmentation.
Without it, a step that destructures `tenant` fails with
`Property 'tenant' does not exist on type 'FixtureBag'`.
`nuka check` does not need it, because it reads fixture names from the
source text.

A fixture destructures its first argument in the same way as a step.
`check` reads the fixture dependency names from the source text without
calling the fixture.
It reads step dependencies in the same way.
A fixture can name a builtin dependency: `page`, `context`, `pageAs`,
`request`, `env`, `requireEnv`, or `baseURL`.
A scenario fixture can also name `resultOf`, `section`, `poll`, `evidence`, or
`scratch`.
Those record on the step that caused the fixture to be built, and they do not
need the step boundary to exist yet.
`call` is not one of those names.
A fixture runs while its dependencies are built, which is before the step
boundary opens, and `call` reads that boundary.
A fixture that names `call` can only throw.
`check` reports it as `fixture-structural-violation`.
`nuka run` and `nuka do` refuse it before any step starts, the same way they
refuse an unknown fixture name.
A fixture can also name another `config.fixtures` entry.
Resolution follows Playwright's `extend()` model, so later layers can depend
on earlier layers.
Thus, a fixture can depend on another fixture, which can depend on a builtin.

A fixture can override a builtin.
For example, a `page` fixture can wrap the page that the executor launches:
(`page: async ({ page }, use) => { page.setDefaultTimeout(10_000); await
use(page); }`).
In this case, the dependency `page` refers to the underlying builtin.
It does not refer to the overriding fixture, so this dependency is not a cycle.
An override that destructures none of `page`, `context`, and `pageAs` cannot
return a page that the executor still owns and measures.
Therefore, `check` refuses it with `page-override-unowned`.

An override can also add a dependency.
`nuka init --server "<command>" --server-url <url>` writes a `server`
fixture that starts the program under test with `runServer` and a
`request` override that destructures the builtin `request` and `server`
and hands back the builtin unchanged.
Every step that destructures `request` then starts the server first, and
the feature still names what ran, through the steps it binds.
`runServer(command, args, { url, cwd, env, timeout })` is an import from
`nukadoko`, not a fixture, for the reason `runCommand` is one.
It runs the program with no shell and resolves to `{ url, stop() }` once
the URL's host and port accept a TCP connection.
Readiness is that observation and nothing else: a log line or an HTTP
probe would be a guess at what each program prints or which path answers.
It rejects when the port already accepts connections before the program
starts, since every request would then reach a server it did not start;
when the program exits first, naming its exit and its stderr; and when the
timeout passes (10 seconds by default), after it stops the program.
It does not tell the program a port: a `PORT` variable is a convention, so
the program listens at the URL by its own means.
`stop()` sends SIGTERM, then SIGKILL after 5 seconds.
On Windows the program is found and started the way `runCommand` starts
one, so a bare `npm` or a `.cmd` file works, and `stop()` ends the program
and every process it started with `taskkill /t /f`, since a signal there
ends only the process it names and the server `npm` started would keep
the port.
The generated fixture keeps the default `scenario` scope, the one that
never shares server state between scenarios; `{ scope: "process" }` is the
author's declaration that the server keeps none.

A project that already declares its own `scratch` fixture keeps it.
Its `config.fixtures` entry replaces the builtin at run time, as any
override does.
Its type wins too: a project types its own fixture by augmenting
`StepFixtures` (`declare module "nukadoko"`), and `scratch` is not a member
of that interface, so a declaration with a different shape still compiles.
A step's `run` receives `FixtureBag`: `StepFixtures`, plus each replaceable
builtin (`ReplaceableFixtures`, today only `scratch`) that the project did
not declare under the same name.

Two scopes exist.
The default `scenario` scope rebuilds a fixture for each scenario or each
`nuka do` execution.
It tears the fixture down at the end of that scenario or execution.
The `process` scope builds a fixture when a step first names it during a
`nuka run` invocation.
The step can name it directly or through another fixture.
nukadoko tears it down after every scenario in that process finishes.
At the default concurrency of 1, that process runs the whole invocation.

The `worker` scope does not exist because a worker is a process.
`nuka run --concurrency <n>` runs scenarios in `n` worker processes, so
`process` already names one worker.
Under `nuka do`, one execution contains both complete lifetimes.
Therefore, a `process` fixture behaves like a `scenario` fixture in that command.

A `process` fixture can depend only on other `process` fixtures and three
builtins: `env`, `requireEnv`, and `baseURL`.
The values of these builtins do not depend on a scenario context.
`fixture-scope-violation` refuses a dependency on `page`, `context`, `pageAs`, `request`,
`resultOf`, `call`, `section`, `poll`, `evidence`, `scratch`, or a `scenario` fixture.
A dependency on `call` is refused for every fixture, not only a `process` one,
because `call` needs the step boundary.
A `process` fixture can outlive the scenario that would supply any of these values.

`process` names one address space.
It does not name one `nuka run` invocation.
A fixture value is a plain JavaScript object and cannot cross into another process.
Thus, this scope always means "once per process."
A `nuka run --concurrency <n>` invocation uses `n` processes, so it builds the
fixture `n` times.
The two lifetimes coincide only at the default concurrency of 1.
Do not use a `process` fixture for an action that must occur exactly once in the world.
Examples include a database seed, a migration, or a mock server that owns a port.
Each additional process performs the action again.

Teardown uses the reverse build order, whether the step passes or fails.
A step failure does not make fixture cleanup optional.
SIGINT, SIGTERM, or SIGHUP during `nuka run` or `nuka do` does not make fixture cleanup optional either.
The process that built the fixtures tears down the scenario-scope cache, disposes the context, tears down the process-scope cache, and exits with 128 plus the signal number.
`use()` receives `"failed"`, because that invocation did not finish.
A second signal exits at once.
Under `nuka run --concurrency <n>` the parent forwards each signal to every worker.
On the first, each worker tears its fixtures down and exits, no further worker starts, and the parent prints the summary of what was written and exits with 128 plus the signal number.
On the second, each worker and the parent exit at once.
Each worker runs in its own process group, so a signal to the terminal's group reaches it only through the parent.
When the parent ends without forwarding (a SIGKILL, or a killed process group), each worker treats that as its first signal and tears its fixtures down.
When the parent ends after it forwarded a signal, each worker finishes the teardown that signal started.
A worker learns that the parent ended when its IPC channel closes.
Project code that calls `process.disconnect()` in a worker closes that channel too, so the worker says so on stderr and stops as if it had received a signal.
A worker's stdin is empty, so a step that reads it gets end of file at once.
On Windows the parent does not forward, because every process on the console already receives Ctrl-C.
This reverse order is correct because nukadoko builds and tears down fixtures
*serially* within one process.
The reverse order makes each dependency outlive its dependents.
`nuka run --concurrency <n>` keeps this rule.
Each worker is a process that runs its own scenarios in order, and a worker
never sees another worker's fixtures.
Therefore no scenario can tear down a dependency that another scenario still uses.
This rule is one reason nukadoko runs scenarios in worker processes rather than
concurrently inside one process.
Concurrency inside one process breaks the rule by timing, rather than by fixture
graph shape, and `check` cannot see timing.

Setup cannot know the outcome of the step that named the fixture.
For `process` scope, setup cannot know the outcome of the run.
Therefore, the fixture function does not receive the outcome as a second argument.
Instead, `use()` returns the outcome:

```ts
tenant: async ({ request }, use) => {
  const t = await createTenant(request);
  const outcome = await use(t);          // "passed" | "failed"
  if (outcome === "passed") await destroyTenant(request, t);
},
```

QA work commonly keeps a failed tenant for inspection and destroys a passed tenant.
Playwright's `afterEach` reads `testInfo.status` for the same reason.
A teardown failure does not change the step or scenario status.
A cleanup error cannot fail an otherwise successful run for a reason outside
its acceptance criteria.
However, nukadoko always reports the teardown failure.
A `scenario` fixture failure appears in the scenario record's `teardown_errors`.
A `process` fixture failure appears on stderr after all scenarios finish.
No single scenario record can contain that process-level failure.
`nuka run` and `nuka do` announce either type of failure, but the exit code stays unchanged.

A fixture must call `use(value)` exactly once.
If the function settles before this call, nukadoko throws an error that names the fixture.
If the function calls it twice, nukadoko throws an error at the second call and names the fixture.
These checks address a condition that did not exist for a built-in fixture such as `page`.
A fixture is a coroutine that nukadoko suspends at `use()` and resumes during teardown.
Without the first check, a fixture that never reaches `use()` could block the run forever.

Setup and teardown each receive a separate timeout budget.
`config.fixtureTimeout` sets the default budget to 60 seconds.

A typed step's own `run` has a deadline. `stepTimeout` in
`nukadoko.config.ts` sets it for the project, twenty minutes by default,
and `defineStep({ timeout })` overrides it for one step. Passing it is what
turns a step that never returns into a failed step with
`error.kind: "timeout"`, so the run continues to the next scenario and
reaches its summary. There is no value meaning "no limit": a step that
never returns takes the whole run with it, which is what this exists to
stop, and a run that never ends reports nothing at all. `nuka steps` and
`nuka describe` show a step's own `timeout` when it declares one.

`defineStep` refuses a `timeout` that is not a finite number of milliseconds
greater than 0 and at most 2147483647. Node's timer clamps a delay outside
that range to 1ms, so the step would be recorded as timed out for a deadline
it did not have. The same call refuses a definition that is not the shape
this section describes: `args` and `returns` must be zod schemas, `run` must
be a function, `pattern` must be a string, `patterns` must be an array of
strings, and every `parts` entry must be a step. A `.js` step file is not
type-checked. The throw happens while discovery imports the file, and
`nuka check` reports it as `step-file-import-failed`.

A key that is none of these options, such as `rationale`, which an earlier
release read, is not refused, because it changes nothing at run time.
`defineStep` keeps its name, and `nuka check` warns `step-option-ignored`
with the step file. `tsc` reports the same key as an excess property, but
only in a project whose `tsconfig.json` includes its step files.

The default is not a guess about how long a step should take. It is a
horizon past which a step that has not returned is taken to be stuck. It
sits far above what steps actually take: 800 step records sampled from a real
browser suite ran a median of 66ms and a maximum of 14s, none over 30s.

A compat step is deliberately not covered. It runs unbounded unless its own
glue declares a zero or positive `{ timeout }`, or calls `setDefaultTimeout`
with a zero or positive value, because adopting cucumber-js's own
five-second default would fail an existing suite's slow step purely from
switching (see "Compat steps"). A negative value means no timeout, matching
cucumber-js, which arms a timer only when the number is zero or greater.
`setDefaultTimeout(-1)` and a step or hook `{ timeout: -1 }` are how a suite
turns the limit off. Zero still times out. A typed step is not a migrating
asset, so that reasoning does not reach it.

A fixture can override it through `options.timeout`.
A timeout report names both the fixture and the phase.

A setup timeout still fails the scenario.
The fixture function keeps running after that.
If it calls `use()` later, the call resolves as `"failed"`, and the teardown
written after `use()` still runs, on the teardown budget.
That late teardown runs when `use()` is reached.
The timed-out setup produced no instance, so the reverse-order pass has
nothing to include for it.
A failure in that late teardown is written to stderr.
The scenario record may already be sealed, and stderr is the announcement
that still reaches the operator.
A teardown that finishes cleanly writes nothing.

`check` reports four fixture findings without running a fixture.
`fixture-cycle` identifies a dependency cycle among `config.fixtures` entries.
`fixture-scope-violation` identifies a `process` fixture that depends on a
`scenario` fixture.
`page-override-unowned` identifies the invalid `page` override described above.
`fixture-structural-violation` identifies a `config.fixtures` function whose
destructuring cannot be read, that names a fixture nukadoko does not know,
or that names `call`.
The finding names that fixture and uses fixture wording. It does not quote
the transformed source of a default value.

`tend` adds three factual reports.
`fixture-unused` identifies a `config.fixtures` entry that no typed step requires,
directly or through another fixture.
The entry can still be reached through `nuka do`.
`fixture-touches-app` identifies a fixture that reaches `page`, `context`, or
`pageAs`, directly or through another fixture.
A browser fixture can create an unnamed precondition that lets a scenario pass.
For example, it can log in a user before any step requests a login.
This has the same effect as work that a step's Given does not describe.
The report does not prohibit browser access from a fixture.
For example, a fixture can legitimately generate `storageState`.
`fixture-replaces-builtin` identifies a `config.fixtures` entry named
after a replaceable builtin (`scratch`), which replaces that builtin.
`nuka check` and the run accept such an entry, so nothing else tells a
project that wrote its own `scratch` before the builtin existed that the
builtin is there. The note names what the builtin gives; whether that
covers the project's own shape is the reader's call.
In `--json`, all three findings name the fixture in a `fixture` field and leave `step` unset,
so a fixture and a step of the same name stay apart.
`tend` only identifies the fixtures, so a reader decides whether each one belongs.

A step record contains `fixtures` only when the list is not empty.
The list contains every `config.fixtures` entry that fixture resolution touched
for that execution.
Each entry has `{ "name", "scope", "setup_ms"?, "at"?, "reused" }`.
`setup_ms` and `at` appear only when this call built the fixture instance.
Their absence on a `reused: true` entry means that the instance already existed.
This distinction separates reuse from a measured setup time of zero milliseconds.

In `nuka steps --json`, `needs` and `needs_browser` include transitive fixture
dependencies, as described in "Context API."
For example, a step can destructure only a fixture that reaches `page`.
Its `needs` array names only that fixture, but it still has `needs_browser: true`.
A step with `needs: null` has no dependency list to expand.
Therefore, that entry also has no `needs_browser`.
It can still contain `needs_inferred`, as described in "Context API."
That field is a lexical estimate, rather than a contract.
nukadoko does not expand `needs_inferred` through the fixture graph.

### Chaining steps

A CLI-only step has no `pattern` and runs independently.
Adding a `pattern` binds it to a scenario and introduces a new question.
The step needs a way to receive a value from an earlier step.

Reading every value through `resultOf` would remove the command-line argument.
The step could then lose its independent `nuka do` execution.
That execution makes the vocabulary useful to an agent.
A composite step would preserve the existing steps but hide their work behind one Given line.
The feature file would no longer show that work to a reviewer.

`from` preserves both properties by declaring the source of a key as data:

```ts
import { defineStep, z } from "nukadoko";
import createProject from "./create-project.ts";

export default defineStep({
  pattern: "the project is archived",
  description: "Archive the project created earlier in this scenario",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean() }),
  from: { projectId: [createProject, "id"] },
  async run({ request }, args) {
    // args.projectId is present or this line was never reached.
    const res = await request.post(`/projects/${args.projectId}/archive`);
    return res.json();
  },
});
```

A pattern capture has priority over `from`.
`from` supplies only the keys that this step occurrence did not capture.
Thus, one scenario can provide a value in the Gherkin line.
Another scenario can provide the same value from an earlier step.
`from` uses the most recent successful result from that step in the current scenario.
This result has the same lifetime as `resultOf` because both use the same chain.
nukadoko injects the value before it validates `args`.
Therefore, the key stays **required**, and `args` continues to describe the step requirement.
It does not describe how one caller supplies the value.

A key can name more than one possible producer.
For example, a scenario can create or import a project.
The consumer does not need two steps to support these sources:

```ts
from: { projectId: [[createProject, "id"], [importProject, "projectId"]] }
```

Alternative producers have no priority.
There is no first-match rule, declaration order, or cross-step recency rule.
Instead, the check requires **exactly one** listed producer earlier in the scenario.
Zero producers cause the existing missing-producer error.
Two or more producers also cause an error.
nukadoko refuses a scenario that would depend on a rule hidden from its reader.
The feature file identifies the producer for each occurrence.
The step does not supply a default producer.

Repeated occurrences of one producer follow a different rule.
If `Given a project is created` occurs twice before a consumer, the consumer uses the latest result.
Both occurrences have the same contract, so only result freshness differs.
Two different producers have different contracts and create a provenance choice.
Recency provides a suitable default for freshness, but not for provenance.

Alternative producers are mutually exclusive, so exactly one must run.
A scenario can instead exercise both producers and compare two paths to one record.
In that case, give each producer a separate key:

```ts
from: {
  createdId:  [createProject, "id"],
  importedId: [importProject, "id"],
}
```

Both keys bind and both values are read without competition.
If two producers run in one scenario, one consumer key cannot represent both values.
The consumer must declare two keys for the two values.

`from` uses a key name instead of a selector function because a name is data.
`nuka steps --json` and `nuka describe` both show it as `{ "projectId": { "step": "create-project", "key": "id" } }`.
An agent can use that data to assemble an order that it did not receive.
`nuka check` also uses the data to evaluate a scenario before execution.
A function could express more behavior, but the tool could report only the source step.
It could not report the selected part of that result.
This design requires a `returns` shape that a key can address.
That small cost also makes steps easier to read.

A `from` declaration enables a certain static check.
For each step occurrence, `nuka check` first checks whether the Gherkin line captures each declared key.
If the line does not capture a key, it checks for an earlier producer in the same pickle.
The pickle includes its Background steps.
`nuka run` performs the same check before it executes the scenario.
Thus, an omitted `nuka check` does not waste a browser session.

A **required** key without an earlier producer is an error.
The run would certainly fail `args` validation, so this check creates no false positive.
An earlier line that matches no step makes that verdict conditional, because the line may be the producer written with a typo.
`nuka check` then holds back each such finding behind the `undefined-step` finding for that line.
One `from-order-check-suppressed` warning per scenario names every consumer, key, and producer it holds back.
A held-back finding that still applies once the line matches a step is reported on the next check.
`nuka run --no-check` holds back the same findings, so the undefined line itself fails the scenario, and the steps after it are skipped.
An **optional** key without a producer causes no finding because the schema permits its absence.
A warning in that case would report a valid contract as a problem.
Two or more earlier producers cause an error for both required and optional keys.
An optional schema permits absence, but it does not select between multiple producers.
Before `from`, a consumer before its producer looked valid until browser execution exposed the error.

`from` and `resultOf` identify an upstream step by its `Step` object, rather than by name.
A step loaded through `await import()` is a different instance from the registered discovery instance.
Therefore, that object does not match the registered step.
Previously, `resultOf` returned `undefined` indefinitely for this mistake.
Now, an unregistered `Step` causes an error at the point where nukadoko finds it.
Because `from` declares the object statically, `nuka check` reports it.
`nuka run` and `nuka do` also refuse to execute that step.
Because `resultOf` selects the object at runtime, it throws at the call.
A registered step that has not run still returns `undefined`, which represents its current state.

Use `resultOf` when `from` cannot express the required read.
These cases include value reshaping, a runtime decision to read, and use of a complete result.
If the step must also run independently, keep the argument optional and add a fallback inside `run`.
This older form is now the exception.

`nuka do` has no scenario and therefore no chain.
A `from` key can arrive through `--args`, like any other argument.
It can also come from an earlier execution's step record through `--use` (see "Single steps").
Both paths use the same step contract and differ only in the value source.

`from` does not run the upstream step.
If the scenario lacks a producer, fix the feature file.
nukadoko cannot insert the producer because the feature must name everything that ran.
Otherwise, the feature would no longer provide the required execution record.

This rule can produce a scenario line that only transfers an identifier.
For example, `And the project's billing page is fetched` might have no value for the feature reader.
An operation without reader value should not be a step.
Place it in `features/steps/lib/` as an ordinary function when it has no contract.
Make it a part when it has a contract, as the next section explains.
For each case, the step author balances record detail against feature readability.

Chaining connects declaration and measurement differently from `mutates` (see "Keyword semantics").
For `mutates`, the HTTP method is only a proxy for write semantics.
Therefore, the tool records the declaration and measurement without reconciling them.
For chaining, nukadoko knows the exact step record that supplied a value.
`from` controls execution, so its declaration cannot differ from the executed source step.
Therefore, this case requires no reconciliation.
The `used` field in the step record does not check the declaration (see "Records").
The declaration identifies the source step when the author writes the file.
`used` identifies the specific source execution at runtime.

### Parts

A step uses the granularity at which a reader understands the scenario.
Other code rarely needs that same granularity for reuse. This mismatch
usually appears in one of two forms when a second scenario arrives. A
correct step can be too specific. Generalizing it adds an `args` key that
the pattern captures, and the contract checks already cover this change.
Alternatively, a step can perform two operations when the new scenario
needs only one. The required operation has no name, contract, or callable
interface.

Splitting the step and rewriting the first scenario would change an
agreed record. The people who decide the purpose of the software agreed
to that feature, and a reviewer may already have approved it. An
implementation refactor must preserve the agreed sentence.

A step may call another step instead. `parts` declares which ones, and
the `call` fixture runs one:

```ts
import { defineStep, z } from "nukadoko";
import createProject from "./parts/create-project.ts";
import inviteMember from "./parts/invite-member.ts";

export default defineStep({
  pattern: "a project named {string} has {string} as a member",
  description: "Create a project and invite one member into it",
  args: z.object({ name: z.string(), email: z.string() }),
  returns: z.object({ projectId: z.string(), memberId: z.string() }),
  parts: [createProject, inviteMember],
  async run({ call }, args) {
    const project = await call(createProject, { name: args.name });
    const member = await call(inviteMember, {
      projectId: project.id,
      email: args.email,
    });
    return { projectId: project.id, memberId: member.id };
  },
});
```

A part is not a second kind of unit. It is a `Step` that uses the same
`defineStep`, and another step makes it a part by declaring it. A part
that exists only for calls omits `pattern`. It remains part of the
existing CLI-only vocabulary. `nuka do create-project` runs it alone,
and `nuka steps` lists it. The part is therefore accessible and readable
before a scenario names it. Adding a `pattern` later binds the part to a
scenario line and preserves existing calls to it. The second scenario
can use the finer granularity without changing the first feature file.
Both granularities coexist.

`parts` must be declared because the executor builds the fixture bag
before it calls `run()`. The executor statically reads the names that the
first parameter destructures. A part destructures its names from the same
bag. Therefore, a caller needs `page` in its bag when one of its parts
uses `page`. The executor makes this decision before either function
runs. A parser that inspected `call` sites would have to guess the control
flow. It could miss a call inside a branch. A declaration makes the
answer data. A step needs its own fixture names and the fixture names of
all transitively declared parts. User-defined fixtures already close
their needs in the same way (see "Fixtures"). This rule has a visible
cost. A composite step opens a browser when any part uses `page`, even if
the run does not take the branch that calls that part. The rule prevents
a browser from opening partway through a step because of a decision that
was unavailable before execution.

As with `from`, a name is data. `nuka steps --json` and `nuka describe`
retain `parts`. An agent can see that one step contains two other steps
without opening a file. `nuka check` can inspect the same declaration
before execution. `call` refuses a step that `parts` does not declare.
It also refuses a step that discovery did not register. `resultOf`
already rejects the latter error. A second `await import()` creates an
object that the registered vocabulary cannot match. These checks keep
the declaration accurate.

The calling step records each call under `calls` in its own step record.
A call does not create a separate step record. The scenario record keeps
one `steps[]` entry for each feature line. A part adds detail below that
line, while the feature continues to name everything that ran. Each call
entry contains the part name, its args, its result, and its start and end
times. A failed entry also contains an error with the same classification
as a step record's `error`. The executor checks a part's `args` and
`returns` exactly as it checks any other step. Calls from one part to
another use the same nested structure.

A step may start several calls at once, for example
`await Promise.all([call(a, {}), call(b, {})])`. Each call is checked
against the `parts` of the step that made it, so a part that runs beside
another part is not mistaken for that part's caller. Concurrent calls from
one step appear as siblings under it, in the order they started and not
the order they finished. A call that a part starts nests under that part.

Measurements at the step boundary do not split. `observed`, `sections`,
`used`, `required_env`, the evidence directory, and the trace chunk
belong to the calling step. Their totals include work from all parts. A
part also shares its caller's `ctx`. The record describes one execution
in more detail. The single total prevents duplicate counts and includes
work that ran inside a part.

`call` does not consult `from`. The caller supplies every key, as
`nuka do` does. A chain belongs to a scenario, but a call does not. When
a part also runs as a scenario line, that occurrence uses its `from`.
One caller's inputs do not affect other callers.

`nuka check` reports two definite errors. First, a cycle in `parts` lets
a step reach itself. Such a cycle cannot produce a closed fixture bag or
a terminating run. Second, a step cannot declare `mutates: false` when a
declared part has `mutates: true`. `mutates` covers state changes anywhere
the step can reach, including its parts. This check keeps `then-mutates`
local. A `Then` line still reads one flag on one step because that flag
already accounts for all parts.

No check reports a declared part that the body never calls. `run` contains
the call, while the declaration names a `Step` object. It does not name
the identifier that the body binds to that object. A check would therefore
have to guess whether the names correspond. The body can also call a part
only in one branch. An unused `from` key is different because the feature
files contain enough information to decide it. `nuka tend` reports that
case. The available static data cannot decide whether a part is unused.

The contradiction check does not enforce the read-only policy. In a
read-only environment, `call` refuses a `mutates: true` part before it
runs. The caller's declaration does not change this refusal. The static
check finds the contradiction earlier and at lower cost. The run-time
refusal protects execution when no static check ran. Both controls trust
the part's declaration.

Choose among a helper, a part, and a step by extending the axis from
"Chaining steps." If an operation has meaning to a scenario reader, make
it a step. The scenario record then cites its step record. Otherwise,
consider what a failure record must show. Use a part when the operation
has a useful contract, useful inputs, and a useful result. Use an ordinary
function under `features/steps/lib/` when it has none of these. A helper
has no separate record entry. Its HTTP calls still contribute to the
calling step's `observed`, and `section` can show its execution progress.
A helper that runs a command-line program uses `runCommand` (see
"Records"), so each process it starts is listed in the calling step's
`observed.processes`.
For example, a function that formats a payload or selects a fixture file
usually has no useful contract or result to preserve. Making it a part
would add only a schema to maintain.

One alternative was rejected. A step file could use named exports for
several steps. This design would keep split operations beside the
composite step. However, a typed step's name is its file's basename. The CLI
cannot see a named export without importing its file. A separate file for each part keeps the step name equal to the file name
and adds one file.

### Keyword semantics

Gherkin keywords carry a fact because nukadoko trusts the **`mutates`
declaration**. The tool does not derive this fact again from execution or
override a conflicting declaration. Real suites require the following
layers. The same sentence can appear correctly in both Action and Outcome
positions. Suites often use `And` to chain actions after `Then`. A step
that wraps an arbitrary command cannot have one accurate `mutates` value
for every occurrence. Therefore, a per-step Boolean cannot describe a
per-occurrence fact:

- `mutates` states the step's **declared intent**. Its default is `true`,
  and read-only steps declare `false`.
- **During static analysis**, `nuka check` warns when a declared-mutating
  step is bound in Then position. It does not report an error. A person
  must review the conflict because the declaration alone cannot resolve it.
- **Read-only environments refuse a declared-mutating step before it
  runs.** This rule includes a part reached through `call` (see "Parts").
  This is the only place where the declaration gates execution.
- **At run time**, the step record stores what the execution did. It stores
  every network call that the tool observed through the `request` fixture,
  through `page.request` or `context.request`, or through the page. It
  counts non-GET/HEAD calls as observed writes beside the
  declared `mutates` value. This count does not decide Then position or a
  read-only environment's policy. Nukadoko trusts `mutates: false`
  regardless of the `observed` value.
- Gherkin classifies an `And` or `But` step with the pickle step type of
  the preceding primary keyword (Given, When, or Then). Gherkin's pickle
  compiler defines this behavior. Therefore, an action after `Then` gets
  the same Then-position observation as other steps in that position. The
  position does not gate the action.
- Measurement cannot decide this fact. Write detection uses the HTTP
  method and counts each non-GET/HEAD request as a write. The method is a
  proxy for write semantics. GraphQL, RPC-over-POST, and many vendor query
  APIs use POST for a semantically pure read. The external system defines
  whether a call changes server state. Nukadoko observes only the lower
  HTTP layer. Each protocol uses different data to distinguish reads from
  writes. Examples include a GraphQL body's `query` or `mutation`, an RPC
  method name, and a vendor path convention. A general mechanical rule
  cannot make this distinction. The count guarantees what a step sent. It
  does not guarantee that the server state changed.
- The record retains all measurements. `observed`, http.jsonl, and the
  Allure declared/observed table remain unchanged. A reader can therefore
  use them to disprove an incorrect declaration after execution. This
  boundary marks the end of the tool's authority over mutation semantics.
- Nukadoko does not perform that comparison. An operator can compare
  `mutates` and `observed` in the same step record without another artifact.
  However, `nuka run` and `nuka check` do not claim that the values conflict.
  Such a claim would treat the HTTP-method proxy as a settled fact. It would
  report every GraphQL read, RPC-over-POST read, or vendor POST read as a
  false positive. For the same reason, nukadoko does not enforce mutation
  semantics at run time. The run summary is the only place that writes
  this comparison (its "Declared vs observed" section, see "Records"). A
  person reviewing the pull request already reads and judges the run there.
  The summary can show the raw facts without turning them into a failure of
  any `nuka run` or `nuka check` invocation.
- Compat (untyped) steps have no `mutates` declaration (see "Compat steps (the
  migration door)"). The `then-compat-step` warning from `nuka check` identifies
  this coverage gap when a compat step is bound in Then position. It does
  not identify a mutation conflict. Run-time observation records the same
  counts as it does for any step, but those counts gate nothing.

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
  `preferForRegexpMatch` is the exception (below). `nuka tend` lists
  registrations that still come from support code (see "Tending"). The
  config is their final location. A transformer's `this` is that scenario's World, the
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
  continues to work without measurement. A World subclass assigns that
  page and request with `this.page = ...` and `this.request = ...`, and
  the getter returns the assigned value ahead of anything `openPage()` or
  `openRequest()` stored. That assignment is not measured. `await
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
  boundaries. The http.jsonl file and observed read/write totals remain
  scenario-wide and do not identify one hook invocation. Playwright traces
  use a narrower boundary. Each Before, After, or AfterStep invocation that
  uses `this.openPage()` gets a separate trace chunk and `actions` list in
  its `hooks` entry. The entry has `trace`, `actions`, and `truncated`, which
  use the shape of a step record (see "Records"). Each chunk is separate
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
  later. The other members, `PENDING`, `SKIPPED`, `UNDEFINED`, and
  `AMBIGUOUS`, cannot match. Nukadoko has no corresponding concept for a
  hook result. Migrated glue never takes a branch that compares these
  values, and this behavior is not a compat gap. `BeforeAll` and `AfterAll`
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
  glue. [docs/migration.md](migration.md) lists the remaining requirements.
  The audit established a rule: unsupported compat behavior must fail
  during import or the first run. A migrating team can respond to an
  explicit failure, but it cannot see a silent behavior change. A silent
  change costs more trust than a missing feature costs time. Import
  failures and the findings below meet this rule. Some value-level
  differences remain. They do not fail, so [docs/migration.md](migration.md)
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
  `featuresDir` (see "Typed steps" for the import rule).
  `no-step-files-found` reports a scan that found no candidate files. Each
  finding identifies what discovery inspected. The `scanned:` line from
  `nuka tend` uses the same rule so that a reader can verify the finding.
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
- [docs/migration.md](migration.md) gives a step-by-step procedure for an
  existing cucumber-js and Playwright suite. [docs/upgrading.md](upgrading.md)
  explains how to move an existing nukadoko project to a newer release.

## The second door: a Playwright Test suite

The first door serves a suite built on cucumber-js by changing an import.
A suite written directly for Playwright Test has no such import. Its tests
use `test("...", async ({ page }) => {...})`, with no glue layer to
redirect. This suite requires a different migration method.

[docs/migration-playwright-test.md](migration-playwright-test.md) gives the
step-by-step procedure for this door. `docs/migration.md` covers the first
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
`request`, and `baseURL` are Playwright objects on both sides (see "Context
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
exploration (see "Single steps").

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

## Running

### Scenarios (the scripted path)

```sh
nuka run [<feature[:line]|dir>...] [--no-check] [--env <name>]... [--concurrency <n>] [--repeat <n>] [--probe] [--since <git ref>] [--records] [--json]
```

`@cucumber/gherkin` compiles the file into flat, self-contained pickles.
The compiler merges Background, expands Scenario Outline, and attaches tables.
nukadoko matches each pickle step against the committed patterns, then executes
the steps in order. It writes one step record for each step that began, and
when the run ends, one `run.json` that holds every scenario: its feature
path, line, and name, and each step's line, text, status, and step record.

Before it executes anything, `nuka run` reports what `nuka check` would
report for the scenarios it selected, and when one of those findings is an
error it writes the errors to stderr, writes no record, and exits `1`. The
findings are the ones `nuka check` gives for the same targets:
every project-wide finding (config, bindings, each step's own declaration,
fixture definitions, a step file that fails to import), plus the
scenario-level findings for the scenarios this run executes. A `:line`
target narrows only the scenario-level part, so a run of one scenario is
not refused over a sibling scenario it does not execute. Warnings do not
stop a run and are not printed. `--no-check` skips the check, for a
deliberate run of a scenario `check` refuses; the run-time refusals
described below still apply. `nuka check` stays the separate command for a
gate that has to stay seconds long and for `additionalFeatureDirs`.

`nuka run` takes zero or more targets. With none, it runs `featuresDir`,
the directory `nuka check` walks by default (without
`additionalFeatureDirs`, which only `nuka check` and `nuka tend` read).
Each target can be a feature file, a
`file:line` selection, or a directory. A path ending in `.md` is refused
by name: nukadoko reads scenarios from `.feature` files only. A directory target is walked
recursively for `.feature` files. At every depth the walk skips
`node_modules` and any directory whose name starts with `.` (`.git`,
`.nukadoko`, `.vscode`, and the rest), the same directories step discovery
skips. The skip reports nothing: a `.feature` file inside one of those
directories is not checked and is not run. The selected files form one
deduplicated set, and a full-file selection includes any line selections for
that file. Files are told apart by their real path, so two targets that reach
one file by different paths, such as a linked directory and the directory it
points to, select it once, under the first path reached. All selected pickles belong to one invocation: one run_id, one
summary, one exit code, one messages stream, and one Allure results tree.
Files are visited in a fixed order, the repo-relative path
compared byte by byte rather than by locale, so which scenario ran in which
position stays stable across runs and a record or a report can be compared
against another one. `--concurrency` below keeps that visiting order and
gives up the position: the files are still handed out in it, and the
records land in the order the workers finish. `:line` on a directory is
refused: it selects one scenario inside a single file, and a directory
names no single file for it to select inside. A directory holding no
`.feature` file the walk can see is refused too, the same tone
`nuka check`'s own `no-step-files-found`
uses: it names exactly what it scanned, because a run that did nothing must
say so loudly rather than exit 0 having run nothing at all.

`--concurrency <n>` runs more than one feature file at a time. The default
is 1, and at 1 every other paragraph in this section describes what
happens.

nukadoko spreads the work across worker processes. The parent selects the
pickles, hands each worker whole feature files, and each worker executes
the files it was given with the same serial engine a `--concurrency 1` run
uses. The parent keeps the
run's identity throughout: one run_id, one stdout stream, one messages
stream, one Allure results tree, one summary, one exit code. A scenario
record therefore reads the same whether a worker produced it or a serial
run did, and the run summary still describes one run covering every line
of a feature.

The spec names worker processes because that choice decides what the flag
can promise, so swapping in threads or promises later would change the
promise too. A scenario spends its time in a browser, in an HTTP call, or
in the project's own JavaScript, and only the last of those blocks a
single event loop. Concurrency inside one process
would reach the first two and leave the third exactly as slow as it was,
and nukadoko cannot measure which of the three a suite it was handed is
made of. A flag that speeds up some suites and silently does nothing for
others is a promise the tool cannot keep. Separate processes reach all
three.

The unit of distribution is the feature file. Every scenario in one file
runs in one worker, in file order, so a Background and the scenarios after
it keep the relation they have at concurrency 1. Files are handed out in
the same fixed byte order they are walked in, so which worker gets which
file does not drift between runs. `--concurrency` above 1 therefore has
nothing to do for a target naming a single file, and `nuka run` says so
rather than starting workers that would sit idle.

A `@nukadoko:serial` tag on a `Feature:` line runs that file while no other
file runs. This is the declaration for a suite whose files share something
nukadoko cannot see: one test account, one row, one queue. A fixture's
scope can never answer this question, because a scope reaches only what
nukadoko itself builds; the feature file is where the answer belongs,
beside everything else it already names. The tag is read on the `Feature:`
line only. On a `Scenario:` it would do nothing at all, since the scenarios
inside one file already run in one worker, so `nuka check` reports it
(`serial-tag-on-scenario`) instead of letting it read as a rule that is in
force.
Gherkin tags are free text, so the namespace prevents this tag from
colliding with a suite's existing meaning for a short name.

`--repeat <n>` runs every selected scenario `n` times in this one
invocation: the whole selection once, then again, so a failure that depends
on what ran before it meets the same neighbours on every pass. Each
execution is its own entry in `run.json`'s `scenarios`, its `verdicts`
cell counts the executions and how many passed, and a scenario that failed at least once gets a `repeat`
line after the failed list, `<passed> of <n> passed`, with no verdict
attached: a scenario that fails every time is not flaky, and the count is
what a reader needs. The flag exists for a failure that reproduces one time
in several. Without it, the answer was a shell loop of `nuka run`, which
spreads the evidence over that many run ids, while the run summary and
`nuka tend` read one. In the messages stream each execution is its own
`testCase`, not a retry of one, so a formatter that lists test cases lists
every execution. In Allure, every execution in one environment carries the scenario's own
identity, so a report shows one test with the other executions as its
retries, which is where a scenario that sometimes fails is easiest to read.
The run summary's cell reads `<passed> of <n> passed`: green three times is
a different claim from green once, and a reviewer sees the count. `nuka
tend` counts a scenario
once however many times it ran. Under `--concurrency`, each worker repeats
its own files, so the unit of distribution stays the file: a target naming
one file still runs at 1, and running one scenario on several workers at
once is not what this flag does.

`--probe` measures whether a passed Then could have failed. Each step
that ran in a Then position (the Gherkin `Then`, and an `And` or `But`
after it), declared `mutates: false`, and bound at least one capture from
its pattern, or a table or docstring, runs again right after it passes, before its AfterStep hooks
and the next step, so the re-run sees the state the Then saw. It runs
alone, in the same scenario's ctx and fixtures, with the args it was bound
with and one capture changed: a string gets the suffix `-probe`, a number
+1, and a boolean is flipped. The changed args go through the step's args
schema as the first run's did. A capture of another type, or a number +1
does not change, is not probed, and neither is a compat step, which
declares no `mutates`. Each capture gets its own re-run, and a value
`from` filled is never changed. A table or docstring is often the whole
expected value of a Then, so it gets one re-run too, after the captures:
a docstring gets the suffix `-probe`, and a table changes only the last
cell of its last row, since its first row is often a header a step matches
on. Its `key` is the args key the docstring filled, or
`<key>[<row>][<column>]` for the table cell, with that cell's values as
`recorded` and `changed`. The When is not re-run, and a step whose
own observation shows a process or an HTTP write is not re-run either, so
a probe runs nothing the feature did not name a second time. A Then that
still passes is a `then-passed-with-changed-capture` note at the Then's
line, naming the step's sentence, the step, the key, and both values,
with the `nuka run <file>:<line> --probe` that measures it again. Only a
throw from the step's own `run` is the Then catching the change. A probe
that never reached that point is a `then-probe-not-measured` note with its
reason: the step wrote when it ran, or the probe's own re-run did (`wrote`; the
re-run's observation is read as the step's is, its outcome is not used,
and the step is not re-run for its other keys), the args schema refused the
changed value (`args-rejected`), a fixture failed (`setup-failed`), the
re-run timed out (`timeout`), or the returns schema refused what it
returned (`returns-rejected`). Under `--repeat`, the executions of one
scenario in one environment fold into one note per step, key, and reason, and a
note that held in only some of them ends with `in <k> of <n> executions`. It is a measurement, not a
verdict: a sentence like "at least {n}" can rightly pass with n+1, so the
note never changes a scenario's status or the exit code. A probe is not a
step: it writes no step record, has no entry in `steps`, and opens no
trace chunk. The scenario's `run.json` entry gets `probes`, one per
re-run, so a reader tells a Then the probe caught from one it never
probed. The probe answers one question nukadoko could not ask before: a
step's `run` is trusted as written, and the step the implementing agent
wrote for itself is the one most likely to check nothing. Under
`--concurrency` each worker probes its own scenarios, and under `--repeat`
every execution probes.

`--since <git ref>` says what moved in the criteria since a base a person
approved, such as the target branch of a pull request, as far as the
comparison below reaches. Before anything runs, the feature files the run
targets are compared with the commit the ref names. A directory target
also brings in every `.feature` file the commit holds under it, so a file
deleted since the ref has its criteria removed; a file target compares
that file only, and `since.compared` names the targets. A scenario's
criteria are what decides how it runs, read from the compiled scenario
rather than the file: every tag it carries (Feature, Rule, Scenario, and
Examples tags, since they choose hooks, serial runs, and selection), every
Background step of its feature and of its Rule, its own steps with their
effective keyword (an `And` or `But` takes the keyword it continues), their
text, their docstring's content and media type, and their data table's
cells, and for a Scenario Outline row the Examples header and that row.
Indentation, blank lines, comments, a docstring's delimiter, and the order
of other scenarios never count. The comparison is of that structure, so a
table cell that holds `|` is not two cells. A scenario is found at the ref
by its Rule and its name; an Examples row by its header and values. When a
name repeats, at the ref or now, the scenarios of that name are matched by
content first; one edited scenario among them is `changed`, and when
content cannot pair them one to one, each unpaired one is `ambiguous`,
with a `reason`, rather than matched by position. Each scenario's
`run.json` entry gets `criteria.changed_since`: `unchanged`, `changed`,
`new` (a renamed scenario, a row whose values changed, or a file the ref
lacks), `ambiguous`, or `unknown` (the file does not parse at the ref,
with a `reason`), with the current `lines` of every scenario that is not
unchanged and its `step_files`: the files that register the steps its
lines bound to, the files of the parts those steps declare, and the config
file when one of those steps needs a fixture it defines. What those files
import is not compared. `since` names the ref, its commit, the `compared`
targets, the `removed` criteria (each with its feature, Rule, scenario,
and the `lines` it had at the ref), and each step file's `change`:
`unchanged` or `changed` as `git diff` compares the file with the commit
(so line endings and filters apply), or `untracked` when the commit does
not hold it, read before the first scenario runs. The summary's "Criteria
since" section counts each kind, says what was compared, quotes every
scenario that is not unchanged and every removed criterion, and lists
under each changed step file every scenario that names it, unchanged ones
included, so whoever approves the change reads those lines and sees which
step files moved under the ones that did not. It reports only: no flag
turns a change into a failure, and the exit code is the run's. A ref that
names no commit is refused with `since-ref-unknown`, a project outside git
with `since-outside-git`, and any other git failure (git missing, or a
command that fails for a reason other than a file the commit does not
hold) with `since-git-failed`, before anything runs. Without the flag,
every scenario has `criteria: { changed_since: null }` and `since` is
`null`.

`--env` may repeat: `nuka run --env a --env b` is one run, with one
`run_id`, one `run.json`, one summary, and one exit code, that runs every
selected scenario once in each environment. `default` is a name `--env`
takes too, whether or not the config defines it: it is the environment a
run without `--env` uses (the top-level settings, or `environments.default`
when the config defines one) and the name `run.json` gives it, so
`--env default --env staging` runs both. The environments run one after
another in the order given, the whole selection in `a` and then the whole
selection in `b`, so two environments never share a target at once, and
each pass is the run it would have been alone: its own env files, secrets,
version probe, `baseURL`, and policy, its own BeforeAll and AfterAll, and
its own `"process"`-scope fixtures, torn down before the next environment
starts. An environment stays generic config: nukadoko has no notion of a
feature flag, and what differs between two environments is whatever their
env files and `baseURL` say. Each scenario entry carries its `environment`,
and `verdicts` holds one cell per scenario and environment, red when any
execution in it is red. The exit code is red when any cell is red. Naming
one environment twice is refused before anything runs, since its cells
could not be told apart. The other flags compose with it as follows.
`--repeat <n>` repeats inside each environment, so a cell holds `n`
executions. A `:line` target selects the scenarios, and each selected one
runs in every environment. Under `--concurrency`, each environment is a
pass of its own: its parallel phase and then its `@nukadoko:serial` files,
before the next environment's workers start. A signal stops the run before
the next environment starts. Retention counts runs, and a run over two
environments is one run directory. `nuka tend` reads the newest run, and
counts a scenario once however many environments it ran in. In the
messages stream each execution is its own `testCase`, as under `--repeat`.
In Allure the environment is part of a result's identity, so a scenario
that passed in one environment and failed in the other is two tests, not a
retry. With more than one environment, a finding and a `repeat` line name
the environment after the scenario, and the progress log opens each pass
with an `environment <name>` line.

A `"process"`-scope fixture is built once per worker, and a compat
`BeforeAll`/`AfterAll` runs once per worker, because a worker is a process.
The "Fixtures" section already defines `process` scope as once per address
space, and this flag is where that definition becomes visible. Something
that must happen exactly once in the world, a database seed or a mock
server that owns a port, belongs in neither of those places at any
concurrency.

Two things change above 1, both deliberately. stdout lands in completion
order rather than file order, since the parent writes each record the
moment a worker reports it. The per-step progress lines on stderr are held
until their own scenario finishes and are then written together, because
lines from several scenarios interleaved are lines nobody can read.
Neither changes what a record contains.

Every scenario starts with no browser
state, so a scenario never depends on what the one before it left, and any
concurrency gives the same answer. A scenario that needs login state gets
it from a fixture or a Given step its feature names.

`--concurrency` is a flag and never a config key. How many scenarios a
machine can run at once is a fact about that machine, and a committed
config file is the wrong place to keep it.

Each run uses two output channels for two readers. stdout is for scripts,
and it carries only what one asked for: under `--records`, NDJSON with one
scenario per line, each line the scenario's entry in `run.json`, written as
the scenario finishes, and under `--json`, the `run.json` document described
below. Without either flag, stdout stays empty, on a terminal or not.
`run.json` is on disk either way, and the `run` line names it.
A person and an agent both read stderr, and an agent's shell is
no terminal and reads stdout together with stderr, so a line of JSON per
scenario there by default would bury the progress lines. The same rule
holds under `--concurrency`. Text project code
writes through `console.log` or `process.stdout.write` is delivered on
stderr. That covers a step, a Before or After hook, a BeforeAll or
AfterAll, a fixture's setup and teardown, a World constructor, a step file
while it loads, and a step that keeps running after its timeout. A child
process that project code spawns with `stdio: "inherit"` writes to file
descriptor 1 directly, so its output still lands on stdout. The same split holds for `nuka do`,
whose stdout is the one step record, and for a worker process under
`--concurrency`, whose own stdout is the envelope stream the parent parses.
stderr contains the
output for a person who watches the run: a boundary before each pickle, one
line after each step, the paths written by the run, and a one-line summary.
A step's line names its outcome with the word a step record uses:
`passed`, `failed`, or `skipped`.
A failed step's line is followed by two indented lines: the first
line of its error message, without terminal color codes, and the path of
its step record (`<stateDir>/runs/<run_id>/steps/<id>`). When the message holds a
Playwright `expect(...)` line (its first line, or the line after the
message an `expect(value, message)` call was given), the lines after that
`expect(...)` line that say what was compared follow the first line: `Locator:`, `Expected:`, `Received:`, and an `Error:`
such as `element(s) not found`, at most four, each cut to 200 characters,
and none from the `Call log:`. The matcher's name alone does not tell a
wrong page from a wrong expectation; the two values do. A step that never began
has no step record and gets the error line only. Between the two, one more
line names each `used` entry whose `result` is a process that exited
nonzero: an object with a number `exitCode` other than 0 and a string
`stderr`, the shape `runCommand` returns. The line reads `used    <step>
exit <code>  <first line of stderr>`, in `used` order. When stderr is
empty, as it is for a program that prints a refusal under `--json`, the
line reads `stdout: ` and the first visible line of stdout instead; a
stdout that is JSON is shown compacted onto one line and cut at 200
characters, because a pretty-printed one starts with a bare `{`. With
nothing visible on either stream it reads `(no output)`. The error line and this line skip the header
Node writes before an uncaught error (the location it was thrown from,
that source line, and a line of carets) and take the first visible line
after it, such as `Error: Cannot find module '../dist/cli.js'`, so a
crashed Node program is named by its error. Text before the location and
a `: ` is kept. Any other text keeps its own first line. A first line that
ends in a colon, such as `init exited 1:`, only introduces what follows, so
it is joined to the next visible line once (`init exited 1: Error: ...`),
with the same header skipped there. It says why a Then step read an
empty stdout: the program it ran did not start, or failed, and the step
that ran it still passed, because an exit code is a result, not a failure.
The text comes from the step record, so a secret in it is already
redacted. After the
summary line, stderr prints each failed scenario as a finding,
`failed\tscenario-failed\t<feature>:<line>\t<name>: <first error line>`,
followed by a `  do:` line: `nuka run <feature>:<line>`, plus `--env <name>`
naming the environment the scenario ran in when the run was given `--env`,
quoted for a POSIX shell where a word needs
it. These lines appear for serial and concurrent runs. Under `--json`, stderr is empty: it carries none of the lines this
paragraph and the two above it name, nor the retention line, and the
document on stdout holds the result, since an
agent's shell reads both streams as one. A warning that something went
wrong (a file that was not written, a hook or a fixture teardown that
failed, the `nuka check` errors before a refusal) is a finding with its
code: on stderr in text, and in the envelope's `findings` under `--json`.

The run's result for a machine and for an auditor is
`runs/<run_id>/run.json`, written when the run ends, after its last
step record and its run summary, for serial and concurrent runs alike. It is
the `nuka run --json` envelope (see "The envelope"), so its
`schema_version` is the envelope's, and it holds everything a reader needs
to act on the run without opening another file:

```json
{
  "schema_version": 2,
  "nukadoko": "...",
  "command": "run",
  "verdict": "failed",
  "findings": [
    {
      "severity": "failed",
      "code": "scenario-failed",
      "file": "features/greet.feature",
      "line": 4,
      "message": "greets by name: text: expected \"Hi, Ada!\", got \"Hello, Ada!\"",
      "do": "nuka run features/greet.feature:4"
    }
  ],
  "run_id": "run-20260801-143022-a1b2",
  "run_dir": ".nukadoko/runs/run-20260801-143022-a1b2",
  "started_at": "...",
  "finished_at": "...",
  "commit": { "sha": "<40 hex characters>", "dirty": false },
  "environments": [{ "name": "default", "target_version": null, "base_url": "http://localhost:3000" }],
  "selection": "full",
  "counts": { "scenarios": 1, "passed": 0, "failed": 1 },
  "scenarios": [
    {
      "scenario_record_id": "scn-20260801-143023-c3d4",
      "feature": "features/greet.feature",
      "line": 4,
      "scenario": "greets by name",
      "environment": "default",
      "status": "failed",
      "started_at": "...",
      "finished_at": "...",
      "steps": [
        {
          "line": 5,
          "text": "I run greet with \"Ada\"",
          "step": "run-greet",
          "status": "passed",
          "step_record_id": "step-20260801-143023-e5f6",
          "record": "steps/step-20260801-143023-e5f6",
          "mutates": false,
          "observed": {
            "http_reads": null,
            "http_writes": null,
            "processes": [{ "command": ["node", "greet.js", "Ada"], "cwd": "...", "exit_code": 0, "duration_ms": 41 }]
          }
        },
        {
          "line": 6,
          "text": "the output says \"Hi, Ada!\"",
          "step": "output-says",
          "status": "failed",
          "step_record_id": "step-20260801-143023-g7h8",
          "record": "steps/step-20260801-143023-g7h8",
          "mutates": false,
          "observed": { "http_reads": null, "http_writes": null, "processes": null },
          "error": { "kind": "step_error", "message": "text: expected \"Hi, Ada!\", got \"Hello, Ada!\"" },
          "used": [
            {
              "step": "run-greet",
              "record": "steps/step-20260801-143023-e5f6",
              "result": { "exitCode": 0, "stdout": "Hello, Ada!\n", "stderr": "" }
            }
          ]
        }
      ],
      "hooks": [],
      "do": "nuka run features/greet.feature:4"
    }
  ],
  "verdicts": [
    {
      "feature": "features/greet.feature",
      "line": 4,
      "scenario": "greets by name",
      "environment": "default",
      "verdict": "failed",
      "executions": 1,
      "passed": 0
    }
  ]
}
```

- `commit` is the commit `HEAD` named when the run started, and `dirty`
  says whether the working tree then had a change `git status --porcelain`
  reports, an untracked file included. It is `null` outside a git
  repository or before the first commit. `environments` lists each
  environment the run targeted, in the order `--env` gave them (`default`
  without `--env`), with `target_version`, what that environment's version
  probe answered, `null` without one, and `base_url`, the `baseURL` it
  resolved to, `null` without one, so the run names the instance it
  judged and not only the commit. `base_url` is redacted like
  `target_version`; the summary's environment line names it too.
- `run_dir` is the run directory, relative to the project root with `/`
  separators, so a script passes it to `nuka report` without knowing the
  state directory's layout. The paths inside run.json stay relative to
  that directory.
- `selection` is `partial` when a `:line` target left out a scenario of its
  file, and `full` otherwise. A partial run is a debugging result, not
  what a reviewer should read as the feature passing (see "Review").
- `scenarios` has one entry per scenario execution, in the order each
  finished, with the `environment` it ran in. Each step has its `line` in the feature file, its `text`, the
  `step` it matched (`null` when none or more than one), and its `status`.
  A step that began has a `step_record_id` (the value `nuka do --use`
  takes) and a `record`, the step record's directory, with its `mutates`
  declaration and what it `observed`. A step whose step record could not
  be read back has `record_unreadable: true` in their place, a
  `step-record-unreadable` warning names the file, and the summary's
  "Declared vs observed" section counts it as not compared. A step that failed, or never began
  for a reason (`undefined`, `ambiguous`), has an `error` with the step
  record's `kind` (`null` when no step record says) and its first message.
  A failed step that read earlier results through `from` has `used`, each
  producer's step, record, and the result it read. A result whose JSON is
  over 4096 bytes is a preview instead, with `truncated: true` and
  `result_bytes`, the whole value's size: an object keeps its top-level
  numbers, booleans, and nulls and the first 1024 characters of each
  top-level string while they fit, so a process's `exitCode` and the start
  of its `stderr` stay, and the producer's `record` holds the whole value.
  Args and a step's own
  result stay in its step record: they can be large, and the next decision
  does not need them.
- A failed scenario has `do`, the command that runs it alone: the same
  command the `scenario-failed` finding's `do:` line prints. A scenario that
  wrote its own evidence (a final screenshot, a hook's trace or attachment)
  has `evidence`, its directory under the run's `scenarios/`. A scenario
  that wrote none has no `evidence`, and its empty directory is removed
  when the run ends.
- Under `--probe`, a scenario that had a Then to probe has `probes`: each
  re-run's `line`, `step`, `text` (the step's sentence), `key`, the
  `recorded` value, the `changed` one, and its `status`. `passed` is a Then
  that passed with the changed value too, and is the
  `then-passed-with-changed-capture` note in `findings`. `caught` is a
  Then whose `run` threw. `not-measured` carries a `reason` and a
  `message`, and is the `then-probe-not-measured` note. A probe has no
  step record.
- Every scenario has `criteria`. `changed_since` is `null` without
  `--since`; with it, `unchanged`, `changed`, `new`, `ambiguous`, or
  `unknown`, with a `reason` for the last two, the current `lines` of every
  scenario that is not unchanged, and the `step_files` it names. `since` is
  `null` without the flag; with it, the `ref`, its `commit`, the `compared`
  targets, the `removed` criteria, and each step file's `file` and its
  `change` (`unchanged`, `changed`, or `untracked`).
- `findings` holds every finding the run raised: each failed scenario, each
  probe note, and each warning (a file that was not written, a hook or a fixture teardown
  that failed, a version probe that threw), the same findings stderr prints
  in text.
- `verdicts` has one cell per selected scenario and environment, features
  by path, scenarios by line, and environments in the order given:
  `verdict` is `failed` when any execution in the cell failed, `executions`
  counts them (more than 1 under `--repeat`), and `passed` counts the ones
  that passed. A selected scenario that never ran in an environment, such
  as after that environment's BeforeAll failed, has a cell with `verdict`
  `not-run` and 0 executions. It is the table the run summary draws.
- `counts` holds `scenarios`, `passed`, and `failed`, which count
  executions, and `not_run`, which counts the `not-run` cells.
- A BeforeAll or AfterAll failure is a `hook-failed` finding that names
  its environment, with a `do` that runs the same targets in it.
- `verdict` is the exit code's: it also counts a BeforeAll or AfterAll
  failure that no scenario carries, so it can be `failed` while
  `counts.failed` is 0.

Every path in `run.json` (a step's `record`, a `used` entry's `record`, a
scenario's `evidence.dir`) is relative to the run directory, the one that
holds `run.json` itself, so a run directory uploaded from CI and
downloaded somewhere else reads the same. The paths line on stderr names
the file as `run`, relative to the project root. A run that selects no scenario writes no record and no
`run.json`. A run that was killed has none either, which is how retention
tells it from a run that ended. There is no scenario record file: a
scenario's entry in `run.json` is its record.

`--json` prints that same document on stdout as the one JSON document there,
byte for byte the file, instead of the scenario lines `--records` prints, so
a script reads the whole result with one parse. It also prints for a run
that selected no scenario, with empty `scenarios`. A refusal before anything
runs prints nothing on stdout, as without `--json`. stderr is unchanged.

The paths lines name what the run wrote: its step records and its run
summary. `nuka report` names the paths it writes the same way, after the
run (see "Allure results" and "Messages stream").

A scenario's own `browser` field in `run.json` (`{ "type": "firefox", "version":
"133.0" }`) names the engine and version this particular run actually
launched, read from the real `Browser` object Playwright returns, never
from `config.browserType`. The two can disagree (a step can override the
`page` fixture with a browser this run's own `ctx` never launched), and only
the measured one is trustworthy enough to record. It is absent, not set to
some default, for a run whose pickle never launched a browser at all: a
pickle whose steps never destructure `page`, `context`, or `pageAs` opens none, and this
field never names a browser that never ran.

`:12` selects one scenario, which is the iteration path: a feature's full
run costs every scenario's minutes, and getting one of them right is
usually what the next few runs are about. It is not a smaller version of
the same thing: its run summary covers only the scenarios it selected, so a
green one is a debugging result and nothing else, not what a reviewer
should read as the feature passing (see "Review"). `run.json` and the run
summary say so with `selection: partial` when the line number is given and
selects fewer scenarios than the file holds. A line that selects every
scenario of its file, as in a one-scenario feature, already gave the full
run, so `selection` is `full`.

Steps in one pickle share one context (the World semantics Cucumber users
expect): a Background that logs in hands its browser and cookies to every
later step. A failed step skips the rest of the scenario, and skipped steps
get no step record (an execution that never began must not be citable; the
scenario's entry in `run.json` is what says "skipped"). Evidence follows its natural scope:
each step's record carries that step's own http.jsonl and its own
Playwright trace alike. The trace used to span the whole shared context and
live in the scenario's own directory instead, one file, opened once at the
first step whose bag named `page` and closed once at the end. It is cut at
every step boundary now, the same laziness a step's own fixture bag
already has: a step that never destructures `page` gets no trace chunk at
all, and a step that does gets one holding only what it did. Opening the
trace for the step that actually failed is faster than scrubbing through a
whole scenario's recording for the moment things went wrong, and that is
the entire reason for the change. What a single scenario-long trace also
gave for free, a network view spanning every step at once, a step-scoped
trace does not: each step's own trace still shows that step's own
requests, so nothing about a single step's traffic is lost, only the
ability to browse every request the whole scenario made without opening
more than one file. `request` fixture traffic and the page's own traffic
now share that same step-scoped view
instead: both land on the same http.jsonl, each entry marked `via:
"request"` or `via: "page"` so a reader never has to guess which path a
call took. A call through `page.request` or `context.request` is `via:
"request"` as well: that object is Playwright's APIRequestContext on the
page and its browser context, the same kind of call as the `request`
fixture, and it does not emit the page's `request` event. Only a page's
`document`/XHR/`fetch` requests are recorded as `via: "page"` (a single
page load can pull in dozens of images, a stylesheet, and a
script bundle, and a file trying to hold all of that would stop being
something a reader opens), but nothing about the drop is silent: what got
left out lands on the step record itself, by resource type, as `http_omitted`
(see "Records"). `observed` is untouched by any of this: it keeps counting
every request the page makes, image and script traffic included, because it
answers a different question than http.jsonl does, and the two counts are
not expected to match.

Before a pickle runs, its steps' `from` declarations are checked against
its own step order: a required chained key whose producer is absent or
bound later fails that scenario before anything launches, since executing
it could only end in the same failure minutes later (see "Chaining
steps"). Other scenarios in the file still run: this is one scenario's
property, not the file's.

An undefined step fails the scenario naming the text that failed to match
and suggests `nuka scaffold`. An agent following the bundled skill authors
the missing typed step and submits it as a PR: the feature backlog drives
vocabulary growth.

### Single steps (the agent path)

```sh
nuka do create-project --args '{"name":"acme"}' [--env <name>]
nuka do archive-project --use step-20260801-143022-a1b2
```

Executes one typed step and prints its step record to stdout (exit 0 on ok, 1 on
failed). Text the step, its fixtures, or a step file writes through
`console.log` or `process.stdout.write` is delivered on stderr, so that
record stays one JSON value. This is the adaptive loop: the agent
reads the validated result and decides the next call. The agent can only choose which step to call with
which args; it cannot choose what gets recorded. There is deliberately no
grouping label on `do`: ad-hoc sequences are working records, not evidence.
Anything worth attesting to is expressed as a scenario and proven by
`nuka run` (see Self-healing).

`--use <step-record-id>` (repeatable) supplies the step's `from` keys from an
earlier execution instead of the chain a scenario would have provided (see
"Chaining steps"). The upstream step's name is not written on the command
line because the step record already carries it: nukadoko reads which step
that record belongs to, finds the `from` entries pointing at it, and takes
the named keys out of its stored `result`. A step record for a step this
one does not declare a `from` on is an error rather than a silent no-op, as
is a step record whose execution failed: a failed step never produced a
validated result to read. `--args` still wins over `--use` for the same
key, the same way a pattern capture wins inside a scenario. The id is
looked up under `do/` first and then in each run's `steps/`, so a step
record from a `nuka do` call and one from a `nuka run` both resolve. The
record ids actually drawn from land in this execution's own `used`, so a chain
assembled by hand across several `do` calls is as traceable afterwards as
one a scenario drove.

What crosses with `--use` is the value itself, not a guarantee that
whatever it names is still there: a path an upstream step returned can
point at a resource a fixture owns, and that fixture may already have torn
down by the time a later `--use` call reads the path back, since one
execution is the whole of a fixture's scope under `do` (see "Fixtures").
Whether a returned value names something a fixture will tear down is not
visible from the schema or from the step's own code, so this is not a
mistake `check` can catch before the run does.

A step that passes under `do` has not thereby been shown to pass under
`run`. `do` gives every execution its own browser and its own everything
else; a scenario gives one context to all of its steps, so the second one
meets whatever the first left behind (already signed in, on a different
page, a dialog still open). The two questions are different and neither
answer substitutes for the other: `do` asks whether the step works, `run`
asks whether it works there. Nothing carries across `do` calls, login
state included: a step that needs it gets it from a fixture. This lands hardest on a step
whose own setup is a no-op the second time it runs, and the fix is in the
feature rather than in the engine: establish the state once, in the step
whose name says it does, instead of once per step.

### State that cannot be repeated

Everything above starts from nothing. `nuka do` gives each execution its
own browser and its own everything else, which is what makes one call
readable on its own, and what makes exploring expensive: the twentieth
thing you want to try has nineteen things in front of it. For reads that
is only slow. For work that cannot be repeated, an account that opens
once or an invoice that would be issued twice, it is not possible at all.

nukadoko does not hold a world open for that. An agent's host can already
run a Playwright MCP server, which keeps one browser open across calls and
lets the agent act on whatever page the last call left. The acceptance
skill sends an agent there for a browser app whose state cannot be
repeated, and says how to tell whether that server is connected. A
process of nukadoko's own doing the same thing would add a second browser
to manage, a socket holding live credentials, and an idle timeout, and
buy nothing the host's server does not already do.

Nothing that server does is evidence. It writes no step record and no
`run.json`, and the run summary a reviewer reads is built from `run.json`
(see "Review"), so the path from an exploration to that
summary runs through a feature someone wrote and a real `nuka run`, or it
does not exist. A world thirty calls deep is not reproducible, by anyone,
which is why what comes out of an exploration is a scenario written from
it, checked with `nuka check`, and run again from nothing.

## Records

A step record contains the tool's measurements for one step execution. Its
shape is the same whether the step ran in a scenario or through `do`. A
scenario record (see "Running") answers the same question at the next level.
It shows what one pickle run did across its ordered steps. Both records show
the same concept at different resolutions. A scenario record is not a file
of its own: it is the scenario's entry in its run's `run.json`. Its `steps`
array identifies each step record by id and path, and a step record names
its scenario record's id, so either record leads to the other.

```json
{
  "schema_version": 3,
  "nukadoko": "...",
  "step_record_id": "step-20260801-143022-a1b2",
  "step": "create-project",
  "kind": "do",
  "args": { "name": "acme" },
  "result": { "id": "p_0001", "name": "acme" },
  "status": "passed",
  "mutates": true,
  "observed": { "http_reads": 2, "http_writes": 1, "processes": null },
  "environment": "dev",
  "target_version": "1.4.2+abc123",
  "scenario_record_id": null,
  "run_id": null,
  "started_at": "...",
  "finished_at": "...",
  "evidence": {
    "dir": ".nukadoko/do/step-20260801-143022-a1b2",
    "trace": "trace.zip",
    "screenshots": [{ "file": "final.png", "at": "..." }],
    "http": "http.jsonl"
  }
}
```

- `schema_version` comes first, so a reader can test which shape it holds
  before it reads the rest (see "CLI summary"). `nukadoko` is the version
  that wrote the record. `run.json` carries both too, as the envelope's.
- `result` provides the trust anchor: it passed the returns schema and the tool
  (not the caller) produced it. On failure, `error: { kind, message }`
  replaces it. Compat steps record `result: null`.
- `args` uses the same distinction (see "Typed steps" for the refusal this
  backs). On a `passed` record it is the schema-validated value `run`
  actually received, a schema's own `.default(...)` included even where
  the caller never typed the key; on a `failed` one it is exactly what was
  given, since a value the schema already rejected cannot be reconstructed
  into the validated shape. A compat step's `args` is never validated
  either way, having no schema to validate against.
- A bigint is stored as its decimal string, in `args`, in `result`, and
  anywhere else in a record, because JSON has no bigint. A `{biginteger}`
  capture bound to `z.bigint()` records `"v": "123456789012345678901234567890"`.
  Inside one `nuka run` scenario, a `from` chain hands the next step the
  bigint itself. `nuka do` reads `--use` values from the stored record and
  `--args` as JSON, so where the step's `args` schema expects a bigint or
  a Date, it turns the stored string back into one first. Any other
  string still reaches the schema as a string. It reads the schema's
  input side: a string piped into `z.coerce.bigint()`, a codec that
  decodes a string, and a `z.preprocess()` function get the string as
  given, and `z.bigint().transform(...)` gets the bigint. Where an option
  of a union already accepts the string as given, the string is left as
  it is, whatever order the options are declared in.
- `scenario_record_id` and `run_id` identify what this execution belongs to:
  the owning scenario record's id and the `nuka run` invocation's own id
  for a `run`-originated step (`kind: "run"`), both `null` for a
  `do`-originated one, which belongs to neither. Without `run_id`, telling
  which run one step record came from meant opening another file first; a
  step record answers that on its own, the same way
  it already answers everything else about what this one execution did.
- `error.kind` uses a closed set and sits beside the message a person reads:
  `args_invalid`, `result_invalid`, `binding_invalid`, `world_invalid`,
  `timeout`, `unsupported`, `step_error`. Closed because a report has to
  classify against it: an open one, extended per step, would classify
  nothing. The first four name failures that exist only because there is a
  contract to violate, which is the part a report built on a runner that
  discards return values cannot fill in; a classifier that isn't sure says
  `step_error`, since claiming a contract failure wrongly is worse than not
  claiming one. Hook records in the scenario record carry the same field.

  | `error.kind` | The step failed because |
  | --- | --- |
  | `args_invalid` | its args failed the step's `args` schema |
  | `result_invalid` | its returned value failed the step's `returns` schema |
  | `binding_invalid` | a feature line's text, table, or doc string could not be bound into the step's args (`nuka run` only) |
  | `world_invalid` | a write to a declared World key failed its `defineWorld` schema |
  | `timeout` | a deadline fired before the step or hook settled |
  | `unsupported` | a compat shape nukadoko does not implement: a `done` callback, or a `"pending"` or `"skipped"` return value |
  | `step_error` | anything else: the step's or hook's own code threw |

- `mutates` contains the step's declaration (`null` for a compat step, which
  has none to record, not `false`), sitting beside the `observed` counts
  so declared and measured can be compared without a second artifact.
- The harness collects evidence; the step never reports it: Playwright
  tracing and screenshots when the browser is used, every `request` fixture
  call, every `page.request` or `context.request` call, and the page's own
  document/XHR/fetch traffic alike logged to
  http.jsonl, the step record itself as the primary one.
- `evidence.screenshots` contains one entry per browser context, `{ "file":
  "final.png", "at": "..." }` for the default one and `{ "file":
  "final.<name>.png", "at": "...", "as": "<name>" }` for each `pageAs(name)`
  context (see "Several people in one scenario"), default first. A
  `pageAs` context's trace chunk for a step is listed in
  `evidence.named_traces` as `{ "as", "file" }`, beside `evidence.trace`,
  and `actions`, `page_events` entries, and http.jsonl lines from it carry
  `as`. A browser-using execution's evidence used to be two files, the
  same buffer saved under a second name whenever the step failed. That cost
  nothing to write but implied something the tool never measured: that a
  "failure" screenshot exists as a distinct fact from the last one taken. It
  never was: the screenshot only ever runs once, after `run` has already
  returned or thrown, so that second copy could already be stale relative to
  the failure it was named for. `at` (ISO 8601, the same format
  `started_at`/`finished_at` use) is what the second file was standing in
  for without ever stating it, and it says the real thing: how long after
  this execution's own timeline the screenshot was actually taken.
- `observed` holds what the tool saw the execution reach, one key per
  channel. A channel the execution never reached is `null`, never `0`:
  "nothing was measured" and "measured zero" are different facts, and a
  step that calls `fetch` makes requests no channel of nukadoko sees.
- `observed.http_reads` and `observed.http_writes` count the network calls
  that the tool saw during the execution, through the `request` fixture,
  through `page.request` or `context.request`, and through the page;
  non-GET/HEAD counts as a write (HTTP method as a proxy for write
  semantics, not semantics itself), so a POST-based read counts against a
  step that never wrote anything (see Keyword semantics). Both are
  numbers, `0` included, when the execution called `ctx.request()`,
  `ctx.page()`, or `pageAs()` (a `request`, `page`, or `context` fixture
  calls one, directly or through a fixture of the project), or when a
  request was recorded during it. Otherwise both are `null`. The counts
  settle nothing on their own: Then position and read-only environments
  act on the `mutates` declaration, never on this count. `observed` sits
  beside `mutates` (declared) so a wrong declaration is falsifiable, here
  and in the Allure report.
- `observed.processes` (`null` when the execution never called
  `runCommand`) lists each child process that `runCommand` started during the execution,
  in call order: `{ "command", "cwd", "exit_code", "duration_ms" }`, plus
  `"signal"` when a signal ended the process and `"timed_out": true` when
  the `timeout` option stopped it. `command` is an array, the program
  followed by its arguments, and the record redacts it like every other
  field. Inside a step, each entry also has `"files"`: the paths, relative
  to `cwd` with `/` separators and a trailing `/` for a directory, that
  were `added`, `changed`, or `removed` between a walk of `cwd` before
  the spawn and one after the close. A file is changed when its size,
  modification time, change time, or inode differs, so a rewrite with the
  same bytes still shows; no content is read. `node_modules` and `.git`
  directories, and the project's state directory (where the run itself
  writes), are not walked and are named in `"skipped"`. A working
  directory past 20000 entries, or one that cannot be read, gives
  `{ "unmeasured": "<why>" }` instead. It measures a directory, not a
  process: anything else writing there at the same time is in the
  difference too. A value the step holds itself, such as a token it signed, is
  not a loaded secret; `redact: { NAME: value }` writes it as
  `{{secret.NAME}}` in `command` while the program still receives it.
  `runCommand(command, args, { cwd, env, input, timeout, redact, files })`
  is an import from `nukadoko`, not a fixture. It resolves to
  `{ exitCode, signal, stdout, stderr, files }` for every exit, nonzero
  included, and rejects only when the program could not start or
  `timeout` stopped it. `files` is the same value as the entry's
  `"files"`, so a step whose claim is "the command writes nothing" returns
  the measurement instead of walking the directory itself. It is present
  inside a step, and outside one only with `files: true`. On Windows, a bare program name such as `npm` is looked up through
  `PATH` and `PATHEXT`, and a `.cmd` or `.bat` file runs through
  `cmd.exe` with each argument passed unchanged, so a step names a program
  the same way on every platform; `command` keeps the name the step wrote.
  A call inside a step's `run`, a part, or a compat step adds an entry;
  a call anywhere else runs the same way and adds none. A process that a
  step starts by other means (`node:child_process` directly) is not
  measured, so it does not appear here.
- `evidence.http` (included only after at least one call was logged) points to
  http.jsonl, one JSON object per line: `{ "method", "url", "status",
  "duration_ms", "via" }`. `via` is `"request"` for a call made through the
  `request` fixture, or through `page.request` or `context.request`, and
  `"page"` for one the page itself made (a `page`
  navigation, or an in-page `fetch`/XHR), present on every entry either path
  produces, so a reader never has to guess which one wrote a line from its
  shape alone. A `via: "request"` call is logged whatever its outcome,
  including one that throws (a refused connection, `failOnStatusCode` on an
  error status). `url` is the absolute URL the response came from, with
  `params` applied and any redirect followed, the same shape a `via: "page"`
  entry has. `declared_url` is the string the step passed and is present
  only when it differs from `url`. When no response exists, `status` is `0`
  and `error` holds the first line of the failure message; the declared
  string is then the only URL known, so it is `url`. A failed append does
  not fail the step; it is counted in `http_log_failed` (below). A page request's line belongs to the step that sent it. The
  path is taken when the request starts, and the response is appended there
  even when it arrives after that step has returned. That is the same step
  `observed` already counted. Only `document`, `xhr`, and `fetch` requests (Playwright's own
  `request.resourceType()`) ever reach http.jsonl for page traffic; a real
  page load can pull in dozens of images, stylesheets, and scripts that
  nobody reading a step record for acceptance purposes traces one by one,
  and a file trying to hold all of them would stop being something a reader
  opens at all.
- `evidence.attachments` (included only when it has entries) lists what
  `evidence.attach`/`evidence.path` actually wrote this execution (see
  "Context API"), each `{ "name", "file", "at" }`: `name` is what the step
  asked for, `file` is what actually landed on disk under `evidence.dir`,
  and the two differ only when the same `name` was used more than once this
  execution. A `name` that differs only by case is the same name here. The
  second use gets `-2`, `-3`, ... inserted before the
  extension rather than overwriting the first (`dup.txt` then `dup-2.txt`,
  `Report.txt` then `report-2.txt`,
  never one file silently replaced by the other). `at` is taken by the
  harness itself, never supplied by the step: for `attach`, the moment the
  write resolved; for a `path()`-allocated file, that file's own mtime once
  execution confirmed it exists, the same measured-not-declared rule
  `sections`/`polls`/`evidence.screenshots[].at` already follow, landing
  attachments on that same absolute timeline. A `path()` call with nothing
  ever written to the path it returned contributes no entry at all: only a
  file confirmed to exist on disk is ever listed, the same "evidence lists
  only files that exist" rule `evidence.http`/`evidence.trace` already
  follow. Whether a `path()`-allocated file was actually written is
  decided by the harness checking, never by the fixture bookkeeping the
  call. A `name` containing a path separator, or equal to `.`/`..`/the
  empty string, is refused before anything is written, never silently
  rewritten into something safe. A `name` of `record.json`, `final.png`,
  `trace.zip`, or `http.jsonl`, or of the shape `trace.<name>.zip` or
  `final.<name>.png` for a valid `pageAs` name, is refused the same way
  (`ReservedEvidenceNameError`), including a spelling that differs only by
  case: those are files the harness writes in this directory. Capped at 100
  entries, sorted by `at`, the
  same convention `page_events`/`actions` already use; the true total, once
  that cap is hit, lands on `truncated.evidence` (below), the same sibling
  field `truncated.actions` already uses. The step record's `name`/`file`
  strings pass through the same single redaction pass every other field
  does; the attachment's own file *contents* are never redacted (redacting
  arbitrary bytes would as often corrupt them as protect them). What
  `attach` is given is the step's own responsibility to keep secret-free.
- `evidence.scratch` (included only when it has entries) lists the absolute
  paths of the directories `scratch.dir`/`scratch.copy` created during this
  execution, in creation order (see "Context API"). The directories are
  removed when the scenario ends, so a path here says where the step
  worked, not a file that still exists.
- `http_omitted` appears only when at least one page request was omitted.
  It makes the omission visible by counting what
  didn't make it into http.jsonl, by resource type, e.g.
  `{ "image": 34, "stylesheet": 5, "script": 12 }`. `observed` (above) is not
  narrowed by any of this: it tallies every request the harness saw, image
  and script traffic included, because it answers a different question (how
  many reads and writes actually happened) than http.jsonl does (which of
  those calls are worth reading one by one). The two counts are not
  expected to add up to each other, and neither being lower than the other
  is a bug.
- `http_log_failed` (a number) appears only when at least one http.jsonl
  line could not be appended, for example because the step directory was
  missing, the disk was full, or a permission was denied. It counts the
  lines lost, so a request `observed` counted but http.jsonl lacks is
  never silent. A failed append does not fail the step: measurement does
  not break execution.
- `used` (included only when it has entries) lists the earlier executions whose
  results this one drew a value from: through a `from` injection, a
  `resultOf` call, or a `--use` step record on `nuka do`. Every path runs
  through library code, so the reads are measured, not declared. Each entry
  is `{ "step_record_id": "step-…", "step": "create-project" }`: the step
  name is redundant with the cited step record and is written down anyway,
  because a record that has to be resolved against other files to be read
  is worse for a reader than one that is legible alone, and the file it
  would be resolved against is a local working record that retention may
  already have removed. Entries are deduplicated by record id, in the
  order first read. The dependency is thus visible twice over: statically
  as `from` or an import, at run time as provenance in the step record
  chain. Which upstream *step* a value came from was settled when the step
  file was written; which *execution* of it supplied the value is knowable
  only here.
- Only a **failed** step record adds `result` to each `used` entry. It contains
  the upstream step record's full validated result,
  sitting right beside the id/step pointer. This is what lets one failed
  step record be read alone instead of opening a second `record.json` just
  to see what the step actually saw. A `passed` step's `used` entries never
  carry `result`: the value that mattered is already sitting on that
  step's own `result` (or on its `args`, if it came in through `from`), so
  repeating the upstream one there would only be redundant. The whole
  result, not narrowed to the one key a `from` injection or `resultOf` call
  happened to read: diagnosing a failure needs *why* the upstream value
  came out this way, not which key was cited: narrowing to the cited key
  would recreate, on the step record side, the same citation-only trap
  "return more than what a later step cites" (see Typed steps) already
  warns against. That also means this field can only carry what the
  upstream step's own `returns` schema kept in the first place: a
  `returns` that dropped a value drops it from here too.
- `calls` (included only when it has entries) lists the parts this execution ran
  through the `call` fixture (see "Parts"), in the order the calls started. Each entry is
  `{ "step": "create-project", "args": {...}, "result": {...},
  "started_at": "...", "finished_at": "..." }`, and carries `error`
  instead of `result` when the part failed, classified the same way a step
  record's own `error` is. Unlike a step record's own top-level `args`
  (above), `args` here is always the raw value `call()` was given, on both
  outcomes: what changed for a part is what `call()` accepts, never what
  gets written down. A part that called a part carries its own
  `calls` under that entry. These are not step records and have no
  `step_record_id`: `--use` cites a step record, and what this execution
  offers a later one is its own `result`. Recording the args and the
  result at each internal boundary is what a composite step's record is
  read for once it fails, since the values that crossed those boundaries
  are otherwise nowhere.
- `sections` (included only when it has entries) lists the `section` calls
  made during this execution, each `{ "label": "...", "at": "..." }`, in
  call order. Not deduplicated, unlike `used`: a label entered twice (a
  loop, a retry) was entered twice, and the array should read that way,
  where `used` names a step record id once because an id is an identity
  worth citing once, not a point in a sequence. `at` was left off at first,
  on the reasoning that the question `sections` answers is where execution
  stopped, not where it was slow. That turned out to be only half true. A
  label alone says a stage was reached, never *when* relative to anything
  else this same record carries, and a real run surfaced exactly the gap
  that leaves: a `status: "failed"` sitting next to a `final.png` that
  showed the target still present, roughly eight seconds apart, with
  nothing on the record saying so: read at face value, that looks like
  the state was flickering, and it was misdiagnosed as exactly that. `at`
  (ISO 8601, taken by the collector itself when `section` is called,
  never supplied by the step) puts every label on the same absolute
  timeline `started_at`/`finished_at`, `polls`' own `at`, and
  `evidence.screenshots[].at` already share, so "did the state actually
  change" and "was this read taken before it settled" stop being
  indistinguishable from a step record alone. A failed step's `sections` still
  holds whichever labels it reached before the failure, and that array's
  last element already answers "which stage was it in": there is no
  separate `error.section` field putting the same fact in a second place.
  Only a typed step's fixture bag has `section`; a compat step has no
  counterpart on `this`, so `sections` is simply omitted for one, the same
  way `used` is omitted for a typed step that never read from the chain.
- `polls` (included only when it has entries) records every `poll` call that
  finished during this execution: its `description` when one was given,
  `at` (the ISO 8601 moment that call began), how many times the
  predicate ran, the milliseconds elapsed, and how it ended: `resolved`,
  `timed_out`, or `failed` when the predicate itself threw. In completion
  order rather than call order: a nested poll finishes before the one
  containing it, and only a finished poll has counts to state. A timed-out
  poll is recorded like any other, since that step's own record is exactly
  where the numbers are wanted. Unlike
  `sections`, `polls` always carried timing beyond a bare label, because
  the question it exists for is a timing question: one attempt at 0ms says
  the condition was already true and the wait was a no-op, forty attempts
  over 20s says it was genuinely late, and the two look identical from
  outside the step while calling for opposite fixes. `at` adds the missing
  half (an absolute start, not just a duration), so a poll can be placed on
  the same timeline `sections` and `evidence.screenshots` now share, instead
  of read as a length with no fixed point to measure from. A compat step has
  no fixture bag to call it on, so `polls` is simply omitted for one, the
  same way `sections` is.
- `required_env` (included only when it has entries) lists the names
  `requireEnv` was called with during this execution, deduplicated, in
  the order first read: the same measured-not-declared shape `used` and
  `sections` already have, since `requireEnv` is the one call site the
  library controls. Recorded before a missing key throws, so a
  `MissingEnvError` failure's record still shows what the step asked for.
  Only names are recorded, never values: a value can be a secret. A step
  that reads `env[name]` directly leaves no trace here: this field
  counts only what passed through `requireEnv`, never a plain object read
  the library never sees.
- `page_events` (included only when at least one category has entries)
  records what the browser context itself saw while a step ran: console
  errors (`console.error` calls only, never warnings, which most SPAs emit
  routinely enough to be noise), uncaught page errors (`BrowserContext`'s
  `weberror`, the context-level counterpart to `Page`'s `pageerror`), and
  requests that failed at the network level. Service workers stay outside
  what the browser context sees: `BrowserContext`'s events cover pages in
  the context, not a worker, and Playwright's `Worker` type exposes only
  `close` and `console`, no request or error event to listen for, so what
  a service worker's console emits and any background fetch failure inside
  it go unrecorded. cucumber-js has no browser context of its own to hold
  any of this: a step can pass (`status: "passed"`)
  while the page underneath it was throwing the whole time, and before this
  field nothing on the record said so. Each category is present only when
  it recorded at least one entry, and is always a bare array, never
  something whose own type depends on how many entries it holds:
  `console_errors`, each entry `{ "text", "location": { "url", "lineNumber",
  "columnNumber" }, "at" }`; `page_errors`, each entry `{ "message", "at" }`
  (never the error's own stack: trace.zip already carries it, and a stack
  widens what redaction has to reach for little gain); `failed_requests`,
  each entry `{ "method", "url", "failure", "at" }`. `at` (ISO 8601) is
  taken by the collector itself, the same measured, never declared
  convention `sections`/`polls` already follow. Capped at 100 entries per
  category: a redirect loop or a chatty page can produce thousands of these
  in one step, and a step record trying to hold all of them would stop
  being something a reader can open. A category that hits the cap stays a bare
  array (still capped at 100) and instead adds its own name to a sibling
  `truncated` object on `page_events`, mapped to its true total, present
  only when at least one category was actually truncated:
  `"truncated": { "console_errors": 4213 }`. An earlier version reported
  the same fact by turning a truncated category itself into
  `{ entries, total, truncated: true }`, so a category's type changed with
  how many entries it held and a reader had to branch on that type before
  trusting a count read off it; the sibling field exists so every category
  is always the same shape and a truncation is a separate fact, reported
  once, in one place. Redacted the same way every other field is: a secret
  can land in console text or a failed request's URL as easily as it can
  anywhere else, so no separate redaction path exists for this field.
  Present on both a successful and a failed step's record alike: a page
  error is evidence about the page, not a verdict on the step.
- `actions` (included only when it has entries) comes from this step's
  trace chunk (`evidence.trace`, above): every Playwright call the step made
  through the `page` fixture, `expect` waits included, in the order the
  trace recorded them finishing. One exception: Playwright itself runs an
  internal watch for `console`/`weberror`/`requestfailed` events on every
  browser context, and that watch is not a call the step's own code made, so
  it is excluded from `actions` rather than reported as one. `expect` is deliberately not a fixture
  either (see "Context API"): a step reaches it the same way a Playwright
  test file would (`import { expect } from "playwright/test"`), and the
  trace records the call underneath that wrapper, at Playwright's own
  layer, the same place `goto`, `click`, and every other call already
  lands. Each entry
  is `{ "method", "expression"?, "selector"?, "url"?, "is_not"?,
  "timeout_ms"?, "ms", "outcome", "at" }`: `method` and the five optional
  fields are copied straight off the trace's own call, `ms` is that call's
  own duration on the trace's own clock, `outcome` is `"failed"` when the
  trace recorded an error on it and `"passed"` otherwise, and `at` (ISO
  8601) is converted from the trace's own monotonic clock into an absolute
  timestamp, landing `actions` on the same timeline `sections`/`polls`/
  `evidence.screenshots[].at` already share. The five optional fields are an
  allowlist, not everything the call carried: a `setContent` call's own HTML
  body, for one, can run to kilobytes, and nothing a step record is for
  needs it when trace.zip already has the whole thing. Capped at 100 entries, same
  convention as `page_events`, with the same sibling `truncated` field
  reporting the true total when the cap is hit: `"truncated": { "actions":
  214 }`. `evidence.attachments`' own truncation (above) reports through
  the same field too, as `truncated.evidence`, present alongside
  `truncated.actions` whenever both caps were hit in the same execution,
  either alone when only one was. Redacted the same single pass every other field is: a secret can
  land in a `url` or `selector` as easily as it can anywhere else, so no
  separate redaction path exists for this field either. A trace chunk that
  cannot be read at all (corrupt, or simply never opened because the step
  never destructured `page`) costs `actions` silently, the same
  measurement-must-never-break-execution rule every other evidence-reading
  field on this list already follows. The one loud exception is a trace
  format version this build does not recognize: guessing at an unverified
  shape is worse than reporting nothing, so `actions` is still omitted, but
  `nuka run`/`nuka do` also warn once, on stderr (`warning: trace format
  version <n> is not readable by this build; step actions were not
  recorded`), because a silently empty `actions` sitting next to a
  `evidence.trace` that plainly exists would otherwise read as "nothing
  happened" rather than "this build could not read it".
- Before, After, and AfterStep hooks have no step records (see "Compat
  steps"). Their trace evidence therefore appears in the invocation entry in
  the scenario record's `hooks` array instead: `trace` (relative to the
  scenario's own directory, not a step record dir, since a hook has none),
  `actions`, and `truncated`, in exactly the shape above, present under
  exactly the same rules. A hook invocation carries no `sections`/`polls`
  alongside them: both come from a typed step's `section`/`poll` fixtures,
  and a hook has no fixture bag of its own to call either from, only a
  World (`this`). `actions`, read back out of the trace chunk itself
  rather than from anything the hook explicitly called, is unaffected by
  that gap. A hook invocation that never touched the browser opens no
  chunk and carries none of the three fields at all, the same as a step
  that never destructured `page`.
- `fixtures` (included only when it has entries) lists every `config.fixtures`
  entry this step's own bag resolution actually touched, `{ "name",
  "scope", "setup_ms"?, "at"?, "reused" }` (see "Fixtures" for the full
  shape and why `setup_ms`/`at` are only present on a freshly built entry).
  Teardown itself is not on this list: it runs after this step record is
  already closed, so a `scenario`-scope fixture's own teardown failure
  lands on the scenario record's `teardown_errors` instead (see
  "Fixtures").
- `run.json`'s `commit` is `{ "sha", "dirty" }`: the full 40-character
  sha the working tree was at when the run started, and whether
  `git status --porcelain=v2 --branch` (untracked files included) printed
  more than its `#` header lines then. It is measured once when the run
  starts, not once per pickle, so it holds even when a step edits a tracked
  file mid-run. It is `null` outside a git repository, before the first
  commit, and when the git call fails; the run itself never fails over it.
  The run summary reports it (below), so a reviewer sees which commit ran
  and whether the tree had uncommitted changes.
- A run's step records are stored under `.nukadoko/runs/<run_id>/steps/<id>/`,
  beside its `run.json`, and a `nuka do` step record under
  `.nukadoko/do/<id>/` (see "Artifacts"). Both are
  local working measurements; what a person keeps is the run summary on the
  pull request (below).

**The run summary.** Records are written for a machine and an agent. Each
`nuka run` that runs at least one pickle also writes one Markdown summary of
the whole run, for the person who reviews it. It is rendered from the run's
`run.json` document alone, by one pure function, after every record and
run-scope hook, so a `--concurrency` run gets one summary from the parent,
not one per worker, the summary cannot say what `run.json` does not, and a
summary can be rendered again from a `run.json` copied off a CI machine. It
holds:

- the line `<!-- nukadoko:run -->` first, so a CI step can find and update a
  pull request comment it posted earlier;
- a title with the run's verdict (the exit code's, so an AfterAll failure
  with every scenario green still reads `failed`, with a sentence saying the
  failure was outside every scenario) and its scenario counts;
- the condition: the short commit sha and whether the tree had uncommitted
  changes (from `commit`, or "unknown" without one), each environment and its
  target version, every browser a scenario launched or "none launched", the
  `selection` (`partial` says a line target left out other scenarios of its
  file), the nukadoko version, the run id, and the start and finish times;
- under `--since`, "Criteria since `<ref>`": how many scenarios are
  unchanged, changed, and new, how many criteria were removed (and how many
  are ambiguous or not compared, when any are), which targets and which
  step files were compared, the step files that changed, the lines of each
  scenario that is not unchanged and of each removed criterion in a
  `gherkin` block, and under each changed step file every scenario that
  names it;
- one table per feature file, by path, with a row per scenario in line
  order: scenario, line, one column per environment, named after it, with
  that cell's verdict (`<passed> of <n> passed` under `--repeat`), the
  duration of every execution in the row, and for a failed one where it
  failed (the first step that did not pass or skip, otherwise the first
  failed hook), the first line of that error, each `used` step whose process
  exited nonzero with its exit code and the first line of its stderr, or of
  its stdout when stderr is empty (as on stderr), the last command the step ran through `runCommand` that did not
  exit 0, and the record's path, once for each environment it failed in
  and prefixed by that environment when the run had more than one;
- "Declared vs observed", over every step that ran and has a step record:
  each step that declared `mutates: false` but made at least one measured
  write (`observed.http_writes > 0`, see "Keyword semantics") or ran a
  process whose working directory changed (`observed.processes[].files`),
  stated as a raw fact (the declared value beside the observed count, and
  up to three changed paths), never a verdict.
  A step that declared `mutates: false`, reached no HTTP channel
  (`observed.http_writes` is `null`), and ran no process whose files were
  measured was not compared, and the section counts those steps in one
  line ("2 steps that declared `mutates: false` reached no HTTP channel
  nukadoko observes ..."), so a step that called `fetch` or wrote a file
  itself is never reported as having made no write.
  A step that reads over POST lands here every time, by design: the same
  HTTP-method proxy that made run-time `mutates` enforcement unreliable. It
  is one section for the whole run, so it cannot be scanned past by
  accident, and it is written even when nothing disagrees, so "compared,
  found nothing" stays distinguishable from "never compared". A compat step
  (`mutates: null`, see "Compat steps (the migration door)") has no
  declaration to compare and is counted separately;
- "Findings", when the run raised any finding other than a failed scenario
  (a warning such as a file that was not written or a teardown that
  failed), one line each with its severity, code, location, and message;
- for a failed run, each failed scenario's `do`, the `nuka run
  <feature>:<line>` command, with `--env` naming the environment it failed
  in when the run had one.

It is written to `.nukadoko/runs/<run_id>/summary.md` every time,
appended to the file `$GITHUB_STEP_SUMMARY` names when that is set (GitHub
Actions sets it for every step, so the job's summary page shows the run with
no configuration). `nuka report --format markdown` prints the same text for
any finished run, and `--out <path>` writes it to a file, such as one a CI
step posts as a pull request comment. Error text in it is `run.json`'s, so secrets are
already redacted. A summary that cannot be written is a warning
on stderr; it never changes the exit code. A `run.json` that cannot be
written fails the run with a `run-result-not-written` finding, which the
summary and the `--json` document carry too (run.json is written before
the summary is rendered, so a run whose run.json was not written never
reads as passed): every later command reads a run from
`run.json`, so a green exit without it would claim a record that does not
exist. A `sources.json` that cannot be written fails the run the same
way, with `run-sources-not-written`: without it `nuka report` cannot
render the run. It is written first, so its finding is in the summary,
in `run.json`, and in the `--json` document. The `run` location line is
printed only for a `run.json` that was written. A setup failure, which writes no record, writes no summary.

## Environments and secrets

Nukadoko provides execution infrastructure that Cucumber did not provide:

- **No state carries across calls.** Each scenario under `nuka run` and each
  `nuka do` call starts clean. A step that needs login state gets it from a
  fixture, or from a Given step its feature names.
- **Environments** name deployment targets. Each environment can define a
  `baseURL`, `envFiles`, `policy: "read-only"`, and an optional `version` probe.
  The read-only policy refuses mutating steps. Each step record stores the
  probe result as `target_version`. The run summary states each environment
  and version, so a reviewer knows the deployment where the run was green.
- **Secrets** use git to classify their *origin*. An ignored or untracked env
  file is a secret source. Nukadoko does not distinguish between those two git
  states. Every value in a secret source is a secret without a declaration.
  A tracked env file is plain configuration only when its working tree matches
  HEAD, because that is when its values are the committed ones. Uncommitted
  edits, staged or unstaged, make that file a secret source: the values on
  disk are not the committed values. Outside a git repository, nukadoko
  treats every envFile as a secret source.
  Origin and *handling* are separate questions. `secrets.public` makes one key
  from a secret source plain and prevents its redaction. `secrets.redact` tells
  nukadoko to redact one key from a tracked file. This instruction preserves
  git's origin classification. It prevents the value from spreading to a new
  surface, such as a terminal, CI log, pasted bug report, or agent transcript.
  Both origins use the token `{{secret.NAME}}`. There is no separate
  `{{redacted.NAME}}` marker, so readers need to recognize only one redaction
  form. A key cannot occur in both `public` and `redact` because the two lists
  give opposite instructions. Nukadoko reports this conflict as a config error.
  The executor redacts secret values from either origin when it writes a step
  record surface: `record.json`, the stdout copy from `do`, or http.jsonl.
  A step's `run` cannot control this process.   Each loaded value is removed
  in every spelling below, and each spelling is replaced by the same
  `{{secret.NAME}}` token. The spellings are the value itself, the
  percent-encoded form `encodeURIComponent` produces, that same form with
  each `'` written as `%27`, the `application/x-www-form-urlencoded` form
  `URLSearchParams` produces, and the JSON-escaped form `JSON.stringify`
  writes inside a string. The quotes `JSON.stringify` adds are not part of
  that form. A URL href uses the `%27` spelling and still writes a space as
  `%20`. `URLSearchParams` writes a space as `+`, and it percent-encodes
  `!`, `'`, `(`, `)`, and `~`, which `encodeURIComponent` leaves as
  themselves. A query string therefore loses a secret that was encoded in
  any of those ways before it was logged, and text that already holds JSON
  loses a secret whose quotes or backslashes were escaped. A form that is
  itself some key's loaded value uses that key's name, the alphabetically
  first name when several keys share the value.
  A percent-encoded, form-urlencoded, or JSON-escaped form that no key
  loaded as its raw value uses the alphabetically first key that produces
  it. Longer forms
  are replaced first, so a shorter secret cannot take a bite out of a
  longer one. A JSON number that equals a numeric secret is left as a
  number. Matching it would rewrite ordinary counts and timings whenever
  they happened to equal a loaded value, and it would change that field's
  type. The decimal digits are still removed wherever they appear as text.
  Values shorter than four characters are never redacted, in any form,
  including values named in `redact`. Nukadoko
  can redact only values that it loaded. It cannot detect a new token in a
  step result. A value from a tracked env file that matches HEAD remains plain
  on all record surfaces unless `secrets.redact` names it. Those surfaces
  include an agent transcript, which did not exist when `.gitignore`
  classified tracked and untracked files.
  Therefore, repository membership does not classify that new surface. Traces
  and screenshots are not redacted, so the state directory is sensitive.
  `nuka check` never prints a key's value. It reports two warnings. The first,
  `secrets-redact-key-too-short`, warns when `secrets.redact` names a value that
  is too short for redaction. For a tracked env file that matches HEAD, the
  second, `tracked-secret-looking-key`, warns when a key name suggests a secret
  but `secrets.redact` does not name it. A name suggests a secret when it
  contains `SECRET`, `PASSWORD`, `TOKEN`, or `CREDENTIAL`, or when `KEY` is a
  whole underscore-delimited token of it (`KEY`, `API_KEY`, `KEY_ID`,
  `PUBLIC_KEY_URL`). A name that only contains the letters, such as
  `KEYWORD`, `MAX_KEYS_PER_PAGE`, or `APIKEY`, does not suggest a secret.
  This name heuristic controls only the warning. Redaction depends only on
  git's classification (untracked, ignored, or a tracked file that differs
  from HEAD, versus a tracked file that matches HEAD) and `secrets.redact`.
  `nuka tend` reports the other two findings as notes:
  `secrets-public-key-unknown` and `secrets-redact-key-unknown` name a
  `secrets.public` or `secrets.redact` key that no configured envFile defines.

Configuration lives in `nukadoko.config.ts` and uses `defineConfig`. The table
lists each accepted key. A key with more details points to a later paragraph
or to the section for its feature. nukadoko reads the file's default export.
A file with no default export, or a Promise as that export, is a
`ConfigError` that names the file. A named export is not the config. The
object itself is what loads, including `export default defineConfig({ ... })`.
The file is read from the directory `nuka` runs in, never from a parent
directory. Where neither `nukadoko.config.ts` nor `nukadoko.config.mts`
exists, every command that reads the config writes one line to stderr that
names that directory and the defaults that apply. When a parent directory,
up to the nearest one that holds `.git`, has a config, the line also names
that file relative to the current directory, and `nuka scaffold` refuses to
write, since a step file there is not one that config reads. `nuka init`
writes the file and prints no such line.
`export default {}` is the empty config and receives the same defaults as a
missing file.

| Key | What it holds |
| --- | --- |
| `featuresDir` | feature files and step code, `nuka run`'s own unattended set (default `features`, Cucumber-style) |
| `additionalFeatureDirs` | extra directories `nuka check`/`nuka tend` bind vocabulary against, without joining `featuresDir` (default `[]`, below) |
| `baseURL` | top-level base URL, overridden per environment (below) |
| `envFiles` | top-level env files, appended to per environment (below) |
| `environments` | per-environment `baseURL`, `envFiles`, `policy`, `version` probe (below) |
| `stateDir` | where nukadoko writes at run time (default `.nukadoko`, see "The state directory") |
| `retention` | how long measurement stays: `runs` (default 20) newest runs kept whole, `adHocDays` (default 7) for a record no run owns (see "Artifacts") |
| `browserType` | which Playwright engine the `page` fixture launches: `chromium` (default), `firefox`, or `webkit` (below) |
| `browser` | Playwright's own `LaunchOptions`, passed to that engine's `launch` (below) |
| `browserContext` | Playwright's own `BrowserContextOptions`, passed to `browser.newContext()` (below) |
| `requestContext` | the matching `newContext` options for the `request` fixture (below) |
| `secrets` | `public`/`redact` lists that adjust a key's redaction handling (above) |
| `parameterTypes` | custom cucumber-expressions parameter types (below) |
| `worldParameters` | object a compat World receives as `parameters` (default `{}`, below) |
| `fixtures` | user-defined fixtures (see "Fixtures") |
| `fixtureTimeout` | default setup/teardown timeout per fixture instance, in ms (see "Fixtures") |
| `stepTimeout` | how long a typed step's own `run` may take, in ms (default 1,200,000; `defineStep({ timeout })` overrides it, compat steps are not covered) |

`additionalFeatureDirs` defaults to `[]` and has a different purpose from
`featuresDir`. `featuresDir` defines the set that runs unattended. With no
argument, `nuka run` processes exactly that directory. The additional list
does not widen the run set. Static checks bind vocabulary against both
`featuresDir` and `additionalFeatureDirs`. Thus, `nuka check` with no argument
and `nuka tend` walk the wider set. Pattern binding is a project property,
independent of the current unattended run. A feature for a change that has
landed, kept outside `featuresDir`, belongs in `additionalFeatureDirs` (see
"Review"). Its steps then count as bound instead of producing
`pattern-unbound`, but the feature does not run unattended. A feature that
describes a core product path moves into `featuresDir` and needs no
additional entry. A missing entry
is a config error. `nuka check` reports `additional-feature-dir-missing`;
`nuka tend` does not repeat it.

That feature walk skips `node_modules` and any directory whose name starts
with `.` at every depth, for `featuresDir`, for each `additionalFeatureDirs`
entry, and for a directory passed to `nuka run`. Step discovery skips those
same directories. A `.feature` file inside one is not part of `nuka check`,
`nuka tend`, or `nuka run`, and the skip reports nothing.

`browserType` selects the Playwright engine that the `page` fixture launches. The
choices are `"chromium"` (default), `"firefox"`, and `"webkit"`. It is separate
from `browser` because Playwright's `LaunchOptions` type has no engine key.
Playwright selects an engine through the called `launch` function. An option
does not select it. Putting the selector in `browser` would add a field that
`LaunchOptions` does not accept. This would break the contract that passes the
Playwright type through unchanged. Firefox and webkit each require their own
binary (`npx playwright install firefox` or `webkit`). Only a launch can show
whether the binary exists, so `nuka check` makes no claim. At launch time,
Playwright reports a missing binary without interception or revised wording.
The scenario record `browser` field stores the measured engine and version
that the run launched (see "Running").

`browser` directly accepts Playwright's `LaunchOptions` type. zod checks only
that the value is an object. The type comes from `defineConfig`, so `tsc`
reports a typo as it does elsewhere in `nukadoko.config.ts`. Repeating the
Playwright options in zod would require an update for every new option. Until
that update, config authors could not use the new option. Nukadoko passes
`browser` to the selected engine's `launch` method unchanged.
`browserType` selects that engine. When omitted, Playwright uses its default,
`headless: true`. Options such as `viewport` belong to a different Playwright
type for `newContext`. This key does not accept them. See `browserContext` and
`requestContext` below.

`browserContext` and `requestContext` configure the two `newContext` calls.
Nukadoko builds `browser.newContext()` when a step bag names `page`. It builds
`playwrightRequest.newContext()` when a step bag names `request`. These calls
use different Playwright option types, so each has a separate config key. Both
keys follow the `browser` policy and use Playwright's type directly. This makes
options such as `ignoreHTTPSErrors` available for local targets with a
self-signed certificate. Previously, neither fixture could set that option.
Both keys reject `baseURL` with an error that gives the reason:
`config.baseURL` is the single source for the project base URL, and a second
one would let the config contain conflicting sources. `storageState` passes
through to Playwright unchanged, so a project that keeps a login state file
names it here.

A `parameterTypes` entry registers a custom cucumber-expressions parameter
type with the shape `{ name, regexp, transformer? }`. For example,
`{ name: "negation", regexp: /( not)?/, transformer: (s) => s === " not" }`
lets a pattern bind `will{negated:negation} return` to a plain `z.boolean()`
args key. Registration belongs in config because config is executable
TypeScript. The version probe is a function for the same reason. Nukadoko has
no support-file format for this registration. Names must not conflict with
built-in types. A project-specific definition of `{int}` would silently change
each pattern that uses it. The transformer performs coercion. It runs
with that scenario's World as `this`, and a Promise it returns is awaited
before the step runs. The args schema remains the contract.

`worldParameters` is the object a compat World's constructor receives as
`parameters`, which glue reads as `this.parameters`. cucumber-js takes the
same object from its configuration or from `--world-parameters`. The
default is `{}`. Config is the only place it is set. A command line flag
beside the key would be a second source for one object, and the two could
disagree. The value must be a plain object. An array, a string, or `null`
fails config load, so a step never sees an empty object in its place.

An environment entry is `{ baseURL?, envFiles?, policy?: "read-only",
version?: () => string | Promise<string> }`. Its `baseURL` overrides the
top-level value. Its `envFiles` follow the top-level list, and later files win.
This order provides the common and override layers familiar to dotenv users.
A path that is not on disk contributes nothing. `nuka check` warns with
`env-file-missing`, or with `environment-env-file-missing` when the path
belongs to one environment. A path that is present but cannot be read, or
a directory at that path, stops setup. The refusal is
`env-file-unreadable`, exit 2, under `nuka check`, `nuka run` (with or
without `--no-check`), `nuka do`, and `nuka tend`, and it names the
configured path and the errno. The same read fills the `env` fixture and the secret set, so
the two agree on whether the file was loaded.
Only an environment can define `policy` and `version`. Without `--env`, the
environment name is `default`, which needs no entry. An entry named `default`
is still allowed, and `policy: "read-only"` on it is what keeps a `nuka do`
typed without `--env` from writing anywhere. An explicitly named
environment must exist because its name asserts that it exists. The `version`
probe is a function because config is executable TypeScript. A URL and
jsonPath DSL would only provide a more complex form of `fetch`. The tool calls
the probe once per run with a 10-second budget. An exception or timeout removes
only `target_version`; it does not stop the run.

An env file is `KEY=VALUE` text. The `env` fixture and the secret set read it with
the same parser. Comments, quotes, backslash escapes, and a value that spans
lines follow dotenv's default parser. The separator is `=` only. A `:` is
not a separator. Line breaks are LF, CRLF, or a lone CR. When a value spans
lines, the breaks inside the value are LF, whichever break the file used.
A blank line is ignored. A line whose first non-whitespace character is `#`
is a comment. `export` followed by whitespace is an optional prefix. The
first `=` separates the key from the value, and whitespace around it is
removed. The key is the remaining text before that `=`, and it must not be
empty. It is not limited to ASCII letters. A later binding for the same key
replaces an earlier one. `$NAME` is not expanded.

An unquoted value runs to the end of the line or to a `#`. That `#` starts
a comment even with no space before it. The value is trimmed, and it may
contain `=`. A value in double quotes, single quotes, or backticks may span
lines. A backslash immediately before the closing quote keeps that quote in
the value. After the closing quote, the rest of the line may only be
whitespace or a `#` comment. Anything else means the line is read as
unquoted text, quotes included. In double quotes, `\n` becomes a newline
and `\r` becomes a carriage return. A backslash before either pair is not
special, so `\\n` is a backslash followed by a newline. Single quotes and
backticks do not expand escapes. A quote that never closes is ordinary text
on its own line, including the quote character, and the next line is read
on its own.

A line that is not blank, not a comment, and not part of a binding is
skipped. `nuka check` reports it as `env-file-skipped-line`, a warning. The
finding names the file and the line number, never the text, because that
text may be a secret. The run still loads every binding it could read.

This example defines both `environments` and `fixtures`:

```ts
export default defineConfig({
  baseURL: "https://acme.example",
  environments: {
    staging: { baseURL: "https://staging.acme.example", policy: "read-only" },
  },
  fixtures: {
    tenant: async ({ request }, use) => {
      const t = await createTenant(request);
      await use(t);
      await destroyTenant(request, t);
    },
  },
});
```

### The state directory

Nukadoko writes all run-time data under `.nukadoko/`. `init` adds this directory
to gitignore, and the data is not for commits. The data falls into two
kinds, measurement and export (see "Artifacts"):

- `runs/<run_id>/`: one directory per `nuka run` invocation, holding
  everything that run measured, so CI uploads one directory per run and
  retention and `clean` remove one (see "Artifacts"):
  - `run.json`, the run's result, and `summary.md`, its run summary (see
    "Records"); `sources.json`, the text of every feature file the run
    parsed, so `nuka report` can render the run from this directory alone
  - `steps/<id>/`: one directory per step record: the record JSON and its
    evidence files (trace.zip, screenshots, http.jsonl)
  - `scenarios/<id>/`: one directory per scenario run that wrote evidence
    of its own: the scenario's final screenshot, and one trace chunk per
    Before/After/AfterStep hook invocation that touched the browser (named
    uniquely per invocation, e.g. `hook-before-0.zip`,
    `hook-after_step-1-2.zip`, since more than one hook can share this one
    directory, unlike a step, which never shares its own `steps/<id>/`),
    mirroring Playwright's own per-test `test-results/` convention one
    level up. No whole-scenario trace.zip here: each step's own trace lives
    under that step's own `steps/<id>/` instead (see "Running"). A
    scenario that wrote none of these leaves no directory: its entry in
    `run.json` is its record
  - `exports`: every file `nuka report` wrote of that run under the state
    directory (Allure results, containers, and attachments, and a messages
    stream or summary written there with `--out`), one root-relative path
    per line. It is what lets a run's export output leave with the run, and
    what a second render of the same run replaces. It carries no status or
    timing: `run.json` does
- `do/<id>/`: one directory per `nuka do` step record, the same shape as a
  run's `steps/<id>/`. A `nuka do` call belongs to no run, so its record
  sits apart from every run directory
- `export/allure-results/`: where `nuka report --format allure` writes
  by default, holding at most the runs `runs/` holds, since a run's files
  leave with the run (see "Artifacts"), and safe to delete whenever a fresh
  Allure launch is wanted; `init --allure` also creates it empty, since
  Allure's own CLI refuses to start against a missing directory but
  accepts an empty one, letting `allure watch` already be running before
  the first render

The routine removal is retention, which `nuka run` applies itself at the end
of every run (see "Artifacts").
`nuka clean [--dry-run] [--json]` deletes both kinds at once: every
run directory, every `do/` record, every file under `export/` that a run's
exports manifest names, and the contents of `export/allure-results/`.
Every other entry of `export/` stays, such as the Allure history file, an
`allure generate` report, or a file a person put there: nukadoko removes
only what it wrote. It is also the operation for an `allure-results/`
directory written before runs kept a manifest of their files, which
retention never touches. It also lists and removes the `cache/` and
`records/` directories an earlier release wrote under the state directory,
which nothing reads any more; `cache/sessions/` held each session's
browser storage state, cookies included. Its `--json` plan names them in
`legacy`. A report written with `--out` outside the state
directory is the caller's file, and `nuka clean` does not read or remove it.
A results directory that existed is recreated empty, so an `allure watch`
pointed at it keeps finding it; an empty one is not listed, so a clean
right after a clean prints `ok: nothing to clean`; and a results directory
that did not exist is not created.
The command never touches `export/allure-history.jsonl`. This file is beside
`export/allure-results/`, outside that directory. It is the only artifact under
`.nukadoko/` that a new run cannot reproduce.

The repository contains the durable artifacts: feature files and typed steps.

## Review

A person decides whether a change meets its acceptance criteria, and nukadoko
gives that person two things to read: the feature file, and the run
summary (see the run summary under "Records"). The feature says what was
agreed, in the reviewer's own words. The run is the evidence for it, and
the summary states that evidence: these scenarios ran at this commit,
under these conditions, with these measurements, and, under
`nuka run --since <ref>`, these criteria changed, appeared, or went, and
these files behind their steps changed, since the base that was approved,
as far as the comparison under "Running" reaches. nukadoko makes
that claim and no other: it does not decide who approves, and it does
not record the approval. Where approval is recorded is the team's
process, outside nukadoko: a pull request review, a change ticket, or an
audit log can each point at the run by the commit and run id the summary
names, and a later change shows up as a new run with its own "Criteria
since" section.

A green run is a past-tense claim, "these scenarios passed at commit X", and
the summary states it that way: the commit, whether the tree had uncommitted
changes, the environment, the browsers, and the times. It makes no claim
about the software after that commit. This scope prevents the decay of a
requirements traceability matrix, which claims to describe the current
system and drifts with every change.

The ticket needs no link field either. A tag and the free description under
`Feature:` carry the ticket id, its URL, and the criteria in the reviewer's
own words, and the diff shows all of it. nukadoko has no concept of a ticket.
It has no plan subsystem or reasoning field: the feature file and its bound
typed steps answer what would prove the criteria, and the reviewer decides
during the pull request review whether the scenarios express them.

After the change lands, the project chooses the feature's future role. Most
acceptance criteria describe a requested change; once it lands, another run
has no remaining claim to confirm. Such a feature can stay outside
`featuresDir` and be listed in `additionalFeatureDirs` (see "Environments
and secrets"), so static checks keep binding its steps while
nothing runs it unattended, or it can be deleted. Some scenarios describe a
lasting path through the product. Those features move into `featuresDir`,
where `nuka run` selects them on each future commit.

### The acceptance loop

An agent follows this process for a ticket's acceptance criteria:

1. Read the vocabulary: `nuka steps --json`, then `nuka describe <step>`
   for the contract of anything that looks relevant.
2. When an operation is missing, `nuka scaffold <name>`, implement it, and
   exercise it alone with `nuka do` until its step record looks right.
   When the feature is written first, `nuka scaffold --feature <file>`
   writes one stub for each of its lines no step matches.
3. Write the feature. A tag and the description under `Feature:` carry the
   ticket id and the criteria in the reviewer's words; the scenarios are
   those criteria translated into the vocabulary.
4. `nuka check <feature>` (undefined steps, pattern/schema mismatches, a
   Then bound to a mutating step) before anything runs. Pass the path
   unless the directory the feature lives in is listed in
   `additionalFeatureDirs`: a bare `nuka check` walks `featuresDir` and that
   list, so a feature deliberately kept outside `featuresDir` and named
   nowhere else is exactly what it does not reach.
5. `nuka run <feature>` until green. A `<feature>:<line>` run is fine while
   debugging; its summary covers only the scenarios it selected.
6. Open the change for review, such as a pull request. CI runs the
   feature and publishes the run summary beside it (see `docs/ci.md`),
   with `--since <base>` naming the base that was last approved.
7. A person reads the feature and the summary. The run is the evidence;
   where the person records their approval is the team's process.

Steps 1 through 4 contain the work. New typed steps and the feature are
ordinary review material. Steps 5 and 6 are mechanical. Step 7 is the
one judgment nukadoko leaves to a person: whether the scenarios say what the
ticket asked for, and whether the run that the summary describes is the one
that counts.

This loop starts from criteria. An exploration joins it at step 3: the agent
that ran the `nuka do` sequence knows each step and its args, and writes the
scenario from them, keywords and claims included. `nuka check` then reads
the lines back against the vocabulary before anything runs.

## Allure results

`nuka report --format allure` writes one Allure test result for each scenario execution of one finished run.
It reads the run directory alone: run.json, the step records, and `sources.json`, the feature text the run parsed.
A run directory copied off a CI machine therefore renders the same results as the one in the project that ran it.
Such a directory is untrusted input, so every path a record names is resolved, symlinks included, and read only while it stays inside the run directory.
A run of this project's own gets no wider reach: a directory copied into the state directory counts as one, and every file `nuka run` records is inside its run directory.
The files the report opens itself (run.json, `sources.json`, each step's `record.json`, and the run's `exports` manifest) are held to the same rule by their real path, so a symlink among them is not followed out.
A run directory under `<stateDir>/runs/` that is a symlink is refused with `run-invalid`, since every check above takes the run directory as its root. A run directory named by a path outside `runs/` is the caller's choice, and its real target is that root.
A path that leaves is not read: it is a `report-incomplete` finding, and the file it names never reaches the results or the messages stream.
A run.json whose `run_id` is not the one path segment `nuka run` generates (`run-YYYYMMDD-HHMMSS-xxxx`) is refused with `run-invalid`, since the report joins it into paths.
So is a run.json with any field one of the three formats reads missing, null, or of another type: the check covers what all three read, so no format meets a field it has to guess at.
The results use the Allure 2 file format, which Allure 2 and Allure 3 can read.
nukadoko does not render HTML.

`nuka run` writes no Allure results.
Most projects that run nukadoko beside their unit tests read no Allure report, and a run that wrote one anyway left a dozen export files behind for nobody.
Rendering after the run also lets one run be rendered again, in another format or into another directory, without running anything again.

The results go to `.nukadoko/export/allure-results/`, or to the directory `--out` names.
A relative `--out` is resolved against the project root, and an absolute one is used as given.
A missing directory on the way to `--out` is created, since the caller named the path.
Anything else in the way is refused with `report-out-invalid` before the run is read: a directory where Markdown or messages writes a file, a file where Allure writes a directory, a FIFO or another special file, a dangling symbolic link, or a path under a regular file.
`allure-history.jsonl` in the export directory is refused too, in any letter case and through a link to that directory, since a render over it would lose the history for good.
A markdown or messages file the file system refuses to write (under a read-only directory, under `/proc`) is refused with the same code and the error code it gave, such as `ENOENT` or `EACCES`. An Allure directory the file system refuses to write into ends as `report-incomplete`, because its results are written one file at a time.
The refusal names the `--out` value as it was typed, or the default Allure directory when there is no `--out`.
`nuka report` with no run directory renders the newest run; a run directory as its argument renders that run.
When the run is one of this project's runs, each file written under `<stateDir>/export/` is noted in that run's exports manifest, so retention removes it with the run.
Rendering the same run into the same directory again first removes the files the last render of that run wrote there, and their lines in the manifest, so the directory holds one copy of each scenario and the manifest names each file once.
Each result, container, and attachment is named from the run id, the scenario record, and the environment rather than at random, so a second render of the same run overwrites the first wherever it goes: into an `--out` directory outside the state directory, and a copied run into the default directory, too.
A render of a different run adds its results beside the others; whether two runs count as one Allure launch or two is the caller's choice.
`nuka clean` empties `.nukadoko/export/allure-results/`, and a directory written with `--out` outside the state directory is the caller's to remove.
`categories.json` and `environment.properties` are written on every render.
`nuka init --allure` creates the default directory so `allure watch` can start before the first render.

A render writes what it can read and names what it left out.
Each scenario, step record, or attachment it could not read, map, or write is a `report-incomplete` finding of severity `failed`, and the report exits 1, so a script that publishes it does not take it for the whole run.
One missing attachment costs that attachment only; the rest of its result is written.
A step whose step record the run wrote and the directory no longer holds is `broken`, with a message that names the record and the status run.json gives the step, and a passed scenario with such a step is `broken` too: a passed result with no detail would read as complete.
In the messages stream the same step is `UNKNOWN`.
The count `nuka report` prints beside the directory is the results it wrote.

Each result uses the pickle name and stores its Gherkin steps in `steps[]`.
A step name preserves the Gherkin keyword and its AST whitespace, including `And`.
The step entry keeps its status, timing, parameters, attachments, declared logs, calls, and measured child timeline.

The result uses these labels and paths:

- The `feature` label contains the Feature name.
- The `package` label contains the project name and feature path, separated by dots.
- Each inherited pickle tag becomes a `tag` label and retains its `@` prefix, except for two forms.
  A tag `@allure.label.<name>:<value>` becomes a `<name>` label with that value.
  A tag `@allure.id:<value>` becomes an `ALLURE_ID` label with that value.
  Both forms also accept `=` in place of `:`, and neither becomes a `tag` label.
- The scenario result receives all declared labels and links.
- `titlePath` contains the project name, feature directory segments, and Feature name.
- The results leave `parentSuite` and `suite` unset.
  Users who need that hierarchy can add suite labels through declared labels.

`fullName` is `{project}:{feature path}#{scenario name}`.
The SDK derives `testCaseId` from `fullName`.
`historyId` is a deterministic hash of `fullName`, `testCaseId`, and every parameter the scenario result carries that is not marked `excluded`.
The scenario's own name is not a separate hidden parameter: it already reaches `historyId` through `fullName` itself.
The one hidden parameter every scenario result carries for identity is `nukadoko.scenario.steps`, every one of that scenario's own step texts joined in order.
It is `mode: "hidden"` rather than `excluded: true` on purpose: Allure drops an `excluded` parameter before hashing it, which would defeat the whole point, where `hidden` only keeps a parameter out of the UI.
A Scenario Outline row adds each Examples cell as a visible parameter, which also feeds `historyId`.
The visible cells replace the former hidden row parameter and distinguish rows.

Two scenarios can share a Gherkin name, most often as two rows of one Scenario Outline. Without more input to the hash, both would use the same `historyId`, and the second would enter the first scenario's history.
`nukadoko.scenario.steps` closes that gap for a plain scenario, and an Outline row's own Examples cells close it for a row.
What neither can rescue is two scenarios sharing a name *and* every step's own text, with no Examples row to tell them apart: that pair stays indistinguishable, on purpose.
A wrong link is worse than no link, so this identity never guesses past what it can actually tell apart.

This identity preserves a plain scenario's history across the structure change.
A Scenario Outline row starts one new history after the change because its visible parameters change the identity.
`nuka report` does not write the TestOps migration field `_fallbackTestCaseId`.

A step entry has no identity that survives across runs. The Allure step-result model has no `labels`, `links`, or `historyId` field that could store one.
Four ways of computing one anyway were tried before this design: step text (two steps can share the exact same wording), position (an edit anywhere earlier in the feature file shifts it), and counting occurrences (an inserted duplicate is indistinguishable from the original it landed next to).
A line-number scheme made the failure mode concrete: one comment line added at the top of a feature file silently re-pointed every step at its neighbour's history, with nothing on the report hinting that it had happened.
A wrong link is worse than no link, and every scheme tried produced one, so a step entry gets no identity at all: it is read only as one entry nested inside the one scenario result that already covers it.

The `historyPath` setting makes the scenario history visible. It belongs in `allurerc.mjs`, which configures Allure 3, not nukadoko. Without this setting, Allure 3 does not build history for `generate`, `watch`, or `report`, even with a stable scenario `historyId`.
A project with a perfectly stable identity and no `historyPath` still sees no trend, no regressed/fixed transition, no flaky detection, and nothing in the report itself points at a missing config key as the reason.
`nuka init --allure` writes it unconditionally into the `allurerc.mjs` it generates, pointing at `.nukadoko/export/allure-history.jsonl`, kept beside the disposable `allure-results/` directory rather than inside it, so clearing results between runs never discards it.
[`examples/allure/allurerc.mjs`](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) carries the same field for a project not using `nuka init`.
Setting `historyPath` never makes a step entry's own history visible: a step entry has no identity to build one from in the first place.

A team that migrates an existing suite to nukadoko starts new Allure history, trends, and retry tracking. The previous tool computed history with a different `historyId` formula, which nukadoko deliberately does not reuse.
The compat door exists to let a suite move onto nukadoko, not to be where it settles.
Once on nukadoko, a scenario's history starts building fresh from nukadoko's own runs.

A step entry includes its trace, HTTP log, validated result, `record.json`, and declared attachments.
Data tables become CSV attachments named `Data table`.
Doc strings become text attachments, which preserves content that allure-cucumberjs omits.
An Examples table becomes a scenario attachment named `Examples`.
Scenario evidence, such as `final.png`, attaches directly to the scenario result.

Every step entry with a step record includes the complete record as `record.json`, whether the step passed or failed.
It is the same object that reached disk, already redacted there, so nothing here redacts it a second time.
It attaches whole rather than picked apart field by field, on purpose: a field added to `record.json` later shows up in the report on its own, with no change to the mapping needed to carry it there.
The individually mapped fields elsewhere in this section stay too, since a reader who wants one fact should not have to open an attachment to get it; `record.json` is the fallback that keeps the report complete where an individual mapping was never written.

A declared attachment carries a name prefixed `declared:`.
Once everything is sitting in the same result file, that prefix is the one place where provenance (measured by nukadoko versus self-reported by the step) survives.

Declared logs, measured timeline entries, and part calls appear as nested steps under their Gherkin step.

A step entry combines its `sections`, `polls`, and `actions` into one nested child-step timeline (see "Records"). They are merged in ascending `at` order.
Two entries that land on the exact same millisecond keep a fixed order, sections before polls before actions, so a rerun of the same step record never reshuffles the timeline into an unreadable diff.
A section renders as a zero-width marker named after its own label.
A poll spans its own start through `waited_ms` later, named `<description> (<attempts> attempts)`: the duration alone cannot tell a wait that resolved on the first attempt from one that took forty, and the count is the one fact only the name can carry.
A poll's own outcome sets the child step's status: `resolved` is passed, `timed_out` is failed (the condition it waited for was never met, the step's own contract not holding), `failed` is broken (the poll's own callback threw, unrelated to whatever it was waiting for).
An action spans its own start through `ms` later, named after its own `method` plus, when the call carried one, its `selector` or `url` (e.g. `goto /orders`); an `expect` call is named with its matcher and target instead (e.g. `expect #late to.be.visible`, with `not` folded in for a negated assertion), since neither is implied by `method` alone the way a `goto`'s own target is implied by `url`.
Neither `ms` nor `timeout_ms` ever lands in the name: `ms` is already visible as the child step's own width, the same reason `page_events`'s observed counts stay off step names too, and `timeout_ms` stays in the `record.json` attachment.
When `actions` itself was capped at 100 entries (see "Records", `truncated.actions`), the timeline gets one more child step at its own tail, zero-width and passed, naming the cut (e.g. `... 4113 more actions not shown`), so a reader scanning only the timeline never mistakes a capped list for everything that happened.
Never clamped to the parent step entry's own start/stop range: a timeline entry outside that range already happened, and hiding it would make it unreadable rather than making it not true.

`page_events` becomes up to three parameters (see "Records"): `console errors (observed)`, `page errors (observed)`, and `failed requests (observed)`. It adds a parameter only when that category has an entry, so readers can see the count without opening `record.json`.
A category the collector truncated reports its true total beside the shown count, e.g. `100 of 4213`: the shown count alone would understate what actually happened.

A step entry's parameters carry its declaration and what was actually observed side by side: `mutates (declared)` next to the measured `http reads (observed)` / `http writes (observed)`, each `not observed` when the step reached no HTTP channel (and, for a compat step, `world reads (observed)` / `world writes (observed)`), not because the two are checked against each other automatically, but so a reviewer can.
The declaration is what nukadoko trusts and acts on, the observed counts are what actually happened, and this row is where the two sit close enough to compare by eye.
The observed side is an HTTP-method proxy, not a semantic judgment (see "Keyword semantics"): a row can show a truthful `mutates (declared): false` next to a nonzero `http writes (observed)` when the step called a POST-based read, and that is the proxy showing through the table, not either number lying.

A failed scenario puts `[nukadoko.failure=<kind>]` in `statusDetails.message`.
It writes the original error message in `statusDetails.trace`.
The marker names the same `error.kind` a failed step's step record (or, when a hook stopped the scenario, that hook's own record) already carries, and the same `error.kind` is also written as a `nukadoko.failure` result label.
The two Allure generations turn that into a category by different paths, and they need different things from a user.

- **Allure 2** has no category field for each result, so `nuka report` also writes `categories.json` on every render.
  It contains all seven rules, one for each `error.kind`, and matches the message prefix by regular expression.
  The message prefix and category rule represent the same classification, so users do not need extra configuration.
- **Allure 3** does not read `categories.json` from a results directory during `allure generate` or `allure report`.
  Allure 3 gets categories only from its configuration and matches them against result labels.
  `nukadoko.failure` supplies that label.
  `nuka init --allure` writes `allurerc.mjs` at the project root with seven label-matcher rules, one per `error.kind`, built from `NAME_BY_KIND` (`src/report/allure/categories.ts`) so the names can never drift from the ones the results themselves use.
  Dropped at a project's root it is picked up automatically (Allure 3 auto-detects `allurerc.{js,mjs,cjs,json,yaml,yml}` from the current working directory, no `--config` flag needed).
  `nuka init` checks all six extensions first and writes nothing, naming the file it found on stderr, when a project already has one.
  Without any of them, every nukadoko failure lands in Allure 3's one built-in "Product errors" category instead.
  A project not using `nuka init` can still copy [`examples/allure/allurerc.mjs`](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) by hand.

Before and After hooks share one scenario-scope Allure container.
Each hook becomes a fixture with its trace, attachments, and child timeline.
A hook's own trace and `actions` attach to that hook's own fixture, mapped the same way a step entry's are: the trace as an attachment named `trace`, `actions` merged into the fixture's own child-step timeline through the same merge described above.
A hook carries no `sections`/`polls` of its own, since it has no fixture bag to call `section`/`poll` from; only its trace-derived `actions` still render.
A hook invocation that never touched `this.openPage()` gets neither: no trace attachment, no timeline entries, the same "nothing to show" a step entry that never touched the page already gets.
A Before hook failure makes the scenario result failed and leaves each planned Gherkin step skipped.
BeforeAll and AfterAll still have no run-level record that the results can map.
Hook duration still uses scenario boundaries because scenario records do not contain per-hook timestamps.

Every file lands through a temp-file rename, so a reader such as `allure watch` never sees a half-written result.
A run's results appear when `nuka report` renders it, after the run; the live view of a run in progress is the progress output `nuka run` prints on stderr.

Ad-hoc `nuka do` records stay outside the dashboard.
An exploration becomes reportable when a feature records it, `nuka run` executes that scenario, and `nuka report` renders the run.

Allure displays each run; nukadoko has no web UI.
History, trend, and flakiness are Allure features too; per the identity paragraphs above, these results feed them at scenario grain, once `historyPath` is set, and never at step grain: nothing about a later invocation links a step entry back to an earlier invocation's, only a scenario does.

Not yet built: link-template configuration for tags such as `@issue:123`.

The point is not format politics: a classic cucumber run fills an Allure report only where glue authors hand-attached evidence, while nukadoko's harness measures everything anyway, and Allure's own model (attachments, labels, parameters) already had a first-class place for all of it.
The Allure results are where nukadoko's measurement surplus becomes visible; the messages stream below is the second, narrower output, and its job is compat fidelity rather than measurement surplus.

## Messages stream

`nuka report --format messages` writes one finished run as one cucumber
messages stream through `@cucumber/messages`: NDJSON, one envelope per line.
It goes to stdout, or to the file `--out` names. A relative `--out` is
resolved against the project root, and an absolute one is used as given.
Like the Allure results, the stream is rendered from the run directory
alone, after the run, and `nuka run` writes none. A scenario's own
screenshots and its hooks' traces have no envelope in the stream, so it
never reads them, but a path among them that resolves outside the run
directory is a `report-incomplete` finding, as it is in the Allure
results. A file written under the
`<stateDir>/export/` for this project's own run is noted in that run's exports
manifest, so retention and `nuka clean` remove it with the run.

- One render is one stream of one run. Two runs never share a stream, and
  the stream never changes after it is written, so there is no partial
  stream for a reader to see. Watching a run live is the job of the
  progress output on stderr, not of this stream.
- `meta` names the nukadoko version that ran the scenarios, and
  `testRunStarted` and `testRunFinished` carry the run's own start and
  finish, as run.json records them. Rendering the same run twice gives the
  same stream apart from its ids.
- cucumber-messages has no field for the environment a test case ran
  against. A run over more than one environment (`--env a --env b`)
  therefore gives each pickle one copy per environment, with fresh ids and
  the environment in parentheses after the name (`checkout (staging)`), the
  same way an Examples row gets a pickle of its own. A run over one
  environment keeps the pickles as parsed. A JUnit report built from the
  stream with `@cucumber/junit-xml-formatter` shows that name only for an
  Examples row (`a cart with items - #1.1: a cart with items (staging)`):
  the formatter names a test case from the Gherkin scenario rather than
  the pickle, and prints no pickle tag or property, so the format leaves
  no field it prints for the environment of a plain Scenario. Such a
  Scenario run in two environments is two test cases of one name, in the
  order `--env` named the environments. A CI job that reads JUnit and
  needs to tell them apart runs one environment per job, or reads the run
  summary or the Allure results, which name the environment. Each `--repeat` execution of one
  pickle in one environment is a test case of its own, with `attempt` 0
  and `willBeRetried` false, since every execution counts toward the cell.
  The retry shape, one test case with `willBeRetried` on all but its last
  attempt, is refused: a reader such as `@cucumber/query` keeps only the
  last attempt, so a red execution followed by a green one would read as
  green.
- This stream has the inverse role of the Allure results. Allure exposes
  nukadoko's measurement surplus, while this stream preserves compat
  fidelity. Its only job is to ensure that a migrated suite's existing
  formatters and JUnit-based CI keep reading a nukadoko-produced run the
  way they read a classic cucumber-js one.
- Step record internals do not enter the stream. This excludes the validated
  result, `mutates`, `observed` counts, `error.kind`, and `calls`.
  `TestStepResult` and
  `TestStepFinished` are closed schemas (`additionalProperties: false`)
  with no field for any of them, and there is no smuggling them in through
  a marker the way Allure's own `[nukadoko.failure=<kind>]` label does.
  `calls` carries a second reason on top of that one: this format has no
  step inside a step, so a part would have no shape to take here even if
  the schemas were open (see "Parts"). Allure nests one because Allure's
  own model does.
- Attachments contain only what a step declared about itself: `declared`
  attachments and log lines. Log lines use cucumber-js's
  `text/x.cucumber.log+plain` media type (the one `this.log()` produces).
  Trace, screenshots, the HTTP log, and the validated result stay
  Allure-only: that measurement surplus already has a home, and
  base64-embedding a trace here would bloat the stream for no consumer
  that wants it.
- A step has the same start and stop here as in the Allure report of the
  same scenario record. A step with a step record keeps that record's
  `started_at` and `finished_at`. A step with no step record (skipped,
  undefined, ambiguous, or refused before it began) has no time of its own,
  so both formats place it zero-width at the previous step's stop, or at
  the scenario's `started_at` when it comes first. That anchor is read from
  `record.json` alone, so a report built from the record after the run
  gives the same timeline.
- `testRunFinished.success` always matches the run's verdict.
  BeforeAll/AfterAll have no place to write into this stream (no
  run-scope record exists to draw from), so a run whose
  run-scope hook failed shows up only here, never inside any one
  scenario.
- A real consumer confirms the stream's behavior, beyond its internal
  consistency. Passing the stream through
  `@cucumber/junit-xml-formatter@0.14.0` (which drives `@cucumber/query`
  over the envelope stream) throws nothing, and every id it needs to
  resolve (pickle to testCase to testStepFinished, `pickleStepId` back to
  the gherkin step) does resolve. A failed scenario's `<failure>` carries
  the step's own error message, `<system-out>` carries a per-step
  passed/failed/skipped trace, and `<testsuite tests="...">` matches the
  real scenario count; `<failure>` itself gets no `type` or `message`
  attribute, because `TestStepResult.exception` is never set (below).
  Only the junit-xml path has been run this way: an official HTML report
  or a third-party formatter has not been exercised against this stream,
  so what's confirmed is that this is a well-formed cucumber messages
  stream a real consumer reads without error, not that every existing
  formatter renders it.

Honest limits, named rather than hidden: hooks collapse to one generic
Before and one generic After, because one Hook envelope is shared by every
hook of that type (a stored `name` titles the Allure fixture, the
run summary's failing hook, the trace chunk, and the failure message, and is not
that envelope's name); a hook's own duration is always zero,
the same limit the Allure results carry; `declared` labels, links, and
parameters have no slot in the protocol's closed schema and are dropped;
no `stepDefinition` envelope is emitted, because the record keeps no
location for a step's own definition and emitting one anyway would be a
fabricated fact; and `TestStepResult.exception` is never set, since the
protocol requires `Exception.type` and a step record only ever carries a
message: the reason a failed step's JUnit `<failure>` is body-only.

## Self-healing, audited

When an application change makes a scripted scenario stop matching
reality, use this repair loop:

1. An agent uses `nuka do` to run the goal adaptively, one step at a time.
   The agent reads each step record before it chooses the next call.
2. The step records capture the sequence that worked, including its
   differences from the scripted scenario. They describe the repair but do
   not prove it. The agent can cite this sequence in the PR.
3. The PR updates the typed steps, the feature file, or both. A green run of
   the repaired scenario supplies the proof through its scenario record and
   step records. Reviewers inspect those records like any other change.
   Attestation always passes through a scenario, not an ad-hoc sequence.

nukadoko records every stage. The bundled agent skill supplies the authoring
workflow; the engine does not repair scenarios by itself. Without an audit
trail, self-healing can silently remove what a test suite checks. The
deviation record prevents that loss from staying hidden.

## Tending

`nuka check` answers one question: can this project run right now. A
project can pass every check and still rot. A declaration can remain
unexercised for years. A
contract can be unreadable to the agent that must select it. These problems
do not stop a run, but each becomes more costly with time. This failure mode
gives the tool its name: a nukadoko matures with daily tending and dies from
neglect.

`nuka tend` answers the other question: are this vocabulary and its records
still healthy.

`nuka tend --codes` lists every code a tend finding can carry, each with a
one-line description and the code's general `do`; with `--json` it prints the same list as JSON, under
`codes`.

It is a separate command, rather than another set of `check` warnings,
because the two commands are read at different times and have different meanings.
`check` runs before every run, in CI, inside an agent's loop, and every
line it prints is something standing between the project and a green run,
so each finding must be worth stopping for. Tending findings are different:
nothing here must be fixed today, and if these findings appeared
on every `check`, they would teach everyone to skim past the line that
did have to be fixed. Noise is not a cosmetic problem in a tool whose main
claim is that users should read its checks.

Before listing findings, `tend` prints three summary lines that show the
bed's current state. None of the three is a finding, and none changes the exit
code (a suite in the middle of a migration is in a normal state, not a
faulty one, and warning about it every time would drown the findings that
do need acting on):

- `scanned:` names every directory that this run inspected:
  `featuresDir` plus each `additionalFeatureDirs` entry (see "Environments
  and secrets"). Printed first, because a count means nothing
  until the reader knows the scope of the count.
- `bed:` shows how much of the vocabulary is typed instead of compat,
  and how many typed steps declare `mutates: false`
  (read-only).
- `declared:` shows how many schema fields of typed steps carry a
  `.describe()`. Each field without one is also a `schema-field-undescribed`
  note.

Under `--json`, the same summary is the `summary` object, in snake_case
like every other document nukadoko prints: `typed_steps`, `compat_steps`,
`compat_step_names`, `read_only_steps`, `scanned_feature_dirs`, and
`describe` as `{ declared, total }`.

This summary exists because the information was already available but unread. A step
record's `world` and `declared` counts do shrink as a suite promotes, which
is accurate but useless for showing progress: nobody reads a directory of
step records to calculate how far a migration has progressed. Stating it once in the
command devoted to the bed's health makes the information visible.

The following findings show what `tend` inspects and why each item is rot rather than style:

- **A `from` declaration that nothing exercises.** Every occurrence of the step
  across every feature captures that key from the line, so the declared
  producer never supplies anything. Reported as the fact it is (the
  declaration may still be reached through `nuka do --use`), not as a
  instruction to delete it.
- **A step whose pattern no feature binds.** A step intended only for
  the CLI should have no pattern at all; one that has a pattern is
  claiming a place in a scenario it does not occupy. The note's `file`
  names the step file, relative to the project root. `nuka check` and
  `nuka run` name the same steps at the end of an `undefined-step`
  message, because a renamed sentence or pattern leaves one line undefined
  and one step unbound at once. They judge it on the same scanned
  directories `tend` reads, also when a target selects fewer files, so a
  step bound in a file the target left out is never called unbound, and
  the message for one line does not change with the target.
- **A schema field with no `.describe()`.** This is the tending finding
  specifically for the agent: `nuka describe` is how an agent learns what
  a field means, and a field with no description tells it nothing a name
  did not already. Human readers of the step file can see the surrounding
  code; the agent choosing between two steps cannot. An args field that
  `from` fills counts as described when every producer it names describes
  that `returns` field: the agent never writes that value, and `nuka
  describe` names the producer whose field explains it. Repeating the
  sentence on every consumer would only make copies that drift.
- **A step whose description is still the scaffold's TODO**
  (`step-description-todo`). `nuka scaffold` without `--description`
  writes `TODO: describe <name>`, which imports, binds, and runs, so
  nothing else reports it, while `nuka steps` and `nuka describe` show it
  to whoever picks a step. The note matches that literal prefix only, so
  it claims exactly what the scaffold wrote and nobody replaced. It is a
  note and not a `check` finding, because the step runs as it is.
- **A configured parameter type that no pattern uses.** This is dead
  configuration, reported like any other.
- **A `defineParameterType` still registered in support code.** It continues
  to work, and `config.parameterTypes` is its typed-era home; moving the
  registration changes no match. A registration that sets
  `preferForRegexpMatch` is the exception: config rejects the key, so the
  note says to keep it in support code while a RegExp step relies on it.
  This one used to be a `nuka check`
  warning, but that classification was wrong: it appears for as long as a suite has any
  compat left, which is a normal state to be in, and printing it before
  every run trains people past the lines that do stop a run.
- **A `secrets.public` or `secrets.redact` entry that names a key no envFile
  defines.** The instruction is real but reaches nothing: configuration that has
  drifted from the files it describes. Also moved from `check` for the same
  reason: nothing about it changes whether this run should happen. Its
  neighbors stay on `check` and are worth the contrast: a `redact` entry
  whose value is too short to be redacted, and a tracked env file with a
  secret-looking key, both mean plaintext reaches a log the moment the run
  starts, which is exactly something to know beforehand.
- **A `package.json` with no `"type"` that governs a `.ts` or `.js`
  file nukadoko loads** (`package-type-missing`). Node reads such a file
  as CommonJS, finds ES module syntax, parses it again, and prints a
  `MODULE_TYPELESS_PACKAGE_JSON` warning, on every load of every such
  file. The governing file is the one Node uses, the nearest `package.json`
  above the file. The note names it and the fix: `"type": "module"`, or
  `.mts` names when the project's own `.js` files are CommonJS. It is a
  note, because the run works.
- **A configured `additionalFeatureDirs` entry that is absent from
  disk.** It exists specifically to widen what `nuka check`/`nuka tend`
  scan, so an absent directory is a config mistake to report, the same way
  a missing `featuresDir` is, except every `tend` finding is a note, so
  this is a note here even though
  `nuka check` reports the identical fact as an error.
- **Scenarios that begin with the same steps, and what the repetition
  cost.** A shared opening is ordinary: several scenarios about one page
  reasonably start by getting to that page. It turns into rot when the
  opening is expensive and nothing has been lifted out of it, because the
  cost grows with every scenario added. This finding is measured rather
  than read off the feature files. It groups the scenarios of the most
  recent run that wrote its `run.json` by their leading step text, reads those steps' own
  records for what each took, and names the group, its steps, and the
  total. One finding per family, so one nested group is never counted
  again at three depths. The depth it names does not depend on timing: the
  opening that covers the most step executions (scenarios times shared
  steps), then the longer opening, then the one that comes first in the
  feature files. Ranking by time named a different opening from run to run
  on a fast suite, where the differences were noise. Two
  gates keep it quiet: two scenarios at least, and at least 2% of that
  run's summed scenario time. That floor came from measuring a real
  suite, where it removed exactly the groups whose cost rounded to zero
  and gave up 0.2 of the 101.5 seconds the finding otherwise named. The
  denominator is summed scenario time rather than wall clock, so this
  reads the same at any `--concurrency`. A run still in progress has no
  `run.json` yet, so the finding reads the newest run that ended. A
  scenario that ran more than once in that run (`--repeat`, or more than
  one `--env`) counts once, as its last execution. It
  stops at the number. What to do about a shared opening depends on
  whether its steps write state a later scenario reads, and the step
  records carry each step's own `mutates` declaration. When every shared
  step declares `mutates: false`, the note names the place a lift goes: a
  `process`-scope fixture (see "Fixtures"). When one does not (it declares
  `mutates: true`, is a compat step with no declaration, or has no step
  record), the note names that step and says a `process`-scope fixture
  would share what it writes between scenarios. Following that advice on a
  writing opening broke two of seven scenarios in a measured HTTP API
  project. Naming a saving would be claiming the lift is possible, which
  nothing here measured.
- **A step whose trace shows another call soon after a navigation
  call.** `tend` reads this from the tool's step records under
  `.nukadoko/runs/<run_id>/steps/` and `.nukadoko/do/` (see "Records"), so it reaches every step
  that still has a step record on disk. For each `goto`, `reload`, `goBack`,
  or `goForward` in that step record's own `actions`, the gap to whatever
  call the step made next. A read that lands inside the same step
  record's own `poll` window is left out: a step written to `poll()`
  the way the doctrine in "Context API" already asks for is retrying by
  construction, not the thing this note exists to tell apart from it. What
  is reported is only the gap itself, never a verdict: how long a page
  takes to render after a navigation is nothing this tool measures, and no
  table of which Playwright calls auto-wait is built to guess at it, since a
  table like that would describe a dependency's own semantics rather than
  something this tool measured, and go stale the moment that dependency
  changed. A step record with no `actions` at all, whether because the
  step never touched the browser or because it predates that field,
  silently remains out of scope and is not an error.

This last finding most clearly explains why the whole list belongs to
`tend` and not `check`. The step it names already ran, and its own step
record already measured that execution; nothing about it is broken today,
and no run is blocked by it. What changed is only that the tool can now
see a fact about how that execution went, not that the execution stopped
being real. `check` exists to answer whether a run can proceed right now,
so a step that already ran has nothing left for it to say; `tend` exists
to answer whether what already ran is still healthy, and "has not yet lost
a race it happens to be running" is exactly the kind of health that
question is for. Reporting this as an error would treat a symptom that has
not appeared as if it had.

Findings support `--json`, like the other output. Every finding is a note,
and a note does not change the exit code, because a project is allowed to
carry them. `--fail-on <code>` (repeatable, or
comma-separated) makes one invocation exit non-zero when a finding with
that code is reported, and says so on stderr. The finding itself stays a
note in the output: what changed is the team's policy for that job, not
the finding's nature. A code `tend` never reports is refused up front, so a
typo cannot become a flag that never fires. A code an earlier release
reported, such as the sign-off codes that went away with the `accept`
command, is refused by name, with what replaced it (see
`docs/upgrading.md`). An unknown code's refusal points at `nuka tend
--codes`, which lists every code. This is how a PR job gates on `pattern-unbound`
without `tend` turning red for everyone else.

Every run reports every code. No code is held back for a flag: every
tend finding is already a note that leaves the exit code alone, so a
default-off code would only save output, and it would cost a gate that
reads plain `--json` the findings it never sees. A team picks what gates
with `--fail-on`, not by what a plain run prints.

`tend` reports but does not repair. Repair means writing a description,
deleting a step, or moving a feature: decisions with an author behind
them.

## CLI summary

The npm package is `nukadoko`. The one command it installs is `nuka`.
`nuka --help` ends by naming `node_modules/nukadoko/llms.txt`, the file an agent with no skill loaded reads first.

```
nuka run [<feature[:line]|dir>...] [--no-check] [--env <name>]...
                              check, then execute scenarios (featuresDir when
                              no target is given). An error nuka check reports
                              for the selected scenarios stops the run before
                              anything executes (exit 2, no record);
                              --no-check skips that check. Step records, plus the Allure
                              and messages exports their config keys turn on.
                              --env targets a named environment ("default"
                              when omitted); repeated, it runs every selected
                              scenario once in each, in order, in one run
                              with one verdict per scenario and environment.
                              :line runs one scenario, for iteration only;
                              its summary covers only that scenario. Each target
                              can be a file, file:line, or directory. Targets
                              form one deduplicated set in deterministic byte
                              order and one invocation: one run_id, one
                              summary, one exit code, one messages stream, and
                              one Allure results tree. :line on a directory is
                              refused, and a
                              directory with no .feature file outside
                              node_modules and dot-directories fails setup,
                              naming what it walked. That skip reports
                              nothing. stderr
                              gets per-step/per-scenario progress as it runs,
                              then every location this run wrote and a summary
                              line. A failed step's line is followed by its
                              error's first line (and an expect's Locator,
                              Expected, Received, and Error lines), a used line
                              for each step
                              it read from whose process exited nonzero
                              (its exit code and first stderr line), and its
                              step record path.
                              Each failed scenario follows the summary with
                              its feature, line, and name, then a rerun
                              line (nuka run <feature>:<line>). Then one retention
                              line, when a run older than the newest
                              retention.runs was removed (see "Artifacts").
                              --json drops every one of these lines, and
                              warnings go into run.json's findings.
                              stdout is empty unless asked: --records
                              prints NDJSON, each scenario's run.json
                              entry, on a terminal or not. --json prints
                              run.json (commit, environments, selection,
                              counts, verdicts, each scenario's steps with line,
                              status, record, and error, each failed
                              scenario's do, the findings) as the one
                              document on stdout instead; run.json is
                              written to runs/<run_id>/ either way. Text project code (a step, a hook, a
                              fixture) writes through console.log or
                              process.stdout.write is delivered on stderr.
                              --concurrency <n> (default 1) hands whole feature
                              files to n worker processes while the parent
                              keeps one run_id, one run.json, one summary,
                              and one exit code.
                              Above 1, stdout lands in completion order and the
                              progress lines are held per scenario. A file
                              tagged @nukadoko:serial runs while no other file runs.
                              --repeat <n> (default 1) runs every selected
                              scenario n times in this one invocation, each
                              execution its own record under the one run_id;
                              a scenario that failed at least once gets a
                              repeat line after the failed list.
                              --probe re-runs each read-only Then right after
                              it passes, with one capture, its table, or its
                              docstring changed, and notes
                              one that still passes
                              (then-passed-with-changed-capture) or that it
                              could not measure (then-probe-not-measured);
                              the exit code is unchanged.
                              --since <git ref> compares each scenario's
                              criteria (tags, steps with their effective
                              keyword, docstrings, tables, its Examples row)
                              and the files that register its steps, their
                              parts, and the fixtures they need with the
                              commit the ref names: criteria.changed_since is
                              unchanged, changed, new, ambiguous, or unknown,
                              since lists the removed criteria and the step
                              files that changed, and the summary quotes what
                              moved. It reports only. An unknown ref
                              (since-ref-unknown), a project outside git
                              (since-outside-git), or another git failure
                              (since-git-failed) is refused.
                              Every run writes a Markdown run summary to
                              runs/<run_id>/summary.md and appends it
                              to $GITHUB_STEP_SUMMARY when set, and writes
                              no export file
nuka report [<run dir>] --format markdown|allure|messages [--out <path>] [--json]
                              render one finished run from its run directory
                              alone (markdown: run.json; allure and
                              messages: run.json, the step records,
                              sources.json); with no run dir, the newest
                              run. markdown: the run summary, on stdout or
                              to --out; allure: an allure-results directory,
                              .nukadoko/export/allure-results or --out;
                              messages: a cucumber-messages NDJSON stream, on
                              stdout or to --out. Files written under
                              <stateDir>/export/ leave with the run, and a
                              second render of the same run there replaces
                              the first; no other file is noted. --json prints {run_id, format, written}
                              and needs --out for markdown and messages.
                              A run directory with no run.json is refused
                              (run-not-found), one whose run.json is not
                              one this release reads (run-invalid), and,
                              for allure and messages, one with no
                              sources.json (run-sources-missing) or one
                              whose sources.json is corrupt or of another
                              version (run-sources-invalid). A
                              render that left out part of the run exits
                              1 with report-incomplete. A missing
                              directory on the way to --out is created;
                              anything else in the way is refused
                              (report-out-invalid)
nuka do <step> [--args '<json>'] [--use <step-record-id>] [--env <name>]
                              execute one typed step; step record to stdout.
                              --env as on nuka run; each call starts clean.
                              Text the step or its fixtures write through
                              console.log or process.stdout.write is
                              delivered on stderr.
                              --args is required unless --use supplies
                              every key; --use fills its `from` keys
                              from an earlier execution's result
nuka steps [--json]           list the whole vocabulary, typed and compat:
                              name, file (the step file, relative to the
                              project root), patterns, description, mutates, timeout
                              when the step declared one, which
                              fixtures each step needs (needs, needs_browser,
                              or needs: null plus needs_error for the one it
                              can't read), and where each chained args key
                              comes from (from, or from_errors naming the
                              key and why for the one it can't read);
                              --json prints the envelope with steps beside
                              findings; a step file that failed to import
                              is a step-file-import-failed finding, exiting
                              1 if there is one or
                              any step's needs_error or from_errors is
                              present, output printed either way, and
                              under --json each such part is a
                              contract-unreadable finding naming the
                              step. Text
                              wraps at 80 columns, in a terminal or not
nuka describe <step>          full contract, the step file as file,
                              schemas as JSON Schema, plus
                              timeout when the step declared
                              one, plus
                              the envelope's findings beside it (the same
                              findings as nuka steps'). When args or returns cannot be
                              represented as JSON Schema, that side is null
                              and args_error or returns_error names the step
                              and why; the rest of the contract is still
                              printed. Exits 1 when a step file did not
                              import, or when the described step is typed
                              and carries its own needs_error, from_errors,
                              args_error, or returns_error, each also a
                              contract-unreadable finding naming the
                              step. A broken sibling step
                              elsewhere in the vocabulary does not fail it
nuka scaffold <name> [--pattern <text>] [--then | --command [<entry point>] [--cwd <key>] [--argv <key>] | --request "<METHOD> <path>" [--body <key>]] [--from <step>.<key>]... [--description <text>] [--replace]
                              typed step template that fails until
                              implemented; the thrown message names the
                              args it was given, so the file compiles
                              under noUnusedParameters. --pattern writes
                              the pattern and one args field per
                              {key:type} capture, and
                              refuses a pattern check would refuse in
                              this project, a type it does not register
                              included, with the registered type names.
                              --then writes mutates: false and no
                              returns, for a step a Then line binds.
                              With exactly one capture and at most one
                              --from, its body asserts instead of the
                              stub: node:assert/strict compares actual
                              (the --from value, or undefined under a
                              TODO) with the capture, and the message
                              is "<key>: expected <value>, got
                              <actual>"; a custom type compares with
                              deepEqual. A chained stdout or stderr
                              string loses one trailing newline before
                              the comparison, the one a program prints
                              last. When every feature line the
                              pattern matches carries a docstring, args
                              gets docstring: z.string(), and for a
                              table, table: z.array(z.array(z.string()));
                              --then compares it as it would a capture.
                              With no such line, or lines that disagree,
                              the key is left out. --command never gets
                              one.
                              --from (repeatable) chains one key of an
                              earlier step's returns: the import of that
                              step's file, an args field typed by its
                              schema (producer.returns.shape.key), the
                              from entry, and the key in run. It refuses a
                              producer that does not return the key and
                              names the keys it does return. The same key
                              given for several steps writes one from
                              entry listing each as a candidate producer;
                              their schemas for the key must have the same
                              JSON Schema, descriptions aside, and the
                              args field reads the first one's. --command
                              writes a When step that runs a program
                              instead of the stub:
                              runCommand(process.execPath, [cli,
                              ...captures], { cwd: scratch.dir() }),
                              returns exitCode, stdout, and stderr (so
                              --from can chain them at once), and
                              const cli = resolve("<entry point>"), the
                              value given, relative to the working
                              directory; a value that is not a file
                              there is refused, and a step name read as
                              the value (--command before the name) is
                              named as such. A .ts, .mts, or .cts entry
                              point is refused when one of its own static
                              imports names a relative .js (.mjs, .cjs)
                              file that is absent while its TypeScript
                              sibling is present: the step runs it with
                              node, which does not rewrite the specifier. Without a value that line
                              holds a TODO, and run throws "fill in the
                              entry point: <file>:<line>" before it calls
                              runCommand, so do and run fail by name at
                              that step while check still passes.
                              --command with --then is refused. A
                              --from key is never argv: it is the
                              program's context, so until it is placed
                              (an env variable, a flag, or --cwd) run
                              throws "pass <keys> where the program reads
                              them: <file>:<line>" with the values.
                              --cwd <key> (with --command) runs the
                              program in the directory that args key
                              holds, { cwd: <key> }, instead of
                              scratch.dir(), and leaves the key out of
                              argv; the key must be a capture or a --from
                              key whose schema is a bare z.string().
                              --argv <key> (with --command) splits that
                              string capture into argv elements on
                              whitespace only, with no quoting rule:
                              ...<key>.split(/\s+/) without empty
                              elements, and the description says so. A
                              key that is no string capture is refused,
                              and the do: line names one that is. The
                              step writes mutates: true, the default,
                              under a comment that says to set it to
                              false when the program changes nothing
                              outside a scratch directory.
                              --request "<METHOD> <path>" writes a When
                              step that sends one request through
                              Playwright's request fixture, unwrapped:
                              request.fetch(path, { method }), resolved
                              against baseURL, returning status
                              (response.status()) and body (the response
                              text). Each {key} in the path is that args
                              key's value, inserted as it is; a {key} no
                              capture or --from fills, and any other
                              brace, is refused. --body <key> sends that
                              args key (a capture, a --from key, or the
                              docstring) as data. A value the request
                              does not read throws "pass <keys> where the
                              request reads them: <file>:<line>" until it
                              is placed. It writes mutates: true under a
                              comment: the method is only a proxy for
                              write semantics. --request is refused with
                              --then or --command, and --body without
                              --request.
                              --description writes the step's
                              description; without it the description
                              is "TODO: describe <name>" (with
                              --command, a sentence about running the
                              program), which tend reports as
                              step-description-todo. A file already at
                              the step's path is refused. --replace
                              overwrites it only while it is, byte for
                              byte, what scaffold writes today for that
                              name and path under some set of options:
                              the options are read back from the file
                              (pattern, description, entry point, cwd,
                              --argv key, imports, from entries), and
                              the variant, the attachment, and each
                              chained value's class are tried every way.
                              Any other file is refused with rm in its
                              do: line. Without --replace, such a file's
                              refusal names this same command with
                              --replace
nuka scaffold --feature <path>
                              one stub for each line nuka check <path>
                              reports as undefined-step, so a sentence is
                              typed once, in the feature. The pattern is
                              the line as cucumber-expressions' generator
                              reads it over the project's registry: a
                              quoted literal becomes {value:string}, an
                              integer {value:int}, a decimal
                              {value:float}, keyed value, value2, ... A
                              Then line (and its And/But) gets --then's
                              mutates: false, and with one capture
                              --then's assertion body. A line with a
                              docstring gets a docstring: z.string()
                              key, and one with a table a table key of
                              rows, which a Then compares. The name is the pattern's
                              literal words in kebab-case, with -2, -3
                              added past a name the project already
                              holds; lines that read as one pattern share
                              one file. When the line reads more than one
                              way (a registered type against a built-in),
                              or the reading would also match another
                              line of the project, the pattern is the
                              line as written with no capture, and a
                              "note:" line on stderr says so. An outline
                              line whose Examples rows read as different
                              patterns gets no file and a note. Prints
                              each written path on stdout, then on
                              stderr a "next:" line and, for each stub,
                              nuka scaffold <name> --pattern <pattern>
                              [--then] --replace: the single scaffold
                              that writes that stub again byte for byte,
                              left out for a stub it would write
                              differently. Refuses while
                              a step file does not import, and takes no
                              name, --pattern, --then, --command, --from,
                              --cwd, --argv, --request, --body,
                              --description, or --replace
nuka check [feature..] [--json]
                              static checks: pattern/schema mismatches, Then
                              binding to mutating steps, undefined steps per
                              feature (each naming the patterned steps no
                              scanned feature line binds), ambiguous steps (one line two patterns
                              both match), duplicate patterns, a pattern
                              that captures the same key twice, a required
                              args key nothing on that line could fill, a
                              required `from` key whose producer is absent,
                              bound later in the scenario (held back while
                              an earlier line matches no step), or
                              ambiguous between two producers, a `from`
                              naming a step discovery never registered, a
                              fixture
                              dependency cycle, a process-scope fixture
                              depending on a scenario-scope one, a page
                              override that owns none of page, context, and
                              pageAs,
                              config coherence, unreadable step files
                              (reported, not fatal, the rest of the project
                              is still checked), a `.cjs` or `.cts` file discovery
                              walks but never imports, a featuresDir scan
                              that found nothing loadable, unsupported hook
                              tag expressions, a compat hook or step declaring more
                              parameters than nukadoko passes (read as a done()
                              callback), a step whose patterns bind different key
                              sets, a table or docstring with no single args key
                              left to fill, a pattern that is unnamed, unterminated,
                              has an invalid capture key, a syntax error, or an
                              unregistered or duplicate parameter type, an
                              undefined-step finding held back until such a cause
                              is fixed, a feature that does not parse, a
                              scenario outline with no Examples row that runs,
                              warnings for a scenario with no Then and for an
                              outline with several rows and no <column> in its
                              name, a
                              fixture that destructures a name nukadoko does not
                              know, a step whose `parts` form a
                              cycle, declare `mutates: false` over a part that
                              mutates, or name something that is not a registered
                              step, a `@nukadoko:serial` tag on a Scenario line (it
                              is only read from the Feature line), a compat step
                              bound in Then position, an envFile that is missing or
                              has an unreadable line, a tracked envFile key that
                              looks secret but is not in secrets.redact, a
                              secrets.redact key too short to redact; with no
                              target, scans featuresDir plus
                              additionalFeatureDirs;
                              targets select files the way nuka run's do
                              (several files, a directory walked for .feature
                              files), so the errors
                              nuka run prints before executing equal nuka
                              check's for the same targets. :line is refused,
                              since check analyzes whole files. A path that
                              does not exist is named; any other failed read
                              keeps the error's own text
nuka check --codes [--json]   list every finding code nuka check can produce,
                              with a one-line description and the code's
                              general do, instead of checking a project
nuka clean [--dry-run] [--json]
                              delete accumulated runs/do/export under
                              the state directory, all together; --dry-run
                              prints the same plan the real run would act on
                              without removing anything; under export/,
                              only the files a run's manifest names and
                              the contents of allure-results/; the cache/
                              and records/ directories earlier releases
                              left go too
nuka tend [--json] [--fail-on <code>]
                              scans featuresDir plus additionalFeatureDirs,
                              then where the bed is, then what is rotting
                              rather than what is broken: how much of the
                              vocabulary is typed rather than compat, how
                              many typed steps are read-only, and how much
                              of it declares what it could, then notes, none
                              of which changes the exit code (--fail-on
                              <code> makes a named note exit non-zero, for
                              that invocation; a removed code is
                              refused by name): a `from` nothing
                              exercises, a patterned step no
                              feature binds, a
                              configured parameter type no pattern uses, a
                              `defineParameterType` still registered from
                              support code, a secrets entry naming a key no
                              envFile defines,
                              a fixture no typed step requires, a fixture
                              reaching page, context, or pageAs, a step that
                              made a call soon
                              after its own navigation, scenarios that
                              open with the same steps up to the first When,
                              docstrings and tables compared too (measured,
                              no advice), and a schema field with no
                              `.describe()`
nuka tend --codes [--json]    list every finding code nuka tend can report,
                              a one-line description, and the code's
                              general do, instead of tending a project
nuka init [--allure] [--server "<command>" --server-url <url>]
                              set up a project; ends with a self-check.
                              Writes nukadoko.config.ts, features/steps/,
                              .nukadoko/, .env, .env.*, and !.env.example in
                              .gitignore, and a package.json
                              "test:scenarios" script ("nuka run") unless one
                              exists; appends the steps and the config to
                              tsconfig.json's include when it leaves them out,
                              or prints one stderr line naming them when the
                              file has comments. --allure writes
                              allurerc.mjs and creates
                              .nukadoko/export/allure-results.
                              --server with --server-url also writes
                              baseURL: <url>, a server fixture that calls
                              runServer on the command (split on
                              whitespace only, no shell) and stops it
                              after the scenario, a request override that
                              destructures the builtin request and
                              server, so every step that sends a request
                              starts the program first, and the
                              StepFixtures declaration for server. One
                              without the other, an empty command, or a
                              URL that is not http(s) is refused with
                              nothing written. Without playwright
                              installed, stderr names its install line.
                              After a passing self-check, its last
                              stderr line names this package's llms.txt
nuka skill path               where the bundled skill lives, for a project
                              that wants the copy matching this nukadoko
```

A flag that takes one string or one number is refused when it is given more than once, and that command writes nothing. `--use` on `nuka do`, `--env` on `nuka run`, and `--fail-on` on `nuka tend` are repeatable, and every value is kept in the order given.

Text output (no `--json`) is formatted for a human reading it.
`--json` is the machine-readable contract: stdout carries exactly one JSON
document, pretty-printed with two spaces, whether it is a report, a run
result, or a refusal, and stderr is empty: no progress, location, count, or
warning line, and no copy of what the document holds. No output, on stdout
or stderr, depends on whether a stream is a terminal: `nuka steps` wraps at
80 columns everywhere, and nukadoko writes no color.

Every JSON document nukadoko writes or prints starts with
`schema_version`, an integer that belongs to that kind of document: the
step record and the envelope. `run.json` is the `nuka run --json`
envelope, so it carries the envelope's. The
number moves when a field the document already has changes its meaning,
its type, or its name, or is removed. An added field does not move it. A
reader checks the number before it trusts the shape. The step record is 3: 2 made an `observed` channel the
execution never reached `null` and `observed.processes` always
present, and 3 removed the `session` field. The envelope is 2. A record without `schema_version` was written
by nukadoko 0.16.1 or earlier.

### The envelope

Every command's `--json` prints one envelope, and `nuka describe`, which
has no text form, always does:

```json
{
  "schema_version": 2,
  "nukadoko": "0.17.0",
  "command": "check",
  "verdict": "failed",
  "findings": [
    {
      "severity": "error",
      "code": "undefined-step",
      "file": "features/greet.feature",
      "line": 4,
      "message": "No step definition matches \"I run greet with \"Ada\"\"",
      "do": "nuka scaffold --feature features/greet.feature"
    }
  ]
}
```

`command` is the command path (`check`, `skill path`), or `""` when argv names no command. `verdict` is the exit
code's: `passed` for 0, `refused` for 2, and `failed` otherwise. The
command's own fields sit after `findings` and never replace the five:
`steps` (`nuka steps`), the contract (`nuka describe`), `summary` and
`fail_on_hits` (`nuka tend`), the `run.json` fields (`nuka run`), the plan
(`nuka clean`), and `codes` (`--codes`, each entry
a finding with no location). `nuka do` prints its step record, which is a
record and not a report, so it has no envelope and no `--json`; its
refusals and warnings are findings on stderr.

### Findings

A finding, a refusal, and a failed scenario are one shape. Its fields are
`severity`, `code`, `message`, then `file`, `line`, and `step` when they
are known (`fixture` on a tend note about a fixture), then `fix` and `do`.
The severity is `error` or `warning` (`nuka check`, and a warning of any
command), `note` (`nuka tend`), `refused` (see "Refusals"), or `failed` (a
failed scenario, a BeforeAll or AfterAll hook). `file` is
relative to the project root: for a finding about one step, it is the step
file that defines the step; for `duplicate-pattern`, which names several
steps, it is the file of the last one named; for a finding about a config
entry, it is the config file. A finding about a compat hook has no `file`,
because discovery does not record which file registered a hook.

`do` is always a command a shell runs as written, with its values filled
in and quoted for a POSIX shell (`nuka scaffold --feature
features/greet.feature`, `nuka run features/greet.feature:4`). `fix` is an
edit, in words: the file to change and what to write. A next step that is
a choice between edits, or a command with a value nukadoko cannot fill, is
a `fix`, never a guessed `do`. A finding that names neither gets the
code's general `fix`, which `--codes` lists, so every finding says what
gets past it. A refusal that names only a `do` keeps that general `fix`
beside it: the `do` is the next command, and the `fix` is what the
refusal asks to change.

In text, a finding is one line, `<severity>\t<code>\t<where>\t<message>`,
where `<where>` is `<file>:<line>`, `<file>`, the step name, or `-`; a
newline or a tab inside a value becomes a space. Indented lines may follow:
the files a grouped finding covers, then `  fix: <text>`, then `  do:
<command>`. `nuka check --codes` and `nuka tend --codes` print each code in
the same grammar.

### Refusals

A command refuses when it stops before it has anything to report: a flag
yargs or the command does not accept, a config it cannot load, a target
that does not exist, a step name it does not know, or, for `nuka run`, an error `nuka check` reports for the selected
scenarios. It exits 2, and the refusal is a finding with severity
`refused` and a code: `invalid-arguments`, `target-not-found`,
`config-invalid`, `check-errors`, and the others `nuka check --codes`
lists, or the check code of the same cause (a feature file that does not
parse is `feature-parse-error` whichever command found it). Under
`--json` it is in the envelope's `findings`, with `verdict` `refused`, and
stderr carries nothing; otherwise its lines are on stderr. `nuka run`
prints the `nuka check` findings it stopped on before its
`check-errors` refusal. The refusal's `do` is the next command when one is
known: `nuka steps` for an unknown step, the install line for a missing
peer dependency, `nuka check <file>` for a `:line` that `check` does not
take. When a project file stands in the way of `nuka scaffold` (the step
file already exists, or a `--from` producer's `returns` does not hold the
key), the `fix` names the change to that file and the `do` is the same
`nuka scaffold` command line. Otherwise the `fix` is the code's general
edit and the `do` is the command's own `--help`.

### Streams and exit codes

stdout carries what a command was asked for, and stderr carries what a
person watches it do. The exit code says which of three things happened,
so a script tells "fix the suite" from "fix the invocation" without
reading either stream.

| Exit | Meaning | Examples |
| --- | --- | --- |
| 0 | The command did what it was asked, and its report or run is green. | `nuka check` with warnings only, a passed `nuka run` |
| 1 | The command ran, and its report or run is red, or it failed while it ran. | an error from `nuka check`, a failed scenario, a `nuka report` that left out part of the run, a failed `nuka do` step, a step file that did not import on `nuka steps` or `nuka describe`, a `--fail-on` code `nuka tend` reported |
| 2 | The command refused: nothing ran and nothing was reported (see "Refusals"). | an unknown flag or command, a config it cannot load, a target that does not exist, a `:line` on `nuka check`, a bad `--repeat` or `--concurrency`, a missing peer dependency, `nuka init` or `nuka scaffold` refusing to write, an unknown `--fail-on` code, an unknown step on `nuka do` or `nuka describe`, `nuka run` stopped by the errors `nuka check` reports |
| 128 + n | `nuka run` or `nuka do` stopped on signal n after its teardown. | 130 for SIGINT |

| Command | stdout | stderr |
| --- | --- | --- |
| `nuka run` | one scenario's `run.json` entry per line under `--records`, `run.json` (the envelope) under `--json`, nothing otherwise | progress, the locations written, the summary line, the `scenario-failed` findings, warnings; nothing under `--json` |
| `nuka do` | the step record, also for a failed step | warning findings |
| `nuka check`, `nuka tend` | the report, or with `--json` the envelope | nothing, except a refusal or a warning without `--json` and `nuka tend`'s `fail-on` lines |
| `nuka steps`, `nuka describe` | the vocabulary or the contract (`--json` on `steps`; `describe` is always the envelope) | the step files that failed to import, as findings, except under `--json`, where they are in `findings` |
| `nuka clean` | one line per path, or with `--json` the envelope | nothing, except a refusal without `--json` |

A refusal under `--json` replaces the report: the envelope holds the
refusal finding and none of the command's own fields. A step record's
`error.kind` is listed under "Records".

### Tolerant reporting, fail-fast execution

A broken step file gets one of two different responses across this list.
The split follows one question: is the command about to execute a step, or
does it only report on the vocabulary? `nuka steps`, `nuka describe`,
`nuka check`, and `nuka tend` are reporting tools. Each discovers steps per
file, so one file whose import fails does not empty what the rest of the
project could still show. `nuka check` names the failure as
`step-file-import-failed`. When the cause is a relative `.js`, `.mjs`, or
`.cjs` import whose `.ts`, `.mts`, or `.cts` file does not exist, it
appends that file and the file whose import to edit, both relative to the
project root, after Node's own text. `nuka steps`/`nuka describe` carry the same finding (above). `nuka tend` counts only what imported and
does not repeat `nuka check`'s finding, so a reader runs `nuka check` beside
it (see "Tending"). `nuka run`, `nuka do`, and `nuka init`
are about to execute a step, or set up a project that is about to, so they
stay fail-fast: the same broken file rejects the whole call outright,
because continuing past it is dangerous for anything about to run, not
merely report on. The rejection names the file, a path relative to the
project root, ahead of the thrown error's own text. A migrating suite's normal state is some glue still
broken. A reporting tool that refused to run at all in that state would not
be a useful migration dashboard. An execution tool that pressed on anyway
would be running against glue it never actually read.

## Out of scope (honest limits)

- Semantic truth of a step's implementation rests on PR review. The tool
  guarantees the shape of inputs/outputs and the fact of execution.
- nukadoko cannot stop an agent with shell access from reading `.env`
  directly. It removes the structural necessity of secrets passing through
  the agent's context.
- A green run summary is not a proof that the software is correct. It
  records that the agreed scenarios were green at one named commit, and
  says nothing about today. It does not even claim that same commit would
  be green now. A defect that depends on when the run happened (a date
  computed in one timezone and read in another, a boundary the clock
  crosses) is missing from the summary exactly as it was missing from the
  run, and nukadoko does not re-run a scenario to find out. The honesty is
  that a summary only ever speaks about one execution. The limit is that a whole class of
  defect is invisible to any single one.
- **This package ships ESM and only ESM, on purpose.** `package.json`'s
  `exports` carries an `import` condition and no `require` one. There is no
  CommonJS build beside the ESM one, and neither is planned. A project whose
  own `package.json` has no `"type": "module"` still uses nukadoko, through
  files that are unambiguously ESM whatever that field says: its config as
  `nukadoko.config.mts`, its step files as `.mts`. That is what `nuka init`
  and `nuka scaffold` write once they see such a project. So nukadoko is
  imported from ESM either way, and what a CommonJS project gets is a way in
  rather than a second build to keep working. The cost is real and falls on
  an existing suite: glue already written as `.ts` there has to be renamed
  before it can be discovered. That is more than the one import specifier
  the compat door otherwise asks for, and `nuka check` names each file that
  needs it. A config file that fails to import names that file and the
  cause. A CommonJS `.ts` config gets the same rename sentence.

- **Promoting a step to `defineStep` is one-way.** The migration door's
  promise covers compat assets: switching the import back leaves a plain
  cucumber-js suite. `defineStep` has no import to switch back to. A
  promoted step's body still moves (it is written against Playwright's own
  objects, by the same choice stated below). Its schemas do not move,
  nor does its step record's `result`, `from` and the binding-order check
  reading it, nor every contract check built on those, and nothing here
  converts one back. Stated as a limit rather than a gap to close: the
  conversion is per-step and mechanical, and the import's reversibility
  exists to make adoption's first step cheap, not to make the typed side
  optional.
- **Not driver-agnostic, deliberately.** The `page` and `request` fixtures
  return Playwright's own `Page` and `APIRequestContext`, and the compat
  door hands migrating glue the same objects it already used. Wrapping them
  behind an interface of nukadoko's own would cost every capability the
  wrapper didn't think to expose. It would also replace a vocabulary users
  already know with one only this tool speaks: the opposite of writing
  through the official SDK. The exchange is that swapping in another driver
  later breaks the public API and the compat door together. That is
  accepted, not overlooked: rewriting step bodies from one driver's API to
  another is work an agent does well, while paying for portability up front
  would slow every change that isn't a driver swap. Revisit when the
  probability of that swap is measured to have risen, not before.
- No CI reporting, and no retry that discards a prior attempt's record. No
  outbound network I/O by nukadoko itself. No HTML rendering: that is
  Allure's job. Scenarios do run in parallel (`nuka run --concurrency
  <n>`, see "Scenarios"), but only across worker processes inside one
  invocation. There is no flag that splits one suite across several
  invocations, because a suite whose records are spread over several run
  ids is one no run summary can describe as a single run.

## Roadmap

- **M1 (engine core)**: `defineStep`, `do`, `run` over pickles, step records,
  environments, `check`, `init`. Secrets onboarding redesigned.
- **M2 (compat API)**: `nukadoko/compat` (Given/When/Then/World/hooks subset),
  migration guide for cucumber-js + Playwright suites.
- **M3 (reporting interop)**: a cucumber messages (NDJSON) stream for
  scenario runs (the compatibility surface that keeps a migrating team's
  existing formatters, JUnit-based CI, and HTML reports working), plus
  allure-results as the flagship dashboard. Both were written during the
  run at first; `nuka report` now renders each from a finished run.
- **M4 (sign-off)**: implemented as a command that froze a green run into a
  committed record beside the feature, then removed: no project kept the
  records. The run summary now carries the claim a record made, as
  evidence bound to its commit and run id, and the approval itself is
  recorded wherever the team records approvals (see "Review").
- **M5 (skills)**: the skills nukadoko ships, and `nuka skill path`. The
  CLI is deliberately a set of small verbs. A skill turns them into a
  workflow an agent can follow without being told, and none of it changes
  the engine. Skills follow the Agent Skills specification, so `gh skill
  install` and a Claude Code plugin marketplace both distribute them across
  hosts. nukadoko does not copy files into any host's directory itself.
  `nuka skill path` exists for the one thing neither of those can offer:
  the skill that shipped with the installed nukadoko, at the version that
  installed it. A skill describes a CLI and drifts into fiction when the two
  diverge. Two ship. The **acceptance skill** drives the acceptance loop
  end to end: criteria in, vocabulary read with `steps` and `describe`,
  missing operations scaffolded and implemented, the scenario written, then
  `run` until green, and the pull request a person reviews. The **migration skill** carries what the
  compat audit measured: the gaps a real cucumber-js suite actually hits,
  in the order they bite rather than the order they are documented. Its
  first stage leans on `nuka check` reporting those gaps, which `nuka
  check` now does (see "Compat steps"). Neither skill writes down a fact
  the CLI already answers (vocabulary, contracts, refusal reasons), because
  a skill that copies those starts lying the moment the command changes.
- **M6 (chained arguments)**: `from`, the scenario-order check `nuka check`
  and `nuka run` share, `--use` on `do`, and a `used` entry that names the
  step beside the step record it cites. Where a step's inputs come from stops
  being prose inside a `run` body and becomes a declaration the tool reads
  (see "Chaining steps").
- **M7 (tending)**: `nuka tend`, the findings that are about rot rather
  than breakage (see "Tending"). Kept off `nuka check` on purpose: `check`
  is read before every run and has to stay worth stopping for.
- **M8 (fixtures)**: user-defined resources declared under
  `nukadoko.config.ts`'s own `fixtures` (see "Fixtures"), `defineFixtures`
  for full typing, scope, `use()`-based teardown carrying the step's or
  scenario's own outcome, a fixture-specific timeout, and the `check`/`tend`
  findings that come with them. This closes the one gap the typed side had
  that compat's After hooks did not: a place to put cleanup that is not
  itself an acceptance condition.
- **M9 (parts)**: `parts` on `defineStep`, the `call` fixture, the `calls`
  entries a step record gains, and the checks that come with them (see
  "Parts"). A step can be split without its feature file being rewritten.
  This is what makes a reuse granularity smaller than a scenario line
  possible at all.
- **M10 (harvesting)**: a `harvest` command that built one feature draft
  from a named `do` sequence. It was removed later: the agent that ran the
  sequence already knew its steps, and the draft left blank the claims a
  scenario exists to state. A path found by exploring still becomes a path
  fixed in a sentence, written by whoever explored it.
- **M11 (live sessions)**: `start` and `stop` under the `session` command, one `ctx` held
  open in a process so `nuka do` could land on a world already partway
  through. It was removed later: a Playwright MCP server the agent's host
  already runs keeps a browser open across calls the same way, with no
  process, socket, or idle timeout of nukadoko's own (see "State that
  cannot be repeated"). The rest of sessions, the `session list` and
  `session clear` commands and the `--session` flag of `do`, went after it: login state comes from a
  fixture, so no state carries across calls.
- **M12 (concurrency)**: `nuka run --concurrency <n>`, worker processes
  each holding whole feature files, `@nukadoko:serial` for a file that has to run
  alone, and the parent that keeps the run's identity while they work (see
  "Scenarios"). Every scenario still runs under the same serial engine;
  what changes is how many of them run at once. Worker processes make the
  gain independent of what a suite spends its time on, and leave the
  fixture teardown rule standing.
- **M13 (Markdown oaths)**: Markdown files compiled into the same pickles
  as a `.feature` file. It was removed later: a second front meant a second
  parser and a second set of findings, and a `.feature` file says the same
  thing.
- **M14 (exploring, experimental)**: the `experimental explore` command, which ran
  a model or a relation against request-only steps and printed a shrunk
  scenario to paste. It was removed later, with `defineModel` and
  `defineRelation`: the feature file is the set of sequences a person chose
  to keep, and a sequence found by exploring is written there as a scenario.
- **Later**: AI-assisted glue converter (existing regex glue → typed steps),
  tag-expression filtering, cucumber-js adapter if a real suite needs
  in-place coexistence rather than migration.

## Implementation notes

- Runtime dependencies: `@cucumber/gherkin`,
  `@cucumber/cucumber-expressions`, `@cucumber/messages`,
  `allure-js-commons`, `playwright`, `zod`, `yargs` (CLI). TypeScript is
  loaded by Node's own type stripping, with no loader package: Node
  `^22.18.0 || >=23.6.0`.
- When a format or protocol has an official SDK, nukadoko writes through it
  rather than reimplementing the format. Allure results go through
  allure-js-commons' reporter machinery; cucumber messages go through
  `@cucumber/messages`. nukadoko stays a thin mapping layer on top.
  Overriding a piece of the official machinery is a measured decision taken
  when a concrete need appears, never the default.
- id format: `<kind>-<timestamp>-<short random>`.
- `nuka steps` and `nuka describe` import step modules, because collecting
  compat registrations and patterns requires it, and importing executes a
  file's top-level code, the same caution as running. The CLI ships no shell
  completion.
- The first real-world validation gate, before M2 was designed in detail,
  bound about 10 real feature files and measured whether reviewing
  AI-drafted typed steps actually beats writing glue by hand. It ran
  against 11 feature files from seven public projects, and the answer was
  yes in six of the seven. The second gate measured the compat door rather
  than the typed one, and is reported under "Compat steps" above.
