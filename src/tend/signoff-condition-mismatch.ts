import { readFileSync } from "node:fs";
import path from "node:path";
import { discoverMarkdownFiles, parseAcceptanceRecord, type RecordCondition } from "./record-parse.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s `signoff-condition-mismatch`
// finding (accept-condition task spec, item 7) — the one feature-level fact
// "does the most recent sign-off's own recorded condition still match what
// this project's config would produce". A note, not an error (this task's
// own severity call: nothing is wrong *right now* — "chromium accepted,
// firefox not yet" is a normal state, docs/spec.md "Sign-off" — this is
// left-alone-and-it-rots territory, the same split every other tend finding
// already draws). Unrelated to src/tend/signoff-rot.ts's own four staleness
// checks: a condition mismatch says nothing about whether the frozen claim
// itself is still true, only that a *different* condition is what `nuka
// accept` would select today. Walks the whole project itself, independently
// of that file (src/tend/record-parse.ts's own header) — reusing its shared
// read side, never a second parser.
//
// Only `browserType` is compared, never `environment` (mirrors cli/
// accept.ts's own candidate filter, src/accept/select-run.ts's own header):
// `config.browserType` is the one axis a project's config alone determines
// with no other input. `environment` needs a `--env` flag `nuka accept`
// never takes, so there is no single "the config's own environment" to
// compare a record against without guessing which one was meant — and a
// check that guesses is worse than no check (docs/spec.md's own design
// principle).
//
// "The latest sign-off" is the record with the greatest `acceptedAt` among
// every record this feature has, full stop — not the latest *among records
// with a known condition*. If that literal latest record predates this
// task (no condition recorded at all), this finding has nothing to compare
// and says nothing for that feature (task spec item 7: "条件不明の古い記録
// はこの所見の対象外") — falling back to an older, superseded record instead
// would compare against a claim that is no longer the one actually
// standing. A record whose own known condition measured no browser launch
// is skipped the same way cli/accept.ts's own filter treats "no browser":
// an unmeasured axis carries no confirmed condition to disagree with.
//
// A "some declared browser conditions have no sign-off yet" finding was
// considered and deliberately not built: this task drops the named matrix
// entirely (per its own spec), so there is no declared set of conditions to
// compare a feature's sign-offs against — only measured ones, and "some
// declared conditions are missing a sign-off" would need a declaration that
// does not exist.

export function findSignoffConditionMismatch(rootDir: string, currentBrowserType: string): TendIssue[] {
  interface FeatureLatest {
    readonly relativePath: string;
    readonly acceptedAt: Date;
    readonly condition: RecordCondition | undefined;
  }

  const latestByFeature = new Map<string, FeatureLatest>();

  for (const absolutePath of discoverMarkdownFiles(rootDir)) {
    const relativePath = path.relative(rootDir, absolutePath);

    let content: string;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue; // Removed between the walk and this read — nothing to report.
    }

    const parsed = parseAcceptanceRecord(content, relativePath);
    if (parsed.kind !== "ok") continue; // Not a record, or malformed: signoff-rot.ts's own concern, not this one's.

    const { record } = parsed;
    if (record.acceptedAt === undefined) continue; // Can't place it in time; excluded from "latest" entirely.

    const existing = latestByFeature.get(record.featurePath);
    if (existing === undefined || record.acceptedAt.getTime() > existing.acceptedAt.getTime()) {
      latestByFeature.set(record.featurePath, {
        relativePath,
        acceptedAt: record.acceptedAt,
        condition: record.condition,
      });
    }
  }

  const issues: TendIssue[] = [];
  for (const [featurePath, latest] of latestByFeature) {
    if (latest.condition === undefined) continue; // Condition unknown (pre-this-task record): out of scope.
    if (latest.condition.browserType === undefined) continue; // No browser measured: nothing to compare.
    if (latest.condition.browserType === currentBrowserType) continue;

    issues.push({
      code: "signoff-condition-mismatch",
      message: `${latest.relativePath} is ${featurePath}'s most recent sign-off, and it recorded browser "${latest.condition.browserType}", but the current config's browserType is "${currentBrowserType}". Not wrong yet, but the next \`nuka accept\` of this feature under today's config needs its own run under "${currentBrowserType}" first.`,
      file: latest.relativePath,
    });
  }

  return issues;
}
