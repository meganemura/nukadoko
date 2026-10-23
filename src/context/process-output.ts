// Responsibility: the names of the files that keep what a `runCommand`
// process printed, in a step record's evidence directory. Shared by the
// collector that writes them (observed.ts) and by `ctx.evidence`, which
// refuses a step that asks for one of these names (evidence.ts). It writes
// nothing itself.

/** The file that keeps one stream of the `position`-th process (counted
 * from 1) a step boundary started. */
export function processOutputFileName(position: number, stream: "stdout" | "stderr"): string {
  return `process-${position}.${stream}.txt`;
}

const PROCESS_OUTPUT_FILE = /^process-[1-9][0-9]*\.(stdout|stderr)\.txt$/;

/** True for a name the harness may write a process's output to. Compared
 * in lower case, as every harness file name is: a case-insensitive volume
 * stores one file for both spellings. */
export function isProcessOutputFileName(name: string): boolean {
  return PROCESS_OUTPUT_FILE.test(name.toLowerCase());
}
