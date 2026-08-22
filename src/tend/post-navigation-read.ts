import { readFileSync } from "node:fs";
import path from "node:path";
import { discoverMarkdownFiles, parseAcceptanceRecord } from "./record-parse.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s post-navigation-read note - a
// step whose own trace shows it made another
// call a short time after a navigation call, with nothing here saying
// whether the page had actually finished rendering by then.
//
// Why this note exists: a step failed on "button not found" because it read
// 1.9s after its last navigation, while that same page measured 4-6s to
// finish rendering. Two days earlier, other steps with the identical shape
// had already been fixed; this one stayed green in the meantime purely on
// timing, and the fix left for it said as much. Green, in that state, was
// never proof the read was safe - only that it happened not to lose the
// race that time.
//
// **Deliberately not a judgment**, the same words fixture-touches-app.ts's
// own header uses for its own finding: this tool has no way to know how
// long any given application takes to render after a navigation call
// resolves, so this note never says a gap is unsafe, only what the gap was.
// A page with no delayed rendering has nothing to worry about here at any
// gap. For the same reason, no table classifying which Playwright calls
// auto-wait and which return on the first attempt is built to help decide
// that ("thin over official APIs" - such a table describes semantics that
// change by version, not something this tool measured, and none exists
// anywhere else in this codebase). What is read is only the fact trace
// itself already carries: a call's own method name, when it ended, and when
// the next call started.
//
// The note's own text names that exclusion, which is the only shape that
// makes this note stop being true: a reader who wants to act on it has
// nowhere else to learn that, and one who reaches for a direct browser
// wait instead writes a call this note then reports in its turn, reading
// as though nothing silences it. Naming the shape is still not a verdict
// on the gap, which this note never gives.
//
// A read that lands inside a `ctx.poll` call's own window is excluded:
// `docs/spec.md:350-375` already asks a step to
// use `poll()` rather than a direct browser wait precisely so a delayed
// render cannot flake it, and a step written that way is the thing this
// note exists to tell apart from - not another instance of it. That
// judgment is a plain timestamp comparison against the step record's own
// `polls` (never a table of which Playwright method names count as a
// "read", for the same reason the paragraph above already gives), and it
// is skipped entirely for a step record with no `polls` at all - a compat
// step, a step that never calls `ctx.poll`, or a record from before `polls`
// existed all fall back to this note's original behavior, unchanged.
//
// Reads only sign-off records (src/tend/record-parse.ts, the same source
// signoff-rot.ts and signoff-condition-mismatch.ts already walk), never a
// live run's own step record - that module's own `EXCLUDED_DIR_NAMES` keeps
// `.nukadoko` out of every walk built on it, this one included, and nothing
// here changes that list.
//
// A Background step runs once per scenario, so a suite with two dozen
// scenarios produces two dozen step records for that one step, all
// measuring the same thing: one navigation call, the same call right
// after it - whether those step records sit in one accepted file or many,
// since one accepted record already holds one step record per scenario in
// its own `scenarios:` list. Reporting each of those as its own note would
// repeat one fact two dozen times rather than say it once - `groupMatches`
// (below) merges every match sharing the same step, the same navigation
// method, and the same following method into a single note, naming how
// many step records it happened in and the gap's own range, before
// reporting one example record rather than all of them.

/** The four navigation calls this note looks for, read verbatim off each
 * action's own `method` (trace's own `before.method`, src/context/
 * trace-actions.ts's `ActionEntry`) - never inferred from a URL change or
 * any other signal, and never grown past this list. A form submit or a
 * client-side router can navigate too, but
 * neither leaves a trace call under one of these four names, so this note
 * simply has nothing to say about either case - narrower coverage, not a
 * wrong verdict, is the trade-off that keeps this list from turning into
 * the classification table the paragraph above already rules out. */
const NAVIGATION_METHODS = new Set(["goto", "reload", "goBack", "goForward"]);

/**
 * Above this many milliseconds, a navigation-to-next-call gap is not listed
 * at all. Chosen to answer "this gap is
 * far enough apart that listing it adds little", never "this gap is short
 * enough to be unsafe" - the two would-be sources for a stricter number
 * (this note's own motivating incident) point the same way. That incident's
 * page took a measured 4-6s to finish rendering, and the read that failed
 * landed at 1.9s, well inside that window. 10s sits comfortably above the
 * top of that measured range: a gap that wide already gave the page roughly
 * double the slowest render this note's own incident ever measured, so
 * surfacing it would mostly repeat "plenty of time had already passed"
 * rather than tell a reader something worth their attention.
 */
