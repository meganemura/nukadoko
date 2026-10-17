// Responsibility: every finding code `nuka tend` can report, each with the
// one-line description `nuka tend --codes` prints and whether a plain run
// reports it. `TendCode`, the union of this registry's keys, types
// `TendIssue.code`, so a tend module that pushes a code missing here fails
// to compile. The `--fail-on` refusal, the `--all` selection, and the
// llms.txt table all read this one list.
//
// No severity field, unlike src/check/codes.ts: every tend finding is a
// note, so the field would hold one value for every code.

export interface TendCodeInfo {
  readonly description: string;
  /** False for a code a run reports only under `--all`, or when
   * `--fail-on` names it. */
  readonly reportedByDefault: boolean;
}

const TEND_CODE_INFO = {
  "fixture-touches-app": {
    description:
      "A config.fixtures definition reaches page or context, directly or through another fixture, so it can set up a precondition that no feature line names.",
    reportedByDefault: true,
  },
  "fixture-unused": {
    description: "No typed step requires a config.fixtures definition, directly or through another fixture.",
    reportedByDefault: true,
  },
  "from-unused": {
    description:
      "A step's from declaration never supplies a value, because every feature line that binds the step fills that key with a pattern capture.",
    reportedByDefault: true,
  },
  "parameter-type-support-origin": {
    description:
      "A compat defineParameterType call in support code still registers a parameter type; config.parameterTypes is where a typed project declares it.",
    reportedByDefault: true,
  },
  "parameter-type-unused": {
    description: "No typed or compat pattern names a config.parameterTypes entry.",
    reportedByDefault: true,
  },
  "pattern-unbound": {
    description: "A typed step has a pattern, and no feature line resolves to that step alone.",
    reportedByDefault: true,
  },
  "post-navigation-read": {
    description:
      "A step's trace shows a call shortly after a navigation, and nothing shows that the page had finished rendering. The note gives the gap and makes no judgment.",
    reportedByDefault: true,
  },
  "repeated-scenario-prefix": {
    description:
      "Scenarios in the latest run open with the same steps. The note reports the measured repetition and recommends no fix.",
    reportedByDefault: true,
  },
  "schema-field-undescribed": {
    description: "A field of a typed step's args or returns schema has no .describe(), so an agent choosing a step cannot read what it means.",
    reportedByDefault: false,
  },
  "secrets-public-key-unknown": {
    description: "A secrets.public entry names a key that no envFile defines.",
    reportedByDefault: true,
  },
  "secrets-redact-key-unknown": {
    description: "A secrets.redact entry names a key that no envFile defines.",
    reportedByDefault: true,
  },
  "step-description-todo": {
    description: "A typed step's description is still the placeholder nuka scaffold wrote.",
    reportedByDefault: true,
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
