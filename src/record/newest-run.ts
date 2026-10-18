// Responsibility: the one rule for which `nuka run` is newer than another.
// Retention keeps the newest runs and `nuka tend` reads the newest run, so
// both rank runs here and never disagree about which run that is. Reading
// run.json, and what to do with a run once it is ranked, stay with each
// caller.
//
// A run starts at its run.json `started_at`, the start of the invocation. A
// long run that began first is the older run, however late it finished.
//
// A run whose `started_at` does not parse is left out of the ranking.
// nukadoko always writes an ISO 8601 time there, so a value that does not
// parse is damage, and a damaged run.json cannot date its run. Ranking such
// a run as the newest would let it displace a real run in retention.

export interface RunStart {
  readonly runId: string;
  /** Epoch milliseconds of the run's start. */
  readonly startedAt: number;
}

/** Newest first: the later start, then the later run id, since a run id
 * carries its own wall-clock digits. Total, so a sort by it does not depend
 * on the order the runs arrive in. */
export function compareNewestFirst(a: RunStart, b: RunStart): number {
  return b.startedAt - a.startedAt || (b.runId < a.runId ? -1 : b.runId > a.runId ? 1 : 0);
}

/** `runs` newest first, each paired with its start. A run whose
 * `started_at` does not parse is left out. */
export function rankRunsNewestFirst<R extends { readonly run_id: string; readonly started_at: string }>(
  runs: readonly R[],
): (RunStart & { readonly run: R })[] {
  return runs
    .flatMap((run) => {
      const startedAt = typeof run.started_at === "string" ? Date.parse(run.started_at) : Number.NaN;
      return Number.isNaN(startedAt) ? [] : [{ runId: run.run_id, startedAt, run }];
    })
    .sort(compareNewestFirst);
}
