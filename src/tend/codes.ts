// Responsibility: every finding code `nuka tend` can report, each with the
// one-line description `nuka tend --codes` prints. `TendCode`, the union
// of this registry's keys, types `TendIssue.code`, so a tend module that pushes a code missing here fails
// to compile. The `--fail-on` refusal and the llms.txt table both read
// this one list.
//
// No severity field, unlike src/check/codes.ts: every tend finding is a
// note, so the field would hold one value for every code.

export interface TendCodeInfo {
  readonly description: string;
  /** The general edit for the code, in words. A finding uses it as its
   * own `fix` unless the place that raises it knows a more exact one. No
   * tend code has a command that is known to fix it, so none has a `do`. */
  readonly fix: string;
}

const TEND_CODE_INFO = {
  "fixture-replaces-builtin": {
    description:
      "A config.fixtures definition has the name of a builtin fixture that a project may replace (scratch), so it replaces the builtin.",
    fix: "Delete the fixture and its StepFixtures declaration if the builtin covers what it does; keep both if the project needs its own shape.",
  },
  "fixture-touches-app": {
    description:
      "A config.fixtures definition reaches page, context, or pageAs, directly or through another fixture, so it can set up a precondition that no feature line names.",
    fix: "If a scenario depends on what the fixture sets up, write that setup as a feature line. If not, no change is necessary.",
  },
  "fixture-unused": {
    description: "No typed step requires a config.fixtures definition, directly or through another fixture.",
    fix: "Remove the fixture from config.fixtures, or keep it for nuka do.",
  },
  "from-unused": {
    description:
      "A step's from declaration never supplies a value, because every feature line that binds the step fills that key with a pattern capture.",
    fix: "Remove the from entry for the key, or keep it for nuka do --use.",
  },
  "package-type-missing": {
    description:
      'A package.json with no "type" field governs a .ts or .js file nukadoko loads, so Node parses the file twice and prints a MODULE_TYPELESS_PACKAGE_JSON warning on every load.',
    fix: 'Add "type": "module" to the package.json, or rename the files to .mts if the project\'s own .js files are CommonJS.',
  },
  "parameter-type-support-origin": {
    description:
      "A compat defineParameterType call in support code still registers a parameter type; config.parameterTypes is where a typed project declares it.",
    fix: "Move the defineParameterType call into config.parameterTypes, unless a RegExp step needs its preferForRegexpMatch.",
  },
  "parameter-type-unused": {
    description: "No typed or compat pattern names a config.parameterTypes entry.",
    fix: "Remove the entry from config.parameterTypes, or use it in a pattern.",
  },
  "pattern-unbound": {
    description: "A typed step has a pattern, and no feature line resolves to that step alone.",
    fix: "Write a feature line that matches the pattern, or remove the pattern if only nuka do runs the step.",
  },
  "post-navigation-read": {
    description:
      "A step's trace shows a call shortly after a navigation, and nothing shows that the page had finished rendering. The note gives the gap and makes no judgment.",
    fix: "If the read can run before the page renders, wait for the element, or retry the read with ctx.poll.",
  },
  "repeated-scenario-prefix": {
    description:
      "Scenarios in the latest run open with the same steps, before the first When, with the same docstrings and tables. The note reports the measured repetition, and names a process-scope fixture only when every shared step declares mutates: false.",
    fix: "No change is necessary. A Background can hold the shared steps. A process-scope fixture fits only an opening whose steps all declare mutates: false.",
  },
  "schema-field-undescribed": {
    description: "A field of a typed step's args or returns schema has no .describe(), so an agent choosing a step cannot read what it means.",
    fix: "Add a .describe() that says what the field means to each field that the message names.",
  },
  "secrets-public-key-unknown": {
    description: "A secrets.public entry names a key that no envFile defines.",
    fix: "Define the key in an envFile, or remove it from secrets.public.",
  },
  "secrets-redact-key-unknown": {
    description: "A secrets.redact entry names a key that no envFile defines.",
    fix: "Define the key in an envFile, or remove it from secrets.redact.",
  },
  "step-description-todo": {
    description: "A typed step's description is still the placeholder nuka scaffold wrote.",
    fix: "Replace the description with one sentence that says what the step does.",
  },
} as const satisfies Record<string, TendCodeInfo>;

export type TendCode = keyof typeof TEND_CODE_INFO;

export interface TendCodeEntry extends TendCodeInfo {
  readonly code: TendCode;
}

/** Every registered code, code ascending, the order `nuka tend --codes`
 * prints in both forms. */
export function listTendCodes(): TendCodeEntry[] {
  return (Object.keys(TEND_CODE_INFO) as TendCode[])
    .sort((a, b) => a.localeCompare(b))
    .map((code) => ({ code, ...TEND_CODE_INFO[code] }));
}

/** The registry's general `fix` for `code`. */
export function tendCodeFix(code: TendCode): string {
  return TEND_CODE_INFO[code].fix;
}
