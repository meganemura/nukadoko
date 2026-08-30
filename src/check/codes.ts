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
}

export const CHECK_CODES = {
  "additional-feature-dir-missing": {
    description: "An entry in additionalFeatureDirs does not exist on disk.",
    severity: "error",
  },
  "alias-key-mismatch": {
    description: "A step has more than one pattern, and the patterns bind different sets of keys.",
    severity: "error",
  },
  "ambiguous-step": {
    description: "A line in a feature file matches more than one step definition.",
    severity: "error",
  },
  "args-not-object": {
    description:
      "A step has a pattern, but its args schema is not a z.object, so there is no key to check that pattern's captures against.",
    severity: "error",
  },
  "capture-type-mismatch": {
    description:
      "A pattern captures a key as a number ({int} or {float}) or a string ({string} or {word}), but the args schema declares that key as the other type.",
    severity: "error",
  },
  "duplicate-pattern": {
    description:
      "Two or more patterns, once capture names are stripped, normalize to the same text, so one step text could match more than one step.",
    severity: "error",
  },
  "env-file-missing": {
    description: "A configured envFile does not exist on disk, so nothing in it is ever loaded.",
    severity: "warning",
  },
  "environment-env-file-missing": {
    description: "An entry in one environment's own envFiles does not exist on disk.",
    severity: "warning",
  },
  "feature-parse-error": {
    description: "A .feature file could not be parsed, so nothing in it was checked.",
    severity: "error",
  },
  "features-dir-missing": {
    description: "The configured featuresDir does not exist on disk, so no feature or step file under it can load.",
    severity: "error",
  },
  "fixture-cycle": {
    description: "config.fixtures definitions depend on each other in a cycle, so none of them can ever resolve.",
    severity: "error",
  },
  "fixture-scope-violation": {
    description:
      "A config.fixtures definition scoped to run once per process depends on one scoped to run once per scenario.",
    severity: "error",
  },
  "fixture-structural-violation": {
    description:
      "A step's run(), or a config.fixtures definition's own function, is not a plain object-destructuring parameter, or destructures a fixture name nukadoko does not know.",
    severity: "error",
  },
  "from-order-violation": {
    description:
      "A step declares from for a key, and the step or steps it names have not run earlier in the same scenario, or (when the key names more than one candidate) more than one candidate has.",
    severity: "error",
  },
  "from-structural-violation": {
    description: "A step's from names a value that is not a registered step, or is otherwise structurally malformed.",
    severity: "error",
  },
  "invalid-capture-key": {
    description:
      "A pattern capture's name is not a valid identifier: a capture key must start with a letter or underscore and contain only letters, digits, and underscores.",
    severity: "error",
  },
  "no-step-files-found": {
    description:
      "featuresDir exists, but no .ts/.mts/.js/.mjs step file was found while scanning it, so no step can ever be registered.",
    severity: "error",
  },
  "page-override-unowned": {
    description: "A config.fixtures definition overrides page, but owns neither page nor context.",
    severity: "error",
  },
  "parameter-type-invalid": {
    description:
      "Two parameter types share the same name, whether both come from config.parameterTypes or one comes from a compat defineParameterType call.",
    severity: "error",
  },
  "part-cycle": {
    description: "A step's parts form a cycle: the step reaches itself, directly or through other steps' own parts.",
    severity: "error",
  },
  "part-mutates-contradiction": {
    description: "A step declares mutates: false, but declares a part that declares mutates: true.",
    severity: "error",
  },
  "part-structural-violation": {
    description: "A step's parts names a value that is not a registered step, or is otherwise structurally malformed.",
    severity: "error",
  },
  "pattern-error": {
    description:
      "A step's pattern could not be parsed, for a reason other than an unnamed, invalid, or unterminated capture.",
    severity: "error",
  },
  "pattern-syntax-error": {
    description:
      "A pattern failed to build into a cucumber expression, for a reason cucumber-expressions itself reports (not an unknown parameter type).",
    severity: "error",
  },
  "secrets-redact-key-too-short": {
    description:
      "A secrets.redact key's value is shorter than the minimum length build-secret-set.ts will actually redact, so it never gets redacted.",
    severity: "warning",
  },
  "serial-tag-on-scenario": {
    description:
      "A @serial tag is on a Scenario/Scenario Outline line; nuka run --concurrency only reads it from the Feature line, so it has no effect there.",
    severity: "error",
  },
  "step-file-import-failed": {
    description: "A step file under featuresDir failed to import, so any step it defines never reaches the vocabulary.",
    severity: "error",
  },
  "step-file-unsupported-extension": {
    description: "Discovery found a .cjs step file; nukadoko is ESM-only and never imports it.",
    severity: "error",
  },
  "table-docstring-key-mismatch": {
    description:
      "A step's table or docstring is attached to a line, but zero, or more than one, of its args keys is left unconsumed by pattern captures; exactly one must be left for the attachment to fill.",
    severity: "error",
  },
  "then-compat-step": {
    description:
      "A compat step is bound in Then position; compat has no mutates declaration to check that position against.",
    severity: "warning",
  },
  "then-mutates": {
    description: "A step bound in Then position declares mutates: true, so its declaration and its position are in tension.",
    severity: "warning",
  },
  "tracked-secret-looking-key": {
    description:
      "An envFile tracked by git defines a key that looks like a secret by name, but that key is not in secrets.redact.",
    severity: "warning",
  },
  "undefined-step": {
    description: "No step definition matches a line in a feature file.",
    severity: "error",
  },
  "undefined-step-check-suppressed": {
    description:
      "One or more step files failed to import, so undefined-step findings that failure could explain are held back until the import is fixed.",
    severity: "warning",
  },
  "unfillable-required-key": {
    description:
      "A step's args key is required, but nothing on this line (no pattern capture, no table/docstring attachment, and no declared from) can ever fill it.",
    severity: "error",
  },
  "unknown-capture-key": {
    description: "A pattern captures a key that is not a key of the step's args schema.",
    severity: "error",
  },
  "unknown-parameter-type": {
    description:
      "A pattern names a parameter type this project has not registered, such as {custom} with no matching config.parameterTypes entry.",
    severity: "error",
  },
  "unnamed-capture": {
    description:
      "A step's pattern has a capture with no name, such as {int} instead of {key:int}; every capture must name the args key it fills.",
    severity: "error",
  },
  "unsupported-hook-tag-expression": {
    description: "A compat hook's tag expression could not be parsed, so nukadoko cannot tell which scenarios it applies to.",
    severity: "error",
  },
  "unterminated-capture": {
    description: "A pattern has an opening { with no matching closing }, so the pattern cannot be parsed.",
    severity: "error",
  },
} as const satisfies Record<string, CheckCodeInfo>;

export type CheckCode = keyof typeof CHECK_CODES;

/** Every registered code, in code-ascending order — the one ordering
 * `nuka check --codes` (human-readable and `--json` alike) promises, and
 * the one this function itself is trusted to produce rather than leaving
 * each caller to sort a second time. */
export function listCheckCodes(): ReadonlyArray<{ code: CheckCode; description: string; severity?: CheckSeverity }> {
  return (Object.keys(CHECK_CODES) as CheckCode[])
    .sort((a, b) => a.localeCompare(b))
    .map((code) => ({ code, ...CHECK_CODES[code] }));
}
