import type { HttpLogEntry } from "../context/http-log-read.js";
import type { RunPageErrorGroup, RunStatusGroup, RunUnderneath } from "../record/run-result.js";
import type { PageEventsSnapshot } from "../record/types.js";
import { firstErrorLine } from "./progress-log.js";

// Responsibility: the failures underneath an execution (docs/spec.md
// "Failures underneath"): what its steps saw of the program failing,
// grouped by what an `@expects:` tag names. Boundary: pure, over a step
// record's `page_events` and the parsed lines of its http.jsonl. Reading
// the files is src/cli/run.ts's, and folding the program's execution
// events into a step's `path` is the world's stop's.
//
// Only a measured failure is counted: a line of http.jsonl with a status
// from 500 to 599, and a page error on the record. Each is the failing
// party's own statement, never a reading of something else: the server
// chose the status, and the browser found no handler for what the page
// threw. What could not be seen (a line that was not written or does not
// parse, a page error past the record's cap) is kept apart as `unseen`,
// and is never counted as a failure.

/** The lowest and highest status a server answers with when it failed. */
const FAILED_STATUS = { from: 500, to: 599 } as const;

/** A step's `underneath`, from its record's `page_events`, its http.jsonl
 * lines (`null` when the file could not be read, empty when the record
 * names none), and its `http_log_failed`. `undefined` when the step saw
 * no failure and missed nothing. Pure. */
export function underneathOfRecord(
  pageEvents: PageEventsSnapshot | undefined,
  http: readonly (HttpLogEntry | null)[] | null,
  httpLogFailed: number | undefined,
): RunUnderneath | undefined {
  const statuses = statusGroups(http ?? []);
  const pageErrors = pageErrorGroups(pageEvents);
  const kept = pageEvents?.page_errors?.length ?? 0;
  const pastCap = pageEvents?.truncated?.page_errors === undefined ? 0 : pageEvents.truncated.page_errors - kept;
  const unparsed = (http ?? []).filter((entry) => entry === null).length;
  const httpLines = http === null ? null : unparsed + (httpLogFailed ?? 0);
  const unseen = {
    ...(httpLines === null || httpLines > 0 ? { http_lines: httpLines } : {}),
    ...(pastCap > 0 ? { page_errors: pastCap } : {}),
  };
  const underneath: RunUnderneath = {
    ...(statuses.length === 0 ? {} : { statuses }),
    ...(pageErrors.length === 0 ? {} : { page_errors: pageErrors }),
    ...(Object.keys(unseen).length === 0 ? {} : { unseen }),
  };
  return Object.keys(underneath).length === 0 ? undefined : underneath;
}

function statusGroups(http: readonly (HttpLogEntry | null)[]): RunStatusGroup[] {
  const groups = new Map<number, { count: number; first: RunStatusGroup["first"] }>();
  http.forEach((entry, index) => {
    if (entry === null || entry.status < FAILED_STATUS.from || entry.status > FAILED_STATUS.to) return;
    const group = groups.get(entry.status);
    if (group !== undefined) {
      group.count += 1;
      return;
    }
    groups.set(entry.status, {
      count: 1,
      first: { method: entry.method, url: entry.url, via: entry.via, http_line: index, ...(entry.as === undefined ? {} : { as: entry.as }) },
    });
  });
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([status, group]) => ({ status, ...group }));
}

function pageErrorGroups(pageEvents: PageEventsSnapshot | undefined): RunPageErrorGroup[] {
  const groups = new Map<string | null, { count: number; first: RunPageErrorGroup["first"] }>();
  for (const entry of pageEvents?.page_errors ?? []) {
    const name = entry.name ?? null;
    const group = groups.get(name);
    if (group !== undefined) {
      group.count += 1;
      continue;
    }
    groups.set(name, { count: 1, first: { message: firstErrorLine(entry.message), ...(entry.as === undefined ? {} : { as: entry.as }) } });
  }
  return [...groups.entries()].map(([name, group]) => ({ name, ...group }));
}