const NOT_WORTH_LISTING_ABOVE_MS = 10_000;

/** One action entry, narrowed only enough to compute a gap from. A record's
 * own JSON can be hand-edited, or written before `actions` existed at all,
 * so nothing here is trusted beyond what these three checks confirm - the
 * same reason `EmbeddedStepRecordLike.actions` (record-parse.ts) stays
 * `unknown` rather than `readonly ActionEntry[]` all the way through. */
interface ActionLike {
  readonly method: string;
  readonly at: string;
  readonly ms: number;
}

function isActionLike(value: unknown): value is ActionLike {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.method === "string" && typeof candidate.at === "string" && typeof candidate.ms === "number";
}

/** One `ctx.poll` record, narrowed only enough to compute its own window
 * from - the same defensive-parse convention `isActionLike` above uses, and
 * for the same reason (a record's own JSON can be hand-edited, or written
 * before `polls` existed at all). The real `PollRecord` (src/record/
 * types.ts) also carries `attempts` and `outcome`, but this note's own
 * judgment never looks at either: a poll that happened to resolve on its
 * first attempt is still a step written to retry, not a step that got
 * lucky. */
interface PollLike {
  readonly at: string;
  readonly waited_ms: number;
}

function isPollLike(value: unknown): value is PollLike {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.at === "string" && typeof candidate.waited_ms === "number";
}

/** True when `readStartedAt` (a post-navigation read's own start,
 * milliseconds since epoch) falls inside any poll's own window: `poll.at`
 * through `poll.at + poll.waited_ms`. Both ends are included - the boundary
 * is resolved toward
 * excluding the read rather than reporting it, the same direction this
 * note's own gap cutoff (`NOT_WORTH_LISTING_ABOVE_MS`) already leans in its
 * own comment. */
function isWithinAnyPollWindow(readStartedAt: number, polls: readonly unknown[]): boolean {
  for (const candidate of polls) {
    if (!isPollLike(candidate)) continue;
    const windowStart = new Date(candidate.at).getTime();
    if (Number.isNaN(windowStart)) continue;
    const windowEnd = windowStart + candidate.waited_ms;
    if (readStartedAt >= windowStart && readStartedAt <= windowEnd) return true;
  }
  return false;
}

/** `findPostNavigationReads` walks every acceptance record under `rootDir`
 * (`discoverMarkdownFiles`, the same walk `findSignoffRot`/
 * `findSignoffConditionMismatch` already use) and, for each step's own
 * frozen `actions`, reports every navigation call immediately followed by
 * another call within `NOT_WORTH_LISTING_ABOVE_MS` of the navigation's own
 * end - unless that next call's own start falls inside a `ctx.poll` window
 * the same step record's own `polls` recorded (this file's own header). A
 * step record with no `actions` field at all (a record from before that
 * field existed, or a step that never called `ctx.page()`) is silently out
 * of scope, never an error - `actions` has always been optional on a step
 * record, and an old record carrying none is the expected case, not a
 * broken one (record-parse.ts's own convention for `condition`). A step
 * record with no `polls` field simply has nothing to exclude with, and
 * falls back to this note's original behavior unchanged. */
/** One navigation-then-call pair this finding matched, before grouping. A
 * project with a Background step produces one of these per step record
 * that step ran in - a suite with dozens of scenarios can produce dozens
 * of matches that are all the same fact measured again, which is exactly
 * what `groupMatches` (below) exists to collapse. */
interface Match {
  readonly relativePath: string;
  /** Identifies the one step record this match came from, uniquely across
   * the whole project: `relativePath` alone is not enough, since one
   * accepted record's own body holds one `#### <step>` block per scenario
   * section, and a Background step contributes one such block per scenario
   * in that same file. Built as `${relativePath}#${stepRecordIndex}`,
   * `stepRecordIndex` being this step record's own position among every
   * fenced JSON block `extractStepRecordLikeBlocks`
   * (src/tend/record-parse.ts) read out of that one file, in the order it
   * read them. */
  readonly stepRecordKey: string;
  readonly step: string;
  readonly navigationMethod: string;
  readonly nextMethod: string;
  readonly gapMs: number;
}

