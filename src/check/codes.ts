// Responsibility: the one source every finding code `nuka check` can
// produce is read from, each paired with a one-line description a user
// reads (`nuka check --codes`, src/cli/check.ts) and, when a code always
// carries one, the severity it always carries. `CheckCode`, the union
// derived from this registry's own keys, is what src/check/types.ts's
// `CheckIssue.code` is typed as: a code string written anywhere under
// src/check/* (or a lower module whose issue eventually reaches a
// `CheckIssue`, e.g. src/check/parts-check.ts, src/fixture/graph.ts) that
// is not a key here fails to compile at the point it is pushed into a
// `CheckIssue[]`. README.md's own "CLI summary" pointed a reader at `nuka
// check --json` for this exact catalog, deliberately declining to hand-
// maintain a count that would drift; the CLI just never produced one,
// since `--json` only ever reports one project's own findings. This
// registry, and `--codes` (src/cli/check.ts) reading it, is what makes
// that pointer true: the catalog is checked by the compiler, not
// remembered by whoever adds the next code.
//
// `severity` is optional on purpose: it is only filled in for a code this
// module's own source was read to confirm always lands on the same side of
// `{ errors, warnings }` (every registered code today happens to be one or
// the other, never both) — a future code that genuinely depends on where
// it is raised is not forced to invent a single answer just to satisfy this
// type.

export type CheckSeverity = "error" | "warning";

export interface CheckCodeInfo {
  readonly description: string;
  readonly severity?: CheckSeverity;
  /** The general next step for the code. A finding uses it as its own `do`
   * unless the place that raises it knows a more exact command. */
  readonly do: string;
}

