import * as gs from "@hegeldev/hegel/generators";

// Lines of execution events for the tests of src/execution-events/ and
// of the step reader: two traces of one world, the span ids a step
// stamped, and a generator of every sort of line a trace can hold.

export const PREFIX = "4bf92f35";
export const T = `${PREFIX}77b34da6a3ce929d0e0e4736`;
export const U = `${PREFIX}0123456789abcdef01234567`;
export const SPANS = ["00f067aa0ba902b7", "b7ad6b7169203331", "1111111111111111"];
const UNSTAMPED = "2222222222222222";
export const JOBS = ["3f2a9c41", "77aa01"];
/** The request line's id, and two transactions: the first a savepoint
 * inside the second, the second inside the request. */
export const REQUEST_ID = "5a0f3c9e1b7d2486";
export const TX_IDS = ["c7e2a1f04b9d3866", "d1e2f3a4b5c6d7e8"];
/** Where a write line's commit state comes from: its own `committed`,
 * nothing, a transaction of TX_IDS, or an id no line carries. */
export const WRITE_PARENTS = ["committed", "not-committed", "none", "savepoint", "transaction", "elsewhere"] as const;

export const traceparent = (trace: string, span: string): string => `00-${trace}-${span}-01`;

// One line of a trace, by what it is: a request line with a stamped span,
// a bare trace id, or a span the step did not send; a statement; a job's
// two phases; a writer's own kind; a kind the format does not define; a
// line of a later version; the first half of a line another write cut,
// which carries the trace id first; a transaction's end; and an insert
// whose commit state comes from WRITE_PARENTS.
export type Op =
  | readonly ["request", number]
  | readonly ["db"]
  | readonly ["enqueue" | "perform", number]
  | readonly ["extension" | "undefined-kind" | "unknown-version" | "damaged"]
  | readonly ["tx", number, "commit" | "rollback"]
  | readonly ["write", (typeof WRITE_PARENTS)[number]];

export const op: gs.Generator<Op> = gs.oneOf<Op>(
  gs.integers({ minValue: -1, maxValue: SPANS.length }).map((span): Op => ["request", span]),
  gs.just<Op>(["db"]),
  gs.tuples(gs.sampledFrom(["enqueue", "perform"] as const), gs.integers({ minValue: 0, maxValue: JOBS.length - 1 })).map(([phase, job]): Op => [phase, job]),
  gs.sampledFrom(["extension", "undefined-kind", "unknown-version", "damaged"] as const).map((kind): Op => [kind]),
  gs.tuples(gs.integers({ minValue: 0, maxValue: TX_IDS.length - 1 }), gs.sampledFrom(["commit", "rollback"] as const)).map(([tx, phase]): Op => ["tx", tx, phase]),
  gs.sampledFrom(WRITE_PARENTS).map((parent): Op => ["write", parent]),
);

/** The text of `op` in `trace`. `other` is a trace id that a value of
 * the line names, which owns nothing; it comes before `trace` in the
 * text, where a rule that read the first id in the text would take it. */
export function render(entry: Op, trace: string, other: string, extra: string): string {
  const whole = traceparent(trace, SPANS[0]!);
  switch (entry[0]) {
    case "request": {
      const [, span] = entry;
      const value = span === -1 ? trace : traceparent(trace, span === SPANS.length ? UNSTAMPED : SPANS[span]!);
      return JSON.stringify({ x_from: traceparent(other, SPANS[0]!), trace: value, kind: "request", id: REQUEST_ID, method: "GET", route: "/rooms/:id", status: 200 });
    }
    case "db":
      return JSON.stringify({ parent: traceparent(other, SPANS[1]!), trace: whole, kind: "db", table: "scores", op: "insert", x_note: `é漢🙂${extra}` });
    case "enqueue":
    case "perform":
      return JSON.stringify({ trace: whole, kind: "job", name: "ScoreRecalcJob", phase: entry[0], job_id: JOBS[entry[1]] });
    case "extension":
      return JSON.stringify({ trace: whole, kind: "x_cache", key: other });
    case "undefined-kind":
      return JSON.stringify({ trace: whole, kind: "queue", depth: 3 });
    case "unknown-version":
      return JSON.stringify({ trace: whole, kind: "db", table: "t", op: "read", v: 2 });
    case "damaged":
      return `{"trace":"${whole}","kind":"db","x_note":"${other}`;
    case "tx":
      return JSON.stringify({ trace: whole, kind: "tx", id: TX_IDS[entry[1]], parent: entry[1] === 0 ? TX_IDS[1] : REQUEST_ID, phase: entry[2] });
    case "write": {
      const from = { committed: { committed: true }, "not-committed": { committed: false }, none: {}, savepoint: { parent: TX_IDS[0] }, transaction: { parent: TX_IDS[1] }, elsewhere: { parent: "0123abcd0123abcd" } }[entry[1]];
      return JSON.stringify({ trace: whole, kind: "db", table: "scores", op: "insert", ...from });
    }
  }
}
