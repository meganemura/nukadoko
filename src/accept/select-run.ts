import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ScenarioRecord } from "../run/record-types.js";

// Responsibility: pick the one `nuka run` invocation `nuka accept <feature>`
// is allowed to freeze (docs/spec.md "Sign-off" — identifying the target run
// and the refusal conditions around it). Reads every
// `record.json` under `<stateDir>/records/scenarios/*`
// (there is no index of them anywhere else), keeps only the ones naming this
// feature, groups by `run_id` (one `nuka run` invocation's worth), and
// answers "which group, if any, may be accepted" — never *how* to report a
// "no" answer to a human (that wording is cli/accept.ts's job, since it also
// knows the feature argument the user typed) and never anything about git
// (the commit/clean checks are cli/accept.ts's own job too, reusing
// src/run/probe-git.ts — this module has no opinion on git at all).
//
// "the whole feature is covered, and every one of them passed" is checked
// per group, independently: a group's own `line`
// set must equal the feature's
// pickle-line set *exactly* (not merely a superset — a partial run's lines
// are always a subset, never a superset, but "exactly equal" is the literal
// rule and is what a superset-tolerant `⊇` check would wrongly relax), and
// every record in it must be `status: "passed"`. Groups that satisfy both
// are compared on one axis only: the earliest `started_at` among their own
// records (this file's own stand-in for "when did this run begin" — no
// single field carries that; `run_id` only names *which* records share one
// invocation, docs/spec.md "Sign-off" / src/run/record-types.ts's own
// header). The newest such group wins; ties (same
// millisecond) keep whichever was seen first, an outcome this module makes
// no promise about since two runs starting in the same millisecond is not a
// case worth designing for.
//
// The three-way "no" ("no run has ever existed", "a
// run exists but was red", and "only partial runs exist" are different
// situations from the user's point of view) is
// resolved by tracking, alongside the winning group search, whether *any*
// group ever had full line coverage regardless of its own pass/fail: if one
// did, every full-coverage group must have failed (else it would have won),
// so the answer is "red"; if none ever did, every group that exists for this
// feature was partial, so the answer is "partial-only"; and if there were no
// groups at all, no run has ever touched this feature.
//
// "red" and "partial-only" now carry the
// group and startedAt they were decided from, not just their kind — a
// refusal that names nothing forces the reader back to guessing which run,
// of possibly many, is the one being talked about. This module still has no
// opinion on wording (this file's own header, above): it hands cli/accept.ts
// data, never a sentence. "red" carries the most recent *full-coverage*
// group regardless of its own pass/fail (there is no all-passed one, or this
// would have been "ok" instead) — "the most recent full run" per docs/
// spec.md "Sign-off". "partial-only" carries the most recent group of any
// kind, which in this branch is guaranteed partial: every group here failed
// full coverage, or "red" would have won instead.
//
// `RunCondition`/`browserConditionMatches`/`listConditionsWithGreenRun` are
// added now (docs/spec.md "Sign-off") — sign-off's own
// condition, "what confirmed this", is (environment, browser), both read off
// the measured `ScenarioRecord` fields, never a config declaration
// (`config.browserType` is a target to filter *for*, not the thing recorded
// — see cli/accept.ts's own use of `browserConditionMatches`). `environment`
// is uniform across one run_id group already (measured
// once per run, same as `git`), so a group's own condition reads it off any
// one record; `browser` is not (a step can override `page`
// per scenario), so a group's own condition is only defined once its own
// records agree closely enough to have one — see `conditionOfGroup`'s own
// comment. `selectAcceptableRun` itself stays condition-agnostic on purpose:
// cli/accept.ts filters `featureRecords` *before* calling it (never a second
// grouping/coverage implementation here) to answer "is there a green full
// run under the current condition", and calls the same function unfiltered
// to answer "does one exist under any condition at all" — one selection
// algorithm, two different inputs, not two algorithms.

export interface RunStartedAt {
  readonly runId: string;
  readonly startedAt: Date;
}

/** Sign-off's own condition (docs/spec.md "Sign-off") — what
 * confirmed an accepted run, as measured, never as declared.
 * `browserType` is `undefined` when no record the condition was read from
 * launched a browser at all ("no browser" is itself a condition, distinct
 * from "chromium"). Version is
 * deliberately not part of this type: the engine's *type* is enough for
 * acceptance/matching purposes; a browser's
 * measured version lands only in the record body (render-record.ts), never
 * compared here. */
