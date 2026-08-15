// Responsibility: the page-origin evidence docs/spec.md's "Records"
// (`page_events`) describes — console errors, uncaught page errors, and
// failed requests a browser context saw during a step, none of which
// cucumber-js can hold at all (it has no browser context of its own). Same
// collector shape as observed.ts/sections.ts (`snapshot()`/`reset()`,
// executor-owned, never reachable from a step's own `run`): browser-
// evidence.ts subscribes this collector to `BrowserContext`'s `console`/
// `weberror`/`requestfailed` events once, at context creation, the same
// place it already subscribes `observed` to `request`; create-context.ts
// resets it at each `beginStep` boundary
// the same way it resets `observed`/`sections`/`polls`.
//
// Subscribed on `BrowserContext`, not `Page`: overriding a builtin fixture is legitimate in this design (a
// config author is free to wrap the `page` this module hands back later,
// e.g. to set a default timeout), and a context-level subscription keeps
// recording through that wrap, where a page-level one would silently stop
// the moment the wrapped `page` took over.
//
// Only `console.error` calls are recorded, never `warning`/`log`/etc — a
// warning is something most SPAs emit routinely, and folding it in would
// make this field noise a reader learns to skip, defeating the "green step,
// broken page" signal it exists to carry. `weberror`'s own `Error#stack` is
// deliberately never recorded: it is long, widens what redaction has to
// reach, and trace.zip already carries the full picture for a reader who
// needs it — `message` alone is what answers "did the page throw", the
// question this field exists for.
//
// `at` (ISO 8601) is taken here, by this collector, at record time, never
// supplied by a caller — the same measured-not-declared rule every other
// evidence-collecting piece of `ctx` already follows (sections.ts, polls.ts).
//
// Capped at 100 entries per category: a
// redirect loop or a chatty page can emit thousands of these in one step,
// and a step record that tried to hold all of them would stop being
// something a reader (or an agent) can open. Silently dropping the rest
// would violate "nothing breaks silently" (CLAUDE.md), so a truncated
// category's true count is still reported, but never by changing that
// category's own type: an earlier version reported it by turning the
// category from a bare array into `{ entries, total, truncated: true }`
// once the cap was hit, which meant a step record's own type for
// `console_errors`/`page_errors`/`failed_requests` depended on how many
// entries happened to occur. `jq '.page_events.console_errors | length'`
// then silently returned a different kind of number depending on which
// shape it landed on (element count for the array, key count for the
// object; never the true total either way), the exact "type changes with
// volume so every reader must branch, and the branch that's missing lies
// quietly" failure "Nothing breaks silently" (CLAUDE.md) rules out. Each
// category is now always a bare array, capped at
// `MAX_ENTRIES_PER_CATEGORY`; a category that hit the cap instead adds its
// name to the snapshot's own sibling `truncated` record, mapping it to its
// true total (not the entry count shown) — a key that is present only when
// at least one category was actually truncated, so its mere presence is
// itself the loud signal, and a reader who never checks it still sees a
// consistent array either way.
//
// Redaction is never applied here — deliberately no `SecretSet` parameter,
// no `redact()` call. The whole step record (this collector's own snapshot
// included, once it lands in `StepRecordBase.page_events`) is redacted once, as
// one object, at the same executor call site that already redacts
// `observed`/`used`/every other field (cli/do.ts, run-scenario.ts) — adding
// a second, earlier redaction pass here would let the two disagree about
// what got caught, which is exactly the risk that single-call-site rule
// exists to rule out.

const MAX_ENTRIES_PER_CATEGORY = 100;

/** One `console.error` call, error type only (warning is excluded as
 * noise). */
export interface ConsoleErrorEntry {
  readonly text: string;
  readonly location: {
    readonly url: string;
    readonly lineNumber: number;
    readonly columnNumber: number;
  };
  readonly at: string;
}

/** One uncaught error the page itself threw (`BrowserContext`'s own
 * `weberror`, the context-level counterpart to `Page`'s `pageerror`). Never
 * carries `Error#stack` — see this file's own header for why. */
export interface PageErrorEntry {
  readonly message: string;
  readonly at: string;
}

/** One request the page issued that failed at the network level (DNS,
 * connection refused, aborted, ...) — never a completed response with a
 * non-2xx status, which Playwright's own `requestfailed` event does not fire
 * for either. */
export interface FailedRequestEntry {
  readonly method: string;
  readonly url: string;
  /** `request.failure()?.errorText` — omitted on the rare occasion
   * `failure()` itself returns `null` for a `requestfailed` event (nothing
   * else to report in that case). */
  readonly failure?: string;
  readonly at: string;
}

/** Which of `page_events`'s three categories were truncated, each mapped to
 * its *true* total (how many were actually recorded), never to the number
 * of entries the step record shows (always <= `MAX_ENTRIES_PER_CATEGORY`).
 * Present on the snapshot only when at least one category was truncated —
 * a category that was not is simply absent here,
 * never present with its own entry count or `false`. */
export interface PageEventsTruncated {
  console_errors?: number;
  page_errors?: number;
  failed_requests?: number;
}