function collectMatches(rootDir: string): Match[] {
  const matches: Match[] = [];

  for (const absolutePath of discoverMarkdownFiles(rootDir)) {
    const relativePath = path.relative(rootDir, absolutePath);

    let content: string;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue; // Removed between the walk and this read - nothing to report.
    }

    const parsed = parseAcceptanceRecord(content, relativePath);
    if (parsed.kind !== "ok") continue; // Not a record, or malformed: another finding's own concern.

    parsed.record.stepRecords.forEach((stepRecord, stepRecordIndex) => {
      const actions = stepRecord.actions;
      if (!Array.isArray(actions)) return; // No actions at all - out of scope, not an error (this file's own header).

      const polls = Array.isArray(stepRecord.polls) ? stepRecord.polls : [];
      const stepRecordKey = `${relativePath}#${stepRecordIndex}`;

      for (let index = 0; index < actions.length - 1; index++) {
        const action: unknown = actions[index];
        const next: unknown = actions[index + 1];
        if (!isActionLike(action) || !isActionLike(next)) continue;
        if (!NAVIGATION_METHODS.has(action.method)) continue;

        const navigationEndedAt = new Date(action.at).getTime() + action.ms;
        const nextStartedAt = new Date(next.at).getTime();
        if (Number.isNaN(navigationEndedAt) || Number.isNaN(nextStartedAt)) continue;

        const gapMs = nextStartedAt - navigationEndedAt;
        // A negative gap means the next call started before this navigation
        // was recorded as finished (overlapping trace entries) - not the
        // "how long after" question this note answers, so it is left alone
        // rather than reported as some other kind of fact.
        if (gapMs < 0 || gapMs > NOT_WORTH_LISTING_ABOVE_MS) continue;

        // A read that a `ctx.poll` call was already retrying was written
        // the way `docs/spec.md:350-375` asks for - excluded, not reported
        // (this file's own header).
        if (isWithinAnyPollWindow(nextStartedAt, polls)) continue;

        matches.push({
          relativePath,
          stepRecordKey,
          step: stepRecord.step,
          navigationMethod: action.method,
          nextMethod: next.method,
          gapMs,
        });
      }
    });
  }

  return matches;
}

/** `${step} ${navigationMethod} ${nextMethod}` - a step, its own
 * navigation call, and the call that followed it, name one recurring shape
 * (this file's own header: "what the gap was", never a per-record verdict),
 * so every match sharing that triple is one fact told once, not once per
 * step record it happened in. */
function groupKey(match: Match): string {
  return `${match.step} ${match.navigationMethod} ${match.nextMethod}`;
}

function formatGapRange(gapsMs: readonly number[]): string {
  const min = Math.min(...gapsMs);
  const max = Math.max(...gapsMs);
  return min === max ? `${min}ms` : `${min}ms-${max}ms`;
}

function groupMatches(matches: readonly Match[]): TendIssue[] {
  const order: string[] = [];
  const byKey = new Map<string, Match[]>();
  for (const match of matches) {
    const key = groupKey(match);
    const existing = byKey.get(key);
    if (existing === undefined) {
      order.push(key);
      byKey.set(key, [match]);
    } else {
      existing.push(match);
    }
  }

  return order.map((key) => {
    const group = byKey.get(key)!;
    const first = group[0]!;
    // Every step record this pair happened in, not the raw match count - a
    // step whose own actions repeat the same pair twice in one step record
    // still counts as one record, and two step records that happen to share
    // one accepted file (two scenarios in the same run both hitting the
    // same Background step) still count as two.
    const recordCount = new Set(group.map((match) => match.stepRecordKey)).size;
    const gapRange = formatGapRange(group.map((match) => match.gapMs));
    const exampleRecord = group[0]!.relativePath;

    return {
      code: "post-navigation-read",
      message:
        `step "${first.step}" called "${first.nextMethod}" ${gapRange} after its own "${first.navigationMethod}" ` +
        `finished, across ${recordCount} step record${recordCount === 1 ? "" : "s"} (for example ` +
        `${exampleRecord}). Not a judgment: whether that gap was enough depends on how long this application ` +
        `takes to render after "${first.navigationMethod}", and this tool has no way to know that. ` +
        `A read that a ctx.poll call was already retrying is not listed here.`,
      file: exampleRecord,
      step: first.step,
    };
  });
}

export function findPostNavigationReads(rootDir: string): TendIssue[] {
  return groupMatches(collectMatches(rootDir));
}
