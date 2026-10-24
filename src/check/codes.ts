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
// Every code lands in one of `{ errors, warnings, notes }`, so `severity`
// is required: a finding's first column is read from here, and a code that
// could be two of them would make that column depend on where it was raised.
// An error stops the run, a warning is worth reading before it, and a note
// is a fact about the project a team may carry; `nuka check --fail-on` is
// how a job turns a chosen note or warning into a failing exit.

export type CheckSeverity = "error" | "warning" | "note";

export interface CheckCodeInfo {
  readonly description: string;
  readonly severity: CheckSeverity;
  /** The general edit that gets past the code, in words. A finding carries
   * it as its `fix` unless the place that raises it names its own `fix` or
   * an exact `do` command. */
  readonly fix: string;
}

const CHECK_CODES = {
  "additional-feature-dir-missing": {
    description: "An entry in additionalFeatureDirs does not exist on disk.",
    severity: "error",
    fix: "Create the directory, or remove the entry from additionalFeatureDirs in the config file.",
  },
  "alias-key-mismatch": {
    description: "A step has more than one pattern, and the patterns bind different sets of keys.",
    severity: "error",
    fix: "Edit the step's patterns so that each one captures the same set of keys.",
  },
  "ambiguous-step": {
    description: "A line in a feature file matches more than one step definition.",
    severity: "error",
    fix: "Reword the feature line, or edit one of the matching patterns, so that exactly one step matches. nuka steps lists each pattern.",
  },
  "args-not-object": {
    description:
      "A step has a pattern, but its args schema is not a z.object, so there is no key to check that pattern's captures against.",
    severity: "error",
    fix: "Declare the step's args as a z.object whose keys the pattern captures fill.",
  },
  "capture-type-mismatch": {
    description:
      "A pattern captures a key with a built-in type whose JS value is a number, string, or bigint, but the args schema declares that key as a different primitive (number, string, boolean, or bigint) and does not coerce the captured value.",
    severity: "error",
    fix: "Make the capture type and the args field type agree: change the {key:type} in the pattern, or declare the field with z.coerce.",
  },
  "claim-compares-itself": {
    description:
      "A claim's actual value and its expected value resolve to the same place: the same path of the same earlier line's result, or the same observe path, with a view and an at counted as steps of the path. Such a claim holds whatever the behaviour is. Also reported for a claim step whose observe receives a from value that an expected from reads, or one that holds it or that it holds, so observe could return the expected value as the actual one, and for one whose observe receives the from value an actual reads when that claim's expected value is { observe }, so observe could return the actual value as the expected one. nuka run and nuka do break such a claim at run time too, so --no-check does not let it hold.",
    severity: "error",
    fix: "Take the expected value from the sentence (a capture, the docstring, or the table), or from another step's result, so the two sides can differ. For observe, give it values from another step, or none from the step the other side comes from.",
  },
  "claim-expected-transformed": {
    description:
      "A claim step names an args key as its expected value, and a pattern fills that key with a parameter type that config.parameterTypes or a compat defineParameterType registered with a transformer. The transformer rewrites the line's text before the claim reads it, so code would decide what the claim compares while the record labels the value as the sentence's. Under --no-check, nuka run leaves a claim that compares with such a key unjudged, so the run agrees with the check.",
    severity: "error",
    fix: "Capture the key with a type that has no transformer, such as {key:string}, and declare expected_view (text, lines, or json) on the claim if the text needs one.",
  },
  "claim-path-unknown": {
    description:
      "A claim reads a path into a value an earlier step returned, and that step's returns schema has nothing at the path, so the value is undefined and the claim always breaks.",
    severity: "error",
    fix: "Correct the path to one the producing step's returns declares, or add the key to that step's returns.",
  },
  "claim-poll-unstated": {
    description:
      "A claim step's observe reaches a browser page and the step does not state poll. A page between two renders can show any state for one frame, so the step has to say whether it reads once or until the claims hold.",
    severity: "error",
    fix: "Add poll: { timeout_ms } to read until every claim holds on two consecutive readings, or poll: false to read once.",
  },
  "claim-sentence-unread": {
    description:
      "A claim step with no observe is bound to a line whose docstring or table fills an args key, and no claim reads that key (as an actual, an expected value, or in where), so nothing checks the value the line states. defineStep refuses a pattern capture no claim reads; only the line says whether a docstring or a table fills a key, so this half is the check's, and nuka run breaks the step's claims for it too.",
    severity: "error",
    fix: "Compare a claim with the key (expected: \"<key>\"), or take the docstring or table off the line.",
  },
  "claims-outside-then": {
    description:
      "A claim step is bound in Given or When position, or on a * line, which Gherkin gives no position. Only a Then judges, so a broken claim there would read as a setup that broke instead of a criterion that failed.",
    severity: "error",
    fix: "Move the line to Then position, or bind a step that runs (defineStep with run) at this line.",
  },
  "duplicate-capture-key": {
    description:
      "A pattern captures the same key more than once. One args field holds one value, so the pattern is refused instead of dropping a value.",
    severity: "error",
    fix: "Rename one of the captures, so that each key occurs once in the pattern.",
  },  "done-callback-arity": {
    description:
      "A compat hook or a matched compat step declares more parameters than nukadoko passes, which cucumber-js reads as a done() callback.",
    severity: "error",
    fix: "Remove the done callback parameter, and return a promise from the function instead.",
  },

  "duplicate-pattern": {
    description:
      "Two or more patterns, once capture names are stripped, normalize to the same text, so one step text could match more than one step.",
    severity: "error",
    fix: "Reword one of the patterns, so that the two texts differ when the capture names are removed.",
  },
  "env-file-missing": {
    description: "A configured envFile does not exist on disk, so nothing in it is ever loaded.",
    severity: "warning",
    fix: "Create the file, or remove it from envFiles in the config file.",
  },
  "env-file-skipped-line": {
    description:
      "A line in a configured envFile is not a blank line, a comment, or a binding, so nothing on it was loaded.",
    severity: "warning",
    fix: "Rewrite the line as KEY=value, or start it with # to make it a comment.",
  },
  "environment-env-file-missing": {
    description: "An entry in one environment's own envFiles does not exist on disk.",
    severity: "warning",
    fix: "Create the file, or remove it from that environment's envFiles in nukadoko.program.ts.",
  },
  "feature-parse-error": {
    description: "A .feature file could not be parsed, so nothing in it was checked.",
    severity: "error",
    fix: "Correct the Gherkin at the line that the message names, then run nuka check on the file again.",
  },
  "features-dir-missing": {
    description: "The configured featuresDir does not exist on disk, so no feature or step file under it can load.",
    severity: "error",
    fix: "Create the featuresDir directory, or correct featuresDir in the config file.",
  },
  "fixture-cycle": {
    description: "config.fixtures definitions depend on each other in a cycle, so none of them can ever resolve.",
    severity: "error",
    fix: "Remove one dependency from the cycle in config.fixtures.",
  },
  "fixture-scope-violation": {
    description:
      "A config.fixtures definition scoped to run once per process depends on one scoped to run once per scenario.",
    severity: "error",
    fix: "Scope the dependent fixture per scenario, or scope the fixture that it depends on per process.",
  },
  "fixture-structural-violation": {
    description:
      "A step's run(), or a config.fixtures definition's own function, is not a plain object-destructuring parameter, or destructures a fixture name nukadoko does not know. A fixture that destructures call is the same finding: call is only available inside a step's run().",
    severity: "error",
    fix: "Give the function one object-destructuring parameter that names only known fixtures. The message names the name that is not known.",
  },
  "fixture-unused": {
    description: "No typed step requires a config.fixtures definition, directly or through another fixture.",
    severity: "note",
    fix: "Remove the fixture from config.fixtures, or keep it for nuka do.",
  },
  "from-order-check-suppressed": {
    description:
      "A step's from names a producer that no earlier line runs, but a line before it matches no step and may be meant to run that producer, so the from-order-violation findings that line could explain are held back until it matches a step.",
    severity: "warning",
    fix: "Reword the undefined line to match the producer's pattern if it is meant to run that producer. Otherwise fix the undefined-step finding first, then run nuka check again.",
  },
  "from-order-violation": {
    description:
      "A step declares from for a key, and the step or steps it names have not run earlier in the same scenario, or (when the key names more than one candidate) more than one candidate has.",
    severity: "error",
    fix: "Put a line that runs one producer step earlier in the scenario, or list the step an earlier line runs as another candidate for the key in from. When more than one candidate ran earlier, keep only one.",
  },
  "from-structural-violation": {
    description: "A step's from names a value that is not a registered step, or is otherwise structurally malformed.",
    severity: "error",
    fix: "Make each from entry name a step that a step file registers.",
  },
  "from-unused": {
    description:
      "A step's from declaration never supplies a value, because every feature line that binds the step fills that key with a pattern capture.",
    severity: "note",
    fix: "Remove the from entry for the key, or keep it for nuka do --use.",
  },
  "invalid-capture-key": {
    description:
      "A pattern capture's name is not a valid identifier: a capture key must start with a letter or underscore and contain only letters, digits, and underscores.",
    severity: "error",
    fix: "Rename the capture: a letter or an underscore first, then only letters, digits, and underscores.",
  },
  "no-step-files-found": {
    description:
      "featuresDir exists, but no .ts/.mts/.js/.mjs step file was found while scanning it, so no step can ever be registered.",
    severity: "error",
    fix: "Add a step file under featuresDir. nuka scaffold writes one.",
  },
  "outline-does-not-run": {
    description:
      "A scenario outline has no Examples row that will run, so the boundary the feature names is absent from the run.",
    severity: "error",
    fix: "Add an Examples row for each case that must run, or remove the empty Examples table.",
  },
  "outline-rows-share-name": {
    description:
      "A scenario outline has more than one Examples row, and its name holds no <column> of its Examples, so every row is reported under the same name.",
    severity: "warning",
    fix: "Add an Examples column to the outline's name, such as <column>, so that each row has its own name.",
  },
  "package-type-missing": {
    description:
      "A package.json with no \"type\" field governs a .ts or .js file nukadoko loads, so Node parses the file twice and prints a MODULE_TYPELESS_PACKAGE_JSON warning on every load.",
    severity: "note",
    fix: "Add \"type\": \"module\" to the package.json, or rename the files to .mts if the project's own .js files are CommonJS.",
  },
  "page-override-unowned": {
    description: "A config.fixtures definition overrides page, but owns none of page, context, and pageAs.",
    severity: "error",
    fix: "Make the fixture that overrides page own page, context, or pageAs, or remove the override.",
  },
  "parameter-type-invalid": {
    description:
      "A custom parameter type takes the name of a built-in type, two parameter types share the same name (from config.parameterTypes or a compat defineParameterType call), or a type sets preferForRegexpMatch on a regexp that another type, built-in or custom, already prefers.",
    severity: "error",
    fix: "Rename the parameter type, or remove the second registration or the second preferForRegexpMatch.",
  },
  "parameter-type-unused": {
    description: "No typed or compat pattern names a config.parameterTypes entry.",
    severity: "note",
    fix: "Remove the entry from config.parameterTypes, or use it in a pattern.",
  },
  "part-cycle": {
    description: "A step's parts form a cycle: the step reaches itself, directly or through other steps' own parts.",
    severity: "error",
    fix: "Remove one part from the chain, so that no step reaches itself.",
  },
  "part-mutates-contradiction": {
    description: "A step declares mutates: false, but declares a part that declares mutates: true.",
    severity: "error",
    fix: "Declare mutates: true on the step, or remove the part that declares mutates: true.",
  },
  "part-structural-violation": {
    description: "A step's parts names a value that is not a registered step, or is otherwise structurally malformed.",
    severity: "error",
    fix: "Make each parts entry a step that a step file registers.",
  },
  "pattern-error": {
    description:
      "A step's pattern could not be parsed, for a reason other than an unnamed, invalid, or unterminated capture.",
    severity: "error",
    fix: "Correct the pattern at the position that the message names.",
  },
  "pattern-syntax-error": {
    description:
      "A pattern failed to build into a cucumber expression, for a reason cucumber-expressions itself reports (not an unknown parameter type).",
    severity: "error",
    fix: "Correct the pattern at the position that the message names. Escape a literal ( ) or / as \\( \\) or \\/.",
  },
  "pattern-unbound": {
    description: "A typed step has a pattern, and no feature line resolves to that step alone.",
    severity: "note",
    fix: "Write a feature line that matches the pattern, or remove the pattern if only nuka do runs the step.",
  },
  "playwright-missing": {
    description:
      "A feature line binds a step whose fixtures build page, context, pageAs, or request, and playwright does not resolve from the installed nukadoko, so the step would fail when it runs; or a step file imports playwright, playwright-core, or @playwright/test, itself or through another project file that the message names, which the project has not installed, so the file does not import. A step is reported once, at the first line that binds it.",
    severity: "error",
    fix: "Install the package that the message names in the project, at the version that the message names.",
  },
  "program-placeholder-unfilled": {
    description:
      "A command or an env value in nukadoko.program.ts names a placeholder a world has no value for: {port} in a world that does not serve, {url} in one with neither serve nor url, or anything but {root} in a build command.",
    severity: "error",
    fix: "Remove the placeholder from the field the message names, or give the world what fills it: serve for {port}, serve or url for {url}.",
  },
  "scenario-without-then": {
    description:
      "A scenario judges no claim, so it passes whenever its steps run without an error: it has steps of its own and no Then step, in it or in its Background (a scenario of only * lines included, since a * line has no position), or each of its Then lines binds a step that is not a claim step, such as a compat step.",
    severity: "warning",
    fix: "Add a Then line that binds a claim step (defineStep with claims) and checks the outcome the scenario is for.",
  },
  "schema-field-undescribed": {
    description:
      "A field of a typed step's args or returns schema has no .describe(), so an agent choosing a step cannot read what it means.",
    severity: "note",
    fix: "Add a .describe() that says what the field means to each field that the message names.",
  },
  "secrets-public-key-unknown": {
    description: "A secrets.public entry names a key that no envFile defines.",
    severity: "warning",
    fix: "Define the key in an envFile, or remove it from secrets.public.",
  },
  "secrets-redact-key-too-short": {
    description:
      "A secrets.redact key's value is shorter than the minimum length build-secret-set.ts will actually redact, so it never gets redacted.",
    severity: "warning",
    fix: "Use a longer value for the key, or remove the key from secrets.redact.",
  },
  "secrets-redact-key-unknown": {
    description: "A secrets.redact entry names a key that no envFile defines.",
    severity: "warning",
    fix: "Define the key in an envFile, or remove it from secrets.redact.",
  },
  "serial-tag-on-scenario": {
    description:
      "A @nukadoko:serial tag is on a Scenario/Scenario Outline line; nuka run --concurrency only reads it from the Feature line, so it has no effect there.",
    severity: "error",
    fix: "Move @nukadoko:serial to the Feature line.",
  },
  "step-description-todo": {
    description: "A typed step's description is still the placeholder nuka scaffold wrote.",
    severity: "note",
    fix: "Replace the description with one sentence that says what the step does.",
  },
  "step-file-import-failed": {
    description: "A step file under featuresDir failed to import, so any step it defines never reaches the vocabulary.",
    severity: "error",
    fix: "Correct the import or the error that the message names in the file, then run nuka check again.",
  },
  "step-file-unsupported-extension": {
    description: "Discovery found a .cjs or .cts step file; nukadoko is ESM-only and never imports it.",
    severity: "error",
    fix: "Write the file as an ES module with a .ts, .mts, .js, or .mjs extension.",
  },
  "step-option-ignored": {
    description:
      "A defineStep call passes a key that defineStep does not read, such as rationale, which was removed, so the key has no effect and its value is shown nowhere.",
    severity: "warning",
    fix: "Delete the key from the defineStep call. Move rationale text into a comment above defineStep first.",
  },
  "table-docstring-key-mismatch": {
    description:
      "A step's table or docstring is attached to a line, but zero, or more than one, of its args keys is left unconsumed by pattern captures (exactly one must be left for the attachment to fill), or the one key it fills is of a type the attachment can never satisfy (a table is string[][], a docstring is a string).",
    severity: "error",
    fix: "Leave exactly one args key that no capture fills, typed string[][] for a table or string for a docstring, or remove the attachment from the line.",
  },
  "then-compat-step": {
    description:
      "A compat step is bound in Then position. A compat step cannot declare claims, so nukadoko cannot see what it judges.",
    severity: "warning",
    fix: "Move the step to defineStep with claims, or move the line out of Then position.",
  },
  "then-without-claims": {
    description:
      "A typed step that runs is bound in Then position. A Then judges through claims; a step that only reads or records a value belongs in a Given or When.",
    severity: "error",
    fix: "Bind a claim step (defineStep with claims) at this line, or move the line to Given or When.",
  },
  "tracked-secret-looking-key": {
    description:
      "An envFile tracked by git defines a key that looks like a secret by name, but that key is not in secrets.redact.",
    severity: "warning",
    fix: "Add the key to secrets.redact, or move it to an envFile that git does not track.",
  },
  "undefined-step": {
    description: "No step definition matches a line in a feature file.",
    severity: "error",
    fix: "Run nuka scaffold --feature with the feature file to write a stub for each undefined line, or reword the line to match a step that exists.",
  },
  "undefined-step-check-suppressed": {
    description:
      "A step file failed to import, or a line would match a step whose pattern has an unregistered parameter type, so the undefined-step finding that cause could explain is held back until it is fixed.",
    severity: "warning",
    fix: "Fix the step-file-import-failed or playwright-missing finding, or the pattern error, that held it back, then run nuka check again.",
  },
  "unfillable-required-key": {
    description:
      "A step's args key is required, but nothing on this line (no pattern capture, no table/docstring attachment, and no declared from) can ever fill it.",
    severity: "error",
    fix: "Capture the key in the pattern, attach a table or a docstring, declare from for the key, or make the key optional.",
  },
  "unknown-capture-key": {
    description: "A pattern captures a key that is not a key of the step's args schema.",
    severity: "error",
    fix: "Rename the capture to a key of the args schema, or add the key to the schema.",
  },
  "unknown-parameter-type": {
    description:
      "A pattern names a parameter type this project has not registered, such as {custom} with no matching config.parameterTypes entry.",
    severity: "error",
    fix: "Register the type in config.parameterTypes, or use a built-in type such as {key:string}.",
  },
  "unnamed-capture": {
    description:
      "A step's pattern has a capture with no name, such as {int} instead of {key:int}; every capture must name the args key it fills.",
    severity: "error",
    fix: "Name the capture after the args key that it fills, as {key:type}.",
  },
  "unsupported-hook-tag-expression": {
    description: "A compat hook's tag expression could not be parsed, so nukadoko cannot tell which scenarios it applies to.",
    severity: "error",
    fix: "Rewrite the hook's tags as a tag expression that nukadoko parses, such as @a and not @b.",
  },
  "unterminated-capture": {
    description: "A pattern has an opening { with no matching closing }, so the pattern cannot be parsed.",
    severity: "error",
    fix: "Close the capture with }, or escape a literal { as \\{.",
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

/** The registry's general `fix` for `code`. */
export function checkCodeFix(code: CheckCode): string {
  return CHECK_CODES[code].fix;
}

export function isCheckCode(code: string): code is CheckCode {
  return Object.hasOwn(CHECK_CODES, code);
}

export function checkCodeInfo(code: CheckCode): CheckCodeInfo {
  return CHECK_CODES[code];
}
