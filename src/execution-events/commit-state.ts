import type { JsonObject, ReadableLine } from "./format.js";

// Responsibility: whether a db line's change persisted, from the lines of
// its trace alone (docs/execution-events.md "Whether a statement's change
// persisted"). Pure. Boundary: which lines are the trace's is the
// caller's; the op, the status, and the table never decide it.
//
// The rules, as the format states them:
//
// 1. A line that has `committed` is in that state, unless a `tx` on its
//    parent chain rolled back, which makes the state unknown.
// 2. Otherwise `parent` is followed while it names a `tx` line of the
//    trace. The change persisted when every `tx` on that chain committed,
//    and did not when any of them rolled back. The state is unknown when
//    the chain names an id no line of the trace has (yet), or an id that
//    appears on two lines.
// 3. A line with neither `committed` nor a `tx` parent is unknown.
//
// Unknown is never read as either answer. The chain ends at a line that is
// not a `tx` (a request, a job, a writer's own kind), and at a line whose
// kind or version the reader does not know it is unknown, since that line
// may be a `tx`. A rollback on the chain decides rule 2 even when the chain
// goes on past it to an id no line has yet: an outer transaction is written
// after the savepoints inside it, and whatever it does, it cannot make a
// statement a savepoint undid persist. The walk stops at the first id that
// appears on two lines, so a rollback decides only when every id before it
// names one line. Under rule 1
// an id no line has yet leaves the line's own value standing: a statement
// outside every transaction names the job or the request around it, whose
// line is written after its own.
//
// The index keeps every id the trace's lines carry, so its size is the
// trace's, never the file's.

export type CommitState = "persisted" | "not-persisted" | "unknown";

/** What a line that carries an id is, for a chain that reaches it. */
type IdLine =
  | { readonly is: "tx"; readonly rolledBack: boolean; readonly parent: unknown }
  | { readonly is: "other" }
  /** A kind or a version the reader does not know: it may be a `tx`. */
  | { readonly is: "unknown" };

export interface CommitIndex {
  /** A readable line of the trace, in any order. */
  note(line: ReadableLine): void;
  /** The state of a db line's change, from the lines noted so far. */
  stateOf(object: JsonObject): CommitState;
}

function idLineOf(line: ReadableLine): IdLine {
  if (line.state === "undefined-kind" || line.state === "unknown-version") return { is: "unknown" };
  if (line.state === "event" && line.kind === "tx") return { is: "tx", rolledBack: line.object.phase === "rollback", parent: line.object.parent };
  return { is: "other" };
}

export function createCommitIndex(): CommitIndex {
  const byId = new Map<string, IdLine>();
  const repeated = new Set<string>();
  return {
    note(line) {
      const id = line.object.id;
      if (typeof id !== "string") return;
      if (byId.has(id)) repeated.add(id);
      else byId.set(id, idLineOf(line));
    },
    stateOf(object) {
      const own = object.committed;
      if (own !== undefined && typeof own !== "boolean") return "unknown";
      // How the chain of `tx` lines from the line's parent ends.
      let ends: "rolled-back" | "dangling" | "ambiguous" | "committed" | "no-tx" = "no-tx";
      const seen = new Set<string>();
      let next: unknown = object.parent;
      let txs = 0;
      for (;;) {
        if (next === undefined) {
          ends = txs > 0 ? "committed" : "no-tx";
          break;
        }
        if (typeof next !== "string" || seen.has(next) || repeated.has(next)) {
          ends = "ambiguous";
          break;
        }
        seen.add(next);
        const found = byId.get(next);
        if (found === undefined) {
          ends = "dangling";
          break;
        }
        if (found.is === "unknown") {
          ends = "ambiguous";
          break;
        }
        if (found.is === "other") {
          ends = txs > 0 ? "committed" : "no-tx";
          break;
        }
        if (found.rolledBack) {
          ends = "rolled-back";
          break;
        }
        txs += 1;
        next = found.parent;
      }
      if (own !== undefined) {
        if (ends === "rolled-back" || ends === "ambiguous") return "unknown";
        return own ? "persisted" : "not-persisted";
      }
      if (ends === "rolled-back") return "not-persisted";
      if (ends === "committed") return "persisted";
      return "unknown";
    },
  };
}
