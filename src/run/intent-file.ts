import { readFileSync } from "node:fs";
import path from "node:path";
import type { RunIntent } from "../record/run-result.js";
import { commitsSince, fileAtCommit, repositoryPlace } from "./git-ref.js";
import { INTENT_FILE, parseIntent, type Intent } from "./intent.js";

export { ownFieldsOf, type Intent, type IntentProblem, type IntentRow, type IntentOp, type IntentTerm } from "./intent.js";

// Responsibility: the intent a change declares (docs/intent.md), read
// under `nuka run --base`: the file at the repository's top as head's
// working tree holds it, and what git says of it since the base. Boundary:
// git and the disk only; the format is src/run/intent.ts's, what each row
// came to src/run/intent-view.ts's.
//
// The file is the change's when the change wrote it: a file the base
// already holds unchanged is an earlier change's intent, merged with it,
// and says nothing about this one. So a run reads it only when head's
// text differs from the base's, and a change that removes it declares
// nothing.
//
// The reviewer reads when it was declared: in the change's first commit,
// before anything it judges was written, or later, and each commit since
// that changed it again. A change of intent is itself a difference the
// reviewer approves, so it is named, never folded into the rows.

export interface ChangeIntent {
  readonly intent: Intent;
  /** run.json's `intent`, rows still to judge. */
  readonly record: Omit<RunIntent, "rows">;
}

/** The intent the change at `rootDir` declares against `baseCommit`, or
 * `undefined` when it declares none. Throws a `GitRefError` when git does
 * not answer. */
export async function readChangeIntent(rootDir: string, baseCommit: string): Promise<ChangeIntent | undefined> {
  const { top, prefix } = await repositoryPlace(rootDir);
  let text: string;
  try {
    text = readFileSync(path.join(top, INTENT_FILE), "utf8");
  } catch {
    return undefined;
  }
  if (text === (await fileAtCommit(top, baseCommit, INTENT_FILE))) return undefined;
  const [all, touched] = [await commitsSince(top, baseCommit), await commitsSince(top, baseCommit, INTENT_FILE)];
  const [first, ...later] = touched;
  const atHead = all.length === 0 ? await fileAtCommit(top, baseCommit, INTENT_FILE) : await fileAtCommit(top, all.at(-1)!.commit, INTENT_FILE);
  return {
    intent: parseIntent(text),
    record: {
      // Named from the project, as every path a run prints is.
      // git's prefix, not a relative path between two spellings of one
      // directory, one of which may pass through a link.
      file: `${prefix === "" ? "" : "../".repeat(prefix.split("/").length)}${INTENT_FILE}`,
      declared_in: first === undefined ? null : { ...first, first: first.commit === all[0]?.commit },
      changed_after: later,
      uncommitted: text !== atHead,
      problems: [],
    },
  };
}
