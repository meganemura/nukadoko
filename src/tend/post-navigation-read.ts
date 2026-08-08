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
// A read that lands inside a `ctx.poll` call's own window is excluded:
// `docs/spec.md:350-375` already asks a step to
// use `poll()` rather than a direct browser wait precisely so a delayed
// render cannot flake it, and a step written that way is the thing this
// note exists to tell apart from - not another instance of it. That
// judgment is a plain timestamp comparison against the receipt's own
// `polls` (never a table of which Playwright method names count as a
// "read", for the same reason the paragraph above already gives), and it
// is skipped entirely for a receipt with no `polls` at all - a compat step,
// a step that never calls `ctx.poll`, or a record from before `polls`
// existed all fall back to this note's original behavior, unchanged.
//
// Reads only sign-off records (src/tend/record-parse.ts, the same source
// signoff-rot.ts and signoff-condition-mismatch.ts already walk), never a
// live run's own receipt - that module's own `EXCLUDED_DIR_NAMES` keeps
// `.nukadoko` out of every walk built on it, this one included, and nothing
// here changes that list.

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
 * same reason `RecordReceiptLike.actions` (record-parse.ts) stays `unknown`
 * rather than `readonly ActionEntry[]` all the way through. */
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
 * before `polls` existed at all). The real `PollRecord` (src/receipt/
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
 * the same receipt's own `polls` recorded (this file's own header). A
 * receipt with no `actions` field at all (a record from before that field
 * existed, or a step that never called `ctx.page()`) is silently out of
 * scope, never an error - `actions` has always been optional on a receipt,
 * and an old record carrying none is the expected case, not a broken one
 * (record-parse.ts's own convention for `condition`). A receipt with no
 * `polls` field simply has nothing to exclude with, and falls back to
 * this note's original behavior unchanged. */
export function findPostNavigationReads(rootDir: string): TendIssue[] {
  const issues: TendIssue[] = [];

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

    for (const receipt of parsed.record.receipts) {
      const actions = receipt.actions;
      if (!Array.isArray(actions)) continue; // No actions at all - out of scope, not an error (this file's own header).

      const polls = Array.isArray(receipt.polls) ? receipt.polls : [];

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

        issues.push({
          code: "post-navigation-read",
          message:
            `${relativePath}: step "${receipt.step}" called "${next.method}" ${gapMs}ms after its own ` +
            `"${action.method}" finished. Not a judgment: whether that gap was enough depends on how long ` +
            `this application takes to render after "${action.method}", and this tool has no way to know that.`,
          file: relativePath,
          step: receipt.step,
        });
      }
    }
  }

  return issues;
}
