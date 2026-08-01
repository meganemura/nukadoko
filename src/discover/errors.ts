// Responsibility: the one error discovery raises on its own (as opposed to
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