const CHECK_CODES = {
  "additional-feature-dir-missing": {
    description: "An entry in additionalFeatureDirs does not exist on disk.",
    severity: "error",
    do: "Create the directory, or remove the entry from additionalFeatureDirs in the config file.",
  },
  "alias-key-mismatch": {
    description: "A step has more than one pattern, and the patterns bind different sets of keys.",
    severity: "error",
    do: "Edit the step's patterns so that each one captures the same set of keys.",
  },
  "ambiguous-step": {
    description: "A line in a feature file matches more than one step definition.",
    severity: "error",
    do: "Reword the feature line, or edit one of the matching patterns, so that exactly one step matches. nuka steps lists each pattern.",
  },
  "args-not-object": {
    description:
      "A step has a pattern, but its args schema is not a z.object, so there is no key to check that pattern's captures against.",
    severity: "error",
    do: "Declare the step's args as a z.object whose keys the pattern captures fill.",
  },
  "capture-type-mismatch": {
    description:
      "A pattern captures a key with a built-in type whose JS value is a number, string, or bigint, but the args schema declares that key as a different primitive (number, string, boolean, or bigint) and does not coerce the captured value.",
    severity: "error",
    do: "Make the capture type and the args field type agree: change the {key:type} in the pattern, or declare the field with z.coerce.",
  },
  "duplicate-capture-key": {
    description:
      "A pattern captures the same key more than once. One args field holds one value, so the pattern is refused instead of dropping a value.",
    severity: "error",
    do: "Rename one of the captures, so that each key occurs once in the pattern.",
  },
  "done-callback-arity": {
    description:
      "A compat hook or a matched compat step declares more parameters than nukadoko passes, which cucumber-js reads as a done() callback.",
    severity: "error",
    do: "Remove the done callback parameter, and return a promise from the function instead.",
  },
  "duplicate-pattern": {
    description:
      "Two or more patterns, once capture names are stripped, normalize to the same text, so one step text could match more than one step.",
    severity: "error",
    do: "Reword one of the patterns, so that the two texts differ when the capture names are removed.",
  },
  "env-file-missing": {
    description: "A configured envFile does not exist on disk, so nothing in it is ever loaded.",
    severity: "warning",
    do: "Create the file, or remove it from envFiles in the config file.",
  },
  "env-file-skipped-line": {
    description:
      "A line in a configured envFile is not a blank line, a comment, or a binding, so nothing on it was loaded.",
    severity: "warning",
    do: "Rewrite the line as KEY=value, or start it with # to make it a comment.",
  },
  "environment-env-file-missing": {
    description: "An entry in one environment's own envFiles does not exist on disk.",
    severity: "warning",
    do: "Create the file, or remove it from that environment's envFiles in the config file.",
  },
  "explore-browser-step": {
    description:
      "A model command or a relation sequence entry names a step that needs a browser (page or context). Explore does not run that step.",
    severity: "error",
    do: "Remove the step from the model or the relation. Explore runs only steps that need no browser.",
  },
  "explore-empty-model": {
    description:
      "A model declares no commands, so every sequence it builds is empty and passes.",
    severity: "error",
    do: "Add at least one command to the model.",
  },
  "explore-unknown-step": {
    description:
      "A model command or a relation sequence entry names a step that is not in the vocabulary.",
    severity: "error",
    do: "Correct the step name, or add the step. nuka steps lists the names in the vocabulary.",
  },
  "explore-unseeded-random": {
    description:
      "A model command's args, pre, or next, or a relation's drawn source, calls Math.random directly. The seed does not drive that value, so a run cannot be replayed or shrunk.",
    severity: "error",
    do: "Draw the value with draw.int or draw.pick, so that the seed drives it.",
  },
  "feature-parse-error": {
    description: "A .feature file or a Markdown oath could not be parsed, so nothing in it was checked.",
    severity: "error",
    do: "Correct the Gherkin at the line that the message names, then run nuka check on the file again.",
  },
  "features-dir-missing": {
    description: "The configured featuresDir does not exist on disk, so no feature or step file under it can load.",
    severity: "error",
    do: "Create the featuresDir directory, or correct featuresDir in the config file.",
  },
  "fixture-cycle": {
    description: "config.fixtures definitions depend on each other in a cycle, so none of them can ever resolve.",
    severity: "error",
    do: "Remove one dependency from the cycle in config.fixtures.",
  },
  "fixture-scope-violation": {
    description:
      "A config.fixtures definition scoped to run once per process depends on one scoped to run once per scenario.",
    severity: "error",
    do: "Scope the dependent fixture per scenario, or scope the fixture that it depends on per process.",
  },
  "fixture-structural-violation": {
    description:
      "A step's run(), or a config.fixtures definition's own function, is not a plain object-destructuring parameter, or destructures a fixture name nukadoko does not know. A fixture that destructures call is the same finding: call is only available inside a step's run().",
    severity: "error",
    do: "Give the function one object-destructuring parameter that names only known fixtures. The message names the name that is not known.",
  },
  "from-order-violation": {
    description:
      "A step declares from for a key, and the step or steps it names have not run earlier in the same scenario, or (when the key names more than one candidate) more than one candidate has.",
    severity: "error",
    do: "Put a line that runs the producer step earlier in the scenario, or remove the from entry for the key.",
  },
  "from-structural-violation": {
    description: "A step's from names a value that is not a registered step, or is otherwise structurally malformed.",
    severity: "error",
    do: "Make each from entry name a step that a step file registers.",
  },
  "invalid-capture-key": {
    description:
      "A pattern capture's name is not a valid identifier: a capture key must start with a letter or underscore and contain only letters, digits, and underscores.",
    severity: "error",
    do: "Rename the capture: a letter or an underscore first, then only letters, digits, and underscores.",
  },
  "no-step-files-found": {
    description:
      "featuresDir exists, but no .ts/.mts/.js/.mjs step file was found while scanning it, so no step can ever be registered.",
    severity: "error",
    do: "Add a step file under featuresDir. nuka scaffold writes one.",
  },
  "outline-does-not-run": {
    description:
      "A scenario outline has no Examples row that will run, so the boundary the feature names is absent from the run.",
    severity: "error",
    do: "Add an Examples row for each case that must run, or remove the empty Examples table.",
  },
  "outline-rows-share-name": {
    description:
      "A scenario outline has more than one Examples row, and its name holds no <column> of its Examples, so every row is reported under the same name.",
    severity: "warning",
    do: "Add an Examples column to the outline's name, such as <column>, so that each row has its own name.",
  },
  "page-override-unowned": {
    description: "A config.fixtures definition overrides page, but owns neither page nor context.",
    severity: "error",
    do: "Make the fixture that overrides page own page or context, or remove the override.",
  },
  "parameter-type-invalid": {
    description:
      "A custom parameter type takes the name of a built-in type, two parameter types share the same name (from config.parameterTypes or a compat defineParameterType call), or a type sets preferForRegexpMatch on a regexp that another type, built-in or custom, already prefers.",
    severity: "error",
    do: "Rename the parameter type, or remove the second registration or the second preferForRegexpMatch.",
  },
  "part-cycle": {
    description: "A step's parts form a cycle: the step reaches itself, directly or through other steps' own parts.",
    severity: "error",
    do: "Remove one part from the chain, so that no step reaches itself.",
  },
  "part-mutates-contradiction": {
    description: "A step declares mutates: false, but declares a part that declares mutates: true.",
    severity: "error",
    do: "Declare mutates: true on the step, or remove the part that declares mutates: true.",
  },
  "part-structural-violation": {
    description: "A step's parts names a value that is not a registered step, or is otherwise structurally malformed.",
    severity: "error",
    do: "Make each parts entry a step that a step file registers.",
  },
  "pattern-error": {
    description:
      "A step's pattern could not be parsed, for a reason other than an unnamed, invalid, or unterminated capture.",
    severity: "error",
    do: "Correct the pattern at the position that the message names.",
  },
  "pattern-syntax-error": {
    description:
      "A pattern failed to build into a cucumber expression, for a reason cucumber-expressions itself reports (not an unknown parameter type).",
    severity: "error",
    do: "Correct the pattern at the position that the message names. Escape a literal ( ) or / as \\( \\) or \\/.",
  },
  "playwright-missing": {
    description:
      "A feature line binds a step whose fixtures build page, context, or request, and playwright does not resolve from the installed nukadoko, so the step would fail when it runs; or a step file imports playwright, playwright-core, or @playwright/test, which the project has not installed, so the file does not import. A step is reported once, at the first line that binds it.",
    severity: "error",
    do: "Install the package that the message names in the project, at the version that the message names.",
  },
  "scenario-without-then": {
    description:
      "A scenario has a Given or When step of its own and no Then step, in it or in its Background, so it passes whenever its steps run without an error. A * line counts as neither.",
    severity: "warning",
    do: "Add a Then line that checks the outcome the scenario is for.",
  },
  "secrets-redact-key-too-short": {
    description:
      "A secrets.redact key's value is shorter than the minimum length build-secret-set.ts will actually redact, so it never gets redacted.",
    severity: "warning",
    do: "Use a longer value for the key, or remove the key from secrets.redact.",
  },
  "serial-tag-on-scenario": {
    description:
      "A @nukadoko:serial tag is on a Scenario/Scenario Outline line; nuka run --concurrency only reads it from the Feature line, so it has no effect there.",
    severity: "error",
    do: "Move @nukadoko:serial to the Feature line.",
  },
  "step-file-import-failed": {
    description: "A step file under featuresDir failed to import, so any step it defines never reaches the vocabulary.",
    severity: "error",
    do: "Correct the import or the error that the message names in the file, then run nuka check again.",
  },
  "step-file-unsupported-extension": {
    description: "Discovery found a .cjs or .cts step file; nukadoko is ESM-only and never imports it.",
    severity: "error",
    do: "Write the file as an ES module with a .ts, .mts, .js, or .mjs extension.",
  },
  "step-option-ignored": {
    description:
      "A defineStep call passes a key that defineStep does not read, such as rationale, which was removed, so the key has no effect and its value is shown nowhere.",
    severity: "warning",
    do: "Delete the key from the defineStep call. Move rationale text into a comment above defineStep first.",
  },
  "table-docstring-key-mismatch": {
    description:
      "A step's table or docstring is attached to a line, but zero, or more than one, of its args keys is left unconsumed by pattern captures (exactly one must be left for the attachment to fill), or the one key it fills is of a type the attachment can never satisfy (a table is string[][], a docstring is a string).",
    severity: "error",
    do: "Leave exactly one args key that no capture fills, typed string[][] for a table or string for a docstring, or remove the attachment from the line.",
  },
  "then-compat-step": {
    description:
      "A compat step is bound in Then position; compat has no mutates declaration to check that position against.",
    severity: "warning",
    do: "Promote the step to defineStep with mutates: false, or move the line out of Then position.",
  },
  "then-mutates": {
    description: "A step bound in Then position declares mutates: true, so its declaration and its position are in tension.",
    severity: "warning",
    do: "Declare mutates: false if the step only reads, or move the line to Given or When.",
  },
  "tracked-secret-looking-key": {
    description:
      "An envFile tracked by git defines a key that looks like a secret by name, but that key is not in secrets.redact.",
    severity: "warning",
    do: "Add the key to secrets.redact, or move it to an envFile that git does not track.",
  },
  "undefined-step": {
    description: "No step definition matches a line in a feature file.",
    severity: "error",
    do: "Run nuka scaffold --feature with the feature file to write a stub for each undefined line, or reword the line to match a step that exists.",
  },
  "undefined-step-check-suppressed": {
    description:
      "A step file failed to import, or a line would match a step whose pattern has an unregistered parameter type, so the undefined-step finding that cause could explain is held back until it is fixed.",
    severity: "warning",
    do: "Correct the step-file-import-failed error or the pattern error first, then run nuka check again.",
  },
  "unfillable-required-key": {
    description:
      "A step's args key is required, but nothing on this line (no pattern capture, no table/docstring attachment, and no declared from) can ever fill it.",
    severity: "error",
    do: "Capture the key in the pattern, attach a table or a docstring, declare from for the key, or make the key optional.",
  },
  "unknown-capture-key": {
    description: "A pattern captures a key that is not a key of the step's args schema.",
    severity: "error",
    do: "Rename the capture to a key of the args schema, or add the key to the schema.",
  },
  "unknown-parameter-type": {
    description:
      "A pattern names a parameter type this project has not registered, such as {custom} with no matching config.parameterTypes entry.",
    severity: "error",
    do: "Register the type in config.parameterTypes, or use a built-in type such as {key:string}.",
  },
  "unnamed-capture": {
    description:
      "A step's pattern has a capture with no name, such as {int} instead of {key:int}; every capture must name the args key it fills.",
    severity: "error",
    do: "Name the capture after the args key that it fills, as {key:type}.",
  },
  "unsupported-hook-tag-expression": {
    description: "A compat hook's tag expression could not be parsed, so nukadoko cannot tell which scenarios it applies to.",
    severity: "error",
    do: "Rewrite the hook's tags as a tag expression that nukadoko parses, such as @a and not @b.",
  },
  "unterminated-capture": {
    description: "A pattern has an opening { with no matching closing }, so the pattern cannot be parsed.",
    severity: "error",
    do: "Close the capture with }, or escape a literal { as \\{.",
  },
} as const satisfies Record<string, CheckCodeInfo>;

export type CheckCode = keyof typeof CHECK_CODES;

/** Every registered code, in code-ascending order — the one ordering
 * `nuka check --codes` (human-readable and `--json` alike) promises, and
 * the one this function itself is trusted to produce rather than leaving
 * each caller to sort a second time. */
export function listCheckCodes(): ReadonlyArray<{ code: CheckCode } & CheckCodeInfo> {
  return (Object.keys(CHECK_CODES) as CheckCode[])
    .sort((a, b) => a.localeCompare(b))
    .map((code) => ({ code, ...CHECK_CODES[code] }));
}

/** The registry's general `do` for `code`. */
export function checkCodeDo(code: CheckCode): string {
  return CHECK_CODES[code].do;
}
