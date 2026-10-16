// Responsibility: the one rule for which `nuka run` is newer than another.
// Retention keeps the newest runs and `nuka tend` reads the newest run, so
// both group scenario records into runs here and never disagree about which
// run that is. Reading
// the records, and what to do with a run once it is ranked, stay with each
// caller.
//
// A run starts at the earliest `started_at` among its records. A long run
// that began first can hold the latest scenario start of all, and it is still
// the older run.
//
// A record whose `started_at` does not parse is left out of every run, as a
// `record.json` that cannot be read is. nukadoko always writes an ISO 8601
// time there, so a value that does not parse is damage, and a damaged record
// cannot date its run or count as evidence of what the run did. Ranking such
// a run as the newest let it displace a real run in retention.

export interface RunStart {
  readonly runId: string;
  /** Epoch milliseconds of the earliest `started_at` in the run. */
  readonly startedAt: number;
}

export interface RunGroup<R> extends RunStart {
  readonly records: readonly R[];
}

interface DatedRecord {
  readonly run_id: string;
  readonly started_at: string;
}

/** Newest first: the later start, then the later run id, since a run id
 * carries its own wall-clock digits. Total, so a sort by it does not depend
 * on the order the runs arrive in. */
export function compareNewestFirst(a: RunStart, b: RunStart): number {
  return b.startedAt - a.startedAt || (b.runId < a.runId ? -1 : b.runId > a.runId ? 1 : 0);
}

/** `records` grouped by `run_id`, newest run first. A record whose
 * `started_at` does not parse belongs to no group. */
export function groupRunsNewestFirst<R extends DatedRecord>(records: readonly R[]): RunGroup<R>[] {
  const byRun = new Map<string, { startedAt: number; records: R[] }>();
  for (const record of records) {
    const startedAt = typeof record.started_at === "string" ? Date.parse(record.started_at) : Number.NaN;
    if (Number.isNaN(startedAt)) continue;
    const group = byRun.get(record.run_id);
    if (group === undefined) {
      byRun.set(record.run_id, { startedAt, records: [record] });
    } else {
      group.startedAt = Math.min(group.startedAt, startedAt);
      group.records.push(record);
    }
  }
  return [...byRun].map(([runId, group]) => ({ runId, ...group })).sort(compareNewestFirst);
}
