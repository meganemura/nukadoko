// Responsibility: the errors discovery raises on its own (as opposed to
// errors from importing a broken step file, which propagate as-is).
// Each one carries `fix`, the edit a CLI refusal names: a command's --help
// lists no flag that removes a duplicate. Which of the two files to change
// is the author's choice, so the fix names both and no command.

import path from "node:path";

function shown(rootDir: string, filePath: string): string {
  const relative = path.relative(rootDir, filePath);
  return relative.startsWith("..") || path.isAbsolute(relative) ? filePath : relative.split(path.sep).join("/");
}

export class DuplicateStepError extends Error {
  readonly code = "duplicate-step";
  readonly stepName: string;
  readonly firstFilePath: string;
  readonly duplicateFilePath: string;
  readonly fix: string;

  constructor(stepName: string, firstFilePath: string, duplicateFilePath: string, rootDir: string) {
    super(
      `Duplicate step name "${stepName}": already defined at ${firstFilePath}, also found at ${duplicateFilePath}`,
    );
    this.name = "DuplicateStepError";
    this.stepName = stepName;
    this.firstFilePath = firstFilePath;
    this.duplicateFilePath = duplicateFilePath;
    this.fix =
      `Rename ${shown(rootDir, duplicateFilePath)} or ${shown(rootDir, firstFilePath)}: ` +
      "a typed step's name is its file name, so the two files register the same step.";
  }
}

/** The compat-registration analog of `DuplicateStepError`: a compat step's
 * identity is its pattern
 * source text, not a file name (one file can hold many `Given`/`When`/`Then`
 * calls), so two registrations — anywhere in the vocabulary, under any
 * keyword — that resolve to the exact same pattern source collide the same
 * way two typed step files sharing a name do. */
export class DuplicateCompatStepError extends Error {
  readonly code = "duplicate-step";
  readonly patternSource: string;
  readonly firstFilePath: string;
  readonly duplicateFilePath: string;
  readonly fix: string;

  constructor(patternSource: string, firstFilePath: string, duplicateFilePath: string, rootDir: string) {
    super(
      `Duplicate compat step pattern "${patternSource}": already registered at ${firstFilePath}, also found at ${duplicateFilePath}`,
    );
    this.name = "DuplicateCompatStepError";
    this.patternSource = patternSource;
    this.firstFilePath = firstFilePath;
    this.duplicateFilePath = duplicateFilePath;
    this.fix =
      firstFilePath === duplicateFilePath
        ? `Remove one of the two registrations of "${patternSource}" in ${shown(rootDir, firstFilePath)}.`
        : `Remove one of the two registrations of "${patternSource}", in ${shown(rootDir, firstFilePath)} or ${shown(rootDir, duplicateFilePath)}.`;
  }
}

/** `defineWorld` was called more than once in a single discovery run — a
 * second call is always an error, whether both calls are
 * in one file (`firstFilePath === duplicateFilePath`) or two, since
 * src/compat/define-world.ts's own buffer only ever holds registrations,
 * never rejects one itself (the same reason src/compat/registry.ts's
 * `defineParameterType` buffer doesn't either — see that file's header):
 * this function is the one place with the full per-file picture needed to
 * name both offending files. */
export class DuplicateWorldDefinitionError extends Error {
  readonly code = "duplicate-world";
  readonly firstFilePath: string;
  readonly duplicateFilePath: string;
  readonly fix: string;

  constructor(firstFilePath: string, duplicateFilePath: string, rootDir: string) {
    super(
      `Duplicate defineWorld() registration: already defined at ${firstFilePath}, also found at ${duplicateFilePath}`,
    );
    this.name = "DuplicateWorldDefinitionError";
    this.firstFilePath = firstFilePath;
    this.duplicateFilePath = duplicateFilePath;
    this.fix =
      firstFilePath === duplicateFilePath
        ? `Keep one of the defineWorld calls in ${shown(rootDir, firstFilePath)}, and remove the others.`
        : `Keep one defineWorld call: remove the one in ${shown(rootDir, duplicateFilePath)} or the one in ${shown(rootDir, firstFilePath)}.`;
  }
}

/** A step file that did not import. `code` tells a missing Playwright
 * package, which has one install command, from any other import failure,
 * which has no command that is known to fix it. */
export class StepFileImportError extends Error {
  readonly code: "step-file-import-failed" | "playwright-missing";
  readonly fix?: string;
  readonly do?: string;

  constructor(message: string, code: StepFileImportError["code"], hint: { readonly fix?: string; readonly do?: string }, cause: unknown) {
    super(message, { cause });
    this.name = "StepFileImportError";
    this.code = code;
    if (hint.fix !== undefined) this.fix = hint.fix;
    if (hint.do !== undefined) this.do = hint.do;
  }
}
