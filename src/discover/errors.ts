// Responsibility: the errors discovery raises on its own (as opposed to
// errors from importing a broken step file, which propagate as-is).

export class DuplicateStepError extends Error {
  readonly stepName: string;
  readonly firstFilePath: string;
  readonly duplicateFilePath: string;

  constructor(stepName: string, firstFilePath: string, duplicateFilePath: string) {
    super(
      `Duplicate step name "${stepName}": already defined at ${firstFilePath}, also found at ${duplicateFilePath}`,
    );
    this.name = "DuplicateStepError";
    this.stepName = stepName;
    this.firstFilePath = firstFilePath;
    this.duplicateFilePath = duplicateFilePath;
  }
}

/** The compat-registration analog of `DuplicateStepError` (m2a-compat-
 * registry task spec, decision 3): a compat step's identity is its pattern
 * source text, not a file name (one file can hold many `Given`/`When`/`Then`
 * calls), so two registrations — anywhere in the vocabulary, under any
 * keyword — that resolve to the exact same pattern source collide the same
 * way two typed step files sharing a name do. */
export class DuplicateCompatStepError extends Error {
  readonly patternSource: string;
  readonly firstFilePath: string;
  readonly duplicateFilePath: string;

  constructor(patternSource: string, firstFilePath: string, duplicateFilePath: string) {
    super(
      `Duplicate compat step pattern "${patternSource}": already registered at ${firstFilePath}, also found at ${duplicateFilePath}`,
    );
    this.name = "DuplicateCompatStepError";
    this.patternSource = patternSource;
    this.firstFilePath = firstFilePath;
    this.duplicateFilePath = duplicateFilePath;
  }
}

/** `defineWorld` was called more than once in a single discovery run (m2c-
 * typed-world task spec, item 2: a second call is an error) — whether both calls are
 * in one file (`firstFilePath === duplicateFilePath`) or two, since
 * src/compat/define-world.ts's own buffer only ever holds registrations,
 * never rejects one itself (the same reason src/compat/registry.ts's
 * `defineParameterType` buffer doesn't either — see that file's header):
 * this function is the one place with the full per-file picture needed to
 * name both offending files. */
export class DuplicateWorldDefinitionError extends Error {
  readonly firstFilePath: string;
  readonly duplicateFilePath: string;

  constructor(firstFilePath: string, duplicateFilePath: string) {
    super(
      `Duplicate defineWorld() registration: already defined at ${firstFilePath}, also found at ${duplicateFilePath}`,
    );
    this.name = "DuplicateWorldDefinitionError";
    this.firstFilePath = firstFilePath;
    this.duplicateFilePath = duplicateFilePath;
  }
}