/** The step record's own `page_events` shape (docs/spec.md "Records") —
 * each category is always a bare array (never the truncated entry count, and
 * never conditionally shaped some other way; see this file's own header),
 * present only when at least one entry of that kind was recorded. `truncated`
 * is the one place a cap being hit is reported.
 * The whole field is omitted from the step record when all three categories
 * are empty (same convention as `declared`/`sections`/`used`). */
export interface PageEventsSnapshot {
  console_errors?: readonly ConsoleErrorEntry[];
  page_errors?: readonly PageErrorEntry[];
  failed_requests?: readonly FailedRequestEntry[];
  truncated?: PageEventsTruncated;
}

export interface PageEventsCollector {
  /** Records one `console.error` call. `at` is stamped here, not supplied by
   * the caller — see this file's header. */
  recordConsoleError(entry: Omit<ConsoleErrorEntry, "at">): void;
  /** Records one uncaught page error by its message alone. */
  recordPageError(message: string): void;
  /** Records one network-level request failure. */
  recordFailedRequest(entry: Omit<FailedRequestEntry, "at">): void;
  /** What this boundary accumulated since the last `reset()` (or since
   * creation), or `undefined` when nothing was recorded in any of the three
   * categories at all — mirrors `DeclaredCollector.snapshot()`
   * (src/compat/declared.ts), the same "whole object omitted, not merely
   * empty" convention. */
  snapshot(): PageEventsSnapshot | undefined;
  /** Executor-only: zeroes every category's tally at a step boundary. The
   * context's own event subscriptions are untouched — they were set up once,
   * at context creation (browser-evidence.ts), and outlive any number of
   * resets, the same way `observed`'s own `request` subscription does. */
  reset(): void;
}

interface CategoryTally<T> {
  entries: T[];
  total: number;
}

function emptyTally<T>(): CategoryTally<T> {
  return { entries: [], total: 0 };
}

function record<T>(tally: CategoryTally<T>, entry: T): void {
  tally.total += 1;
  if (tally.entries.length < MAX_ENTRIES_PER_CATEGORY) {
    tally.entries.push(entry);
  }
}

// Always a bare array, capped at `MAX_ENTRIES_PER_CATEGORY` by `record()`
// itself; a category's own type never changes with how many entries came in
// (this file's own header). Whether it was truncated is
// reported separately, in `snapshot()` below, from `tally.total`.
function snapshotCategory<T>(tally: CategoryTally<T>): T[] | undefined {
  if (tally.total === 0) {
    return undefined;
  }
  return [...tally.entries];
}

export function createPageEventsCollector(): PageEventsCollector {
  let consoleErrors = emptyTally<ConsoleErrorEntry>();
  let pageErrors = emptyTally<PageErrorEntry>();
  let failedRequests = emptyTally<FailedRequestEntry>();

  return {
    recordConsoleError(entry: Omit<ConsoleErrorEntry, "at">): void {
      record(consoleErrors, { ...entry, at: new Date().toISOString() });
    },
    recordPageError(message: string): void {
      record(pageErrors, { message, at: new Date().toISOString() });
    },
    recordFailedRequest(entry: Omit<FailedRequestEntry, "at">): void {
      record(failedRequests, { ...entry, at: new Date().toISOString() });
    },
    snapshot(): PageEventsSnapshot | undefined {
      const consoleErrorsSnapshot = snapshotCategory(consoleErrors);
      const pageErrorsSnapshot = snapshotCategory(pageErrors);
      const failedRequestsSnapshot = snapshotCategory(failedRequests);
      if (
        consoleErrorsSnapshot === undefined &&
        pageErrorsSnapshot === undefined &&
        failedRequestsSnapshot === undefined
      ) {
        return undefined;
      }
      // `truncated` names only the categories that actually hit the cap,
      // each mapped to its true total, never the (always <= 100) entry
      // count already visible on the category's own array. Present on the
      // snapshot only when non-empty, the
      // same "whole thing omitted, not merely empty" convention every other
      // optional field on this snapshot already follows.
      const truncated: PageEventsTruncated = {
        ...(consoleErrors.total > MAX_ENTRIES_PER_CATEGORY
          ? { console_errors: consoleErrors.total }
          : {}),
        ...(pageErrors.total > MAX_ENTRIES_PER_CATEGORY
          ? { page_errors: pageErrors.total }
          : {}),
        ...(failedRequests.total > MAX_ENTRIES_PER_CATEGORY
          ? { failed_requests: failedRequests.total }
          : {}),
      };
      return {
        ...(consoleErrorsSnapshot !== undefined ? { console_errors: consoleErrorsSnapshot } : {}),
        ...(pageErrorsSnapshot !== undefined ? { page_errors: pageErrorsSnapshot } : {}),
        ...(failedRequestsSnapshot !== undefined
          ? { failed_requests: failedRequestsSnapshot }
          : {}),
        ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
      };
    },
    reset(): void {
      consoleErrors = emptyTally();
      pageErrors = emptyTally();
      failedRequests = emptyTally();
    },
  };
}