export interface RunCondition {
  readonly environment: string;
  readonly browserType: string | undefined;
}

/** One run_id's worth of records, keyed by that id — the same grouping
 * `selectAcceptableRun` needs internally and `listConditionsWithGreenRun`
 * below needs again, factored out once rather than duplicated (this file's
 * own header: one computation path). */
function groupByRunId(records: readonly ScenarioRecord[]): Map<string, ScenarioRecord[]> {
  const groups = new Map<string, ScenarioRecord[]>();
  for (const record of records) {
    const existing = groups.get(record.run_id);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(record.run_id, [record]);
    }
  }
  return groups;
}

/** A group's own condition: `environment` off any one record (uniform
 * across the group, this file's own header), `browserType` off the first
 * record that measured launching one at all — group members that never
 * touched a browser carry no opinion of their own to disagree with the
 * ones that did (the same asymmetry `browserConditionMatches` below
 * applies per record). A group whose own browser-launching records
 * disagree with each other (a mixed-engine run, not achievable through
 * `nuka run` today, since `browserType` is one config value per invocation)
 * is not specially detected — the first one found wins, the same
 * "anyRecord" simplification this file's own header already uses for
 * `environment`. */
function conditionOfGroup(group: readonly ScenarioRecord[]): RunCondition {
  const withBrowser = group.find((record) => record.browser !== undefined);
  return { environment: group[0]!.environment, browserType: withBrowser?.browser?.type };
}

/** Whether `record`'s own measured browser (if any) is compatible with
 * `targetBrowserType`. A record that never launched a browser carries no browser
 * condition to disagree with, so it is compatible with every target — the
 * same reason an API-only scenario's acceptance never depends on engine
 * choice. A record that did launch one must match exactly: matching against
 * `config.browserType` (a *current* declaration) rather than anything
 * stored on the record itself is what keeps this "measured vs measured"
 * rather than "declared vs declared" (this file's own header) — the record
 * carries only what it measured, and the caller supplies today's target. */
export function browserConditionMatches(record: ScenarioRecord, targetBrowserType: string): boolean {
  return record.browser === undefined || record.browser.type === targetBrowserType;
}

/** Whether `group` alone would be a qualifying ("ok") run, and if so, under
 * which condition — the same full-coverage-and-all-passed test
 * `selectAcceptableRun` applies per group internally, evaluated directly
 * here (not by re-invoking that function per group) since there is no
 * three-way "no" to distinguish and no cross-group "most recent" to settle;
 * both of those, not this per-group boolean, are the part of that function
 * this module means not to duplicate (this file's own header). */
function groupCondition(group: readonly ScenarioRecord[], featureLines: ReadonlySet<number>): RunCondition | undefined {
  const lines = new Set(group.map((record) => record.line));
  const fullCoverage = lines.size === featureLines.size && [...featureLines].every((line) => lines.has(line));
  const allPassed = group.every((record) => record.status === "passed");
  return fullCoverage && allPassed ? conditionOfGroup(group) : undefined;
}

/** Every distinct condition among `featureRecords` that has its own
 * qualifying green, full-coverage run — used only to enumerate an
 * alternative in cli/accept.ts's refusal message once the *current*
 * condition has none (docs/spec.md "Sign-off": the refusal lists every
 * condition that does have a green full run instead). This module still has
 * no opinion on wording (this file's own
 * header) — it hands back data, never a sentence. */
