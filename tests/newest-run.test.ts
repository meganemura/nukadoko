import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { groupRunsNewestFirst, type RunGroup } from "../src/record/newest-run.js";

// Responsibility: the newest-run rule retention, `nuka accept`, and
// `nuka tend` share, through its one grouping function.

interface Record {
  readonly id: string;
  readonly run_id: string;
  readonly started_at: string;
}

const UNPARSABLE = ["", "not a date", "2026-13-45T00:00:00Z"];

const recordsGen = gs
  .arrays(
    gs.tuples(
      gs.integers({ minValue: 0, maxValue: 3 }),
      gs.oneOf(
        gs.integers({ minValue: 0, maxValue: 1_000_000 }).map((ms) => new Date(ms).toISOString()),
        gs.sampledFrom(UNPARSABLE),
      ),
    ),
    { minSize: 0, maxSize: 20 },
  )
  .map((entries) =>
    entries.map(([run, startedAt], index): Record => ({ id: `scn-${index}`, run_id: `run-${run}`, started_at: startedAt })),
  );

function shape(groups: readonly RunGroup<Record>[]): [string, number, string[]][] {
  return groups.map((group) => [group.runId, group.startedAt, group.records.map((record) => record.id).sort()]);
}

describe("groupRunsNewestFirst", () => {
  it("dates each run by its earliest parsable start, newest first, and leaves out every record whose start does not parse", () =>
    hegel.test((tc) => {
      const records = tc.draw(recordsGen);
      const dated = records.filter((record) => !UNPARSABLE.includes(record.started_at));
      const expected = [...new Set(dated.map((record) => record.run_id))]
        .map((runId): [string, number, string[]] => {
          const own = dated.filter((record) => record.run_id === runId);
          return [runId, Math.min(...own.map((record) => Date.parse(record.started_at))), own.map((record) => record.id).sort()];
        })
        .sort((a, b) => b[1] - a[1] || (b[0] < a[0] ? -1 : b[0] > a[0] ? 1 : 0));
      expect(shape(groupRunsNewestFirst(records))).toEqual(expected);
    }));

  it("does not depend on the order records arrive in", () =>
    hegel.test((tc) => {
      const records = tc.draw(recordsGen);
      const keys = records.map(() => tc.draw(gs.integers({ minValue: 0, maxValue: 1_000_000 })));
      const shuffled = records
        .map((record, index) => ({ record, key: keys[index]! }))
        .sort((a, b) => a.key - b.key)
        .map((entry) => entry.record);
      expect(shape(groupRunsNewestFirst(shuffled))).toEqual(shape(groupRunsNewestFirst(records)));
    }));

  it("ranks a long run that began first as the older run, though it holds the latest scenario start", () => {
    const groups = groupRunsNewestFirst([
      { id: "a", run_id: "run-long", started_at: "2026-09-01T00:00:00Z" },
      { id: "b", run_id: "run-short", started_at: "2026-09-01T01:00:00Z" },
      { id: "c", run_id: "run-long", started_at: "2026-09-01T02:00:00Z" },
    ]);
    expect(shape(groups)).toEqual([
      ["run-short", Date.parse("2026-09-01T01:00:00Z"), ["b"]],
      ["run-long", Date.parse("2026-09-01T00:00:00Z"), ["a", "c"]],
    ]);
  });
});
