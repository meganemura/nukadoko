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
