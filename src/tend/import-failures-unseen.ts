import type { TendIssue } from "./types.js";

// Responsibility: `nuka tend`
// (src/tend/analyze.ts) discovers steps with `{ tolerateImportFailures:
// true }`, the same tolerant mode `nuka check` uses, but until now silently
// dropped a broken glue file's own steps from every count and finding here
// without ever saying so: a project mid-migration would see `tend`'s own
// numbers quietly shrink with no way to tell "this step doesn't exist" apart
// from "this step exists but couldn't be read" (CLAUDE.md's "Nothing breaks
// silently"). This is the one note that says so.
//
// One note for the whole run, not one per broken file — a broken file's own verdict is
// `nuka check`'s finding (`step-file-import-failed`), not tend's: tend
// looks at what is rotting in what it *can* see, and a file it never even
// read has nothing here to rot yet.

export function findImportFailuresUnseen(
  importFailures: readonly { readonly filePath: string; readonly message: string }[],
): TendIssue[] {
  if (importFailures.length === 0) {
    return [];
  }
  const files = importFailures.map((failure) => failure.filePath).join(", ");
  const count = importFailures.length;
  return [
    {
      code: "import-failures-unseen",
      message: `this report only sees steps that imported successfully; ${count} step file${count === 1 ? "" : "s"} could not be read and are missing from every count and finding here (run "nuka check" for detail): ${files}`,
    },
  ];
}
