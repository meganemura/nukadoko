// Responsibility: what replaced an export nukadoko removed, for a config or
// a step file that still imports it. Node's own message says only that the
// module does not provide the export, which reads like a typo or a broken
// install; the file needs to be moved across instead, and the reader needs
// to know where to. Boundary: reading Node's missing-export message for
// nukadoko's own entry points; how the failure is reported, and which code
// it carries, is the caller's (src/config/import-failure.ts).
//
// Only `nukadoko` itself is matched. Another module that lacks a name of
// the same spelling says nothing about nukadoko, so it gets nothing here.

/** The sentence a missing export's message gains, and the `fix` its
 * finding carries in place of the code's general one. */
export interface RemovedExport {
  readonly sentence: string;
  readonly fix: string;
}

const UPGRADING = 'docs/upgrading.md in the nukadoko package, under "The program under test moves to nukadoko.program.ts"';

const PROGRAM_MOVED = 'CHANGELOG.md in the nukadoko package, under "The program moves into the config"';

const REMOVED_EXPORTS: Readonly<Record<string, RemovedExport>> = {
  runServer: {
    sentence:
      "; runServer was removed from nukadoko: the program function of nukadoko.config.ts describes the program under test now, and nukadoko starts it once per run with serve: { command, ready } and stops it after",
    fix: `Remove runServer and the fixture that called it, and write the program's command under program in nukadoko.config.ts instead; ${UPGRADING}, shows the move.`,
  },
  defineProgram: {
    sentence: "; defineProgram was removed from nukadoko: the program under test is the program function of nukadoko.config.ts now",
    fix: `Move the object defineProgram wrapped into nukadoko.config.ts as program: () => ({ ... }), and delete nukadoko.program.ts; ${PROGRAM_MOVED}, shows the move.`,
  },
};

const MISSING_EXPORT = /The requested module '([^'\r\n]+)' does not provide an export named '([^'\r\n]+)'/;

/** What replaced the export Node's `message` says nukadoko does not
 * provide, or `undefined` when the message is about anything else. Pure. */
export function removedExport(message: string): RemovedExport | undefined {
  const match = MISSING_EXPORT.exec(message);
  if (match === null || match[1] !== "nukadoko") return undefined;
  return Object.hasOwn(REMOVED_EXPORTS, match[2]!) ? REMOVED_EXPORTS[match[2]!] : undefined;
}