export function listConditionsWithGreenRun(
  featureRecords: readonly ScenarioRecord[],
  featureLines: ReadonlySet<number>,
): RunCondition[] {
  const seen = new Map<string, RunCondition>();
  for (const group of groupByRunId(featureRecords).values()) {
    const condition = groupCondition(group, featureLines);
    if (condition === undefined) continue;
    // The two halves of this key are joined by a separator because neither
    // is length-bounded against the other: environment "stagingchromium"
    // with no browser would otherwise key the same as environment "staging"
    // run on chromium, collapsing two conditions into one. It is spelled as
    // an escape rather than written as the byte itself, which would make
    // this whole file read as binary and drop it out of every `git grep`
    // without saying so.
    const key = `${condition.environment}\u0000${condition.browserType ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, condition);
    }
  }
  return [...seen.values()];
}

/** Reads every `record.json` this project has ever written, across every
 * run and every feature — a missing `records/scenarios/` directory (never run
 * anything yet) is not an error, just an empty answer, the same fail-open
 * convention src/feature/load-features.ts's own `walkFeatureFiles` uses for
 * a missing `featuresDir`. A scenario directory whose `record.json` is
 * missing or unparsable is skipped rather than aborting the whole scan —
 * one corrupt/half-written directory (e.g. a run killed mid-write) must not
 * make every other feature's own accept impossible. */
export function loadAllScenarioRecords(rootDir: string, stateDir: string): ScenarioRecord[] {
  const scenariosDir = path.join(rootDir, stateDir, "records", "scenarios");

  let entries;
  try {
    entries = readdirSync(scenariosDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records: ScenarioRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = readFileSync(path.join(scenariosDir, entry.name, "record.json"), "utf8");
      records.push(JSON.parse(raw) as ScenarioRecord);
    } catch {
      // Unreadable/unparsable record.json for this one scenario directory —
      // same "collapse to absent, keep going" stance src/record/
      // read-step-record.ts already takes for a single step record's own
      // record.json.
    }
  }
  return records;
}

function runStartedAt(group: readonly ScenarioRecord[]): Date {
  return new Date(Math.min(...group.map((record) => new Date(record.started_at).getTime())));
}

export type SelectRunResult =
  | { readonly kind: "none-ever" }
  | { readonly kind: "red"; readonly group: readonly ScenarioRecord[]; readonly startedAt: Date }
  | { readonly kind: "partial-only"; readonly group: readonly ScenarioRecord[]; readonly startedAt: Date }
  | { readonly kind: "ok"; readonly group: readonly ScenarioRecord[]; readonly startedAt: Date };

/**
 * `featureRecords` must already be filtered to one feature's own records
 * (this module never reads `record.feature` itself — cli/accept.ts owns the
 * path-normalization that comparison needs, this file's own header).
 * `featureLines` is that feature's own pickle `location.line` set, from
 * parsing the feature file fresh (parse the feature with
 * the existing loader and enumerate its pickles).
 */
export function selectAcceptableRun(
  featureRecords: readonly ScenarioRecord[],
  featureLines: ReadonlySet<number>,
): SelectRunResult {
  if (featureRecords.length === 0) {
    return { kind: "none-ever" };
  }

  const groups = groupByRunId(featureRecords);

  let sawFullCoverage = false;
  let best: { group: ScenarioRecord[]; startedAt: Date } | null = null;
  // Tracked alongside `best` (this file's own header): the data a
  // "red"/"partial-only" refusal needs to name a run, which `best` alone
  // can't supply once it stays `null`.
  let bestFullCoverage: { group: ScenarioRecord[]; startedAt: Date } | null = null;
  let mostRecent: { group: ScenarioRecord[]; startedAt: Date } | null = null;

  for (const group of groups.values()) {
    const lines = new Set(group.map((record) => record.line));
    const fullCoverage =
      lines.size === featureLines.size && [...featureLines].every((line) => lines.has(line));
    const startedAt = runStartedAt(group);

    if (mostRecent === null || startedAt.getTime() > mostRecent.startedAt.getTime()) {
      mostRecent = { group, startedAt };
    }

    if (fullCoverage) {
      sawFullCoverage = true;
      if (bestFullCoverage === null || startedAt.getTime() > bestFullCoverage.startedAt.getTime()) {
        bestFullCoverage = { group, startedAt };
      }
    }

    const allPassed = group.every((record) => record.status === "passed");
    if (fullCoverage && allPassed) {
      if (best === null || startedAt.getTime() > best.startedAt.getTime()) {
        best = { group, startedAt };
      }
    }
  }

  if (best !== null) {
    return { kind: "ok", group: best.group, startedAt: best.startedAt };
  }
  if (sawFullCoverage) {
    // Non-null: `sawFullCoverage` is only set inside the branch that also
    // sets `bestFullCoverage`.
    return { kind: "red", group: bestFullCoverage!.group, startedAt: bestFullCoverage!.startedAt };
  }
  // Non-null: `featureRecords.length === 0` already returned above, so at
  // least one group exists, and `mostRecent` is set for every group.
  return { kind: "partial-only", group: mostRecent!.group, startedAt: mostRecent!.startedAt };
}
