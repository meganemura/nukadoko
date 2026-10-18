import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { rankRunsNewestFirst } from "../src/record/newest-run.js";

// Responsibility: the newest-run rule retention and `nuka tend` share, through its one ranking function.

interface Run {
  readonly run_id: string;
  readonly started_at: string;
}

const UNPARSABLE = ["", "not a date", "2026-13-45T00:00:00Z"];

const runsGen = gs
  .arrays(
    gs.oneOf(
      gs.integers({ minValue: 0, maxValue: 1_000_000 }).map((ms) => new Date(ms).toISOString()),
      gs.sampledFrom(UNPARSABLE),
    ),
    { minSize: 0, maxSize: 20 },
  )
  .map((starts) => starts.map((startedAt, index): Run => ({ run_id: `run-${index}`, started_at: startedAt })));

function shape(ranked: readonly { runId: string; startedAt: number }[]): [string, number][] {
  return ranked.map((run) => [run.runId, run.startedAt]);
}

describe("rankRunsNewestFirst", () => {
  it("ranks every run whose start parses by that start, newest first, and leaves out every other run", () =>
    hegel.test((tc) => {
      const runs = tc.draw(runsGen);
      const expected = runs
        .filter((run) => !UNPARSABLE.includes(run.started_at))
        .map((run): [string, number] => [run.run_id, Date.parse(run.started_at)])
        .sort((a, b) => b[1] - a[1] || (b[0] < a[0] ? -1 : b[0] > a[0] ? 1 : 0));
      expect(shape(rankRunsNewestFirst(runs))).toEqual(expected);
    }));

  it("does not depend on the order runs arrive in", () =>
    hegel.test((tc) => {
      const runs = tc.draw(runsGen);
      const keys = runs.map(() => tc.draw(gs.integers({ minValue: 0, maxValue: 1_000_000 })));
      const shuffled = runs
        .map((run, index) => ({ run, key: keys[index]! }))
        .sort((a, b) => a.key - b.key)
        .map((entry) => entry.run);
      expect(shape(rankRunsNewestFirst(shuffled))).toEqual(shape(rankRunsNewestFirst(runs)));
    }));

  it("ranks two runs with one start by the later run id first", () => {
    expect(
      shape(
        rankRunsNewestFirst([
          { run_id: "run-20260901-000000-aaaa", started_at: "2026-09-01T00:00:00Z" },
          { run_id: "run-20260901-000000-bbbb", started_at: "2026-09-01T00:00:00Z" },
        ]),
      ),
    ).toEqual([
      ["run-20260901-000000-bbbb", Date.parse("2026-09-01T00:00:00Z")],
      ["run-20260901-000000-aaaa", Date.parse("2026-09-01T00:00:00Z")],
    ]);
  });
});
