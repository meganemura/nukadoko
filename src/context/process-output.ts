// Responsibility: the names of the files that keep what a `runCommand`
// process printed, the input it was given, and, for a process that started
// after its step's record was written, its entry, in a step record's
// evidence directory. Shared by the collector that writes them
// (observed.ts) and by `ctx.evidence`, which refuses a step that asks for
// one of these names (evidence.ts). It writes nothing itself.

export type ProcessStream = "stdout" | "stderr" | "stdin";

/** The file that keeps one stream of the `position`-th process (counted
 * from 1) a step boundary started. */
export function processOutputFileName(position: number, stream: ProcessStream): string {
  return `process-${position}.${stream}.txt`;
}

/** The file that keeps the entry of the `position`-th process when it
 * started after the step's record was written. */
export function lateProcessFileName(position: number): string {
  return `process-${position}.json`;
}

const PROCESS_OUTPUT_FILE = /^process-[1-9][0-9]*\.((stdout|stderr|stdin)\.txt|json)$/;

/** True for a name the harness may write a process's stream or late
 * entry to. Compared in lower case, as every harness file name is: a
 * case-insensitive volume stores one file for both spellings. */
export function isProcessOutputFileName(name: string): boolean {
  return PROCESS_OUTPUT_FILE.test(name.toLowerCase());
}
