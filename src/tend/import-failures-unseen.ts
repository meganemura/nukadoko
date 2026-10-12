import type { TendIssue } from "./types.js";

// Responsibility: `nuka tend`
// (src/tend/analyze.ts) discovers steps with `{ tolerateImportFailures:
// true }`, the same tolerant mode `nuka check` uses. A broken glue file's
// steps are then absent from every count and finding here. Without this
// note, a reader cannot tell "this step doesn't exist" from "this step
// exists but couldn't be read". This is the one note that says so.
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
      message: `this report only sees steps that imported successfully; ${count} step file${count === 1 ? "" : "s"} could not be read and ${count === 1 ? "is" : "are"} missing from every count and finding here (run "nuka check" for detail): ${files}`,
    },
  ];
}
