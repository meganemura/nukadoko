import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ScenarioRecord } from "../run/record-types.js";

// Responsibility: pick the one `nuka run` invocation `nuka accept <feature>`
// is allowed to freeze (m4b-accept task spec's own "identifying the target
// run"/"rejection conditions" sections, items 1, 4). Reads every
// `record.json` under `<stateDir>/scenarios/*`
// (there is no index of them anywhere else), keeps only the ones naming this
// feature, groups by `run_id` (one `nuka run` invocation's worth), and
// answers "which group, if any, may be accepted" — never *how* to report a
// "no" answer to a human (that wording is cli/accept.ts's job, since it also
// knows the feature argument the user typed) and never anything about git
// (the commit/clean checks are cli/accept.ts's own job too, reusing
// src/run/probe-git.ts — this module has no opinion on git at all).
//
// "the whole feature is covered, and every one of them passed" (spec
// decision 4) is checked per group, independently: a group's own `line`
// set must equal the feature's
// pickle-line set *exactly* (not merely a superset — a partial run's lines
// are always a subset, never a superset, but "exactly equal" is the literal
// rule and is what a superset-tolerant `⊇` check would wrongly relax), and
// every record in it must be `status: "passed"`. Groups that satisfy both
// are compared on one axis only: the earliest `started_at` among their own
// records (this file's own stand-in for "when did this run begin" — no
// single field carries that; `run_id` only names *which* records share one
// invocation, docs/spec.md "Sign-off" / src/run/record-types.ts's own
// header). The newest such group wins (spec decision 5); ties (same
// millisecond) keep whichever was seen first, an outcome this module makes
// no promise about since two runs starting in the same millisecond is not a
// case worth designing for.
//
// The three-way "no" (spec rejection item 4: "no run has ever existed", "a
// run exists but was red", and "only partial runs exist" are different
// situations from the user's point of view) is
// resolved by tracking, alongside the winning group search, whether *any*
// group ever had full line coverage regardless of its own pass/fail: if one
// did, every full-coverage group must have failed (else it would have won),
// so the answer is "red"; if none ever did, every group that exists for this
// feature was partial, so the answer is "partial-only"; and if there were no
// groups at all, no run has ever touched this feature.
//
// partial-run-visibility task spec: "red" and "partial-only" now carry the
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

export interface RunStartedAt {
  readonly runId: string;
  readonly startedAt: Date;
}

/** Reads every `record.json` this project has ever written, across every
 * run and every feature — a missing `scenarios/` directory (never run
 * anything yet) is not an error, just an empty answer, the same fail-open
 * convention src/feature/load-features.ts's own `walkFeatureFiles` uses for
 * a missing `featuresDir`. A scenario directory whose `record.json` is
 * missing or unparsable is skipped rather than aborting the whole scan —
 * one corrupt/half-written directory (e.g. a run killed mid-write) must not
 * make every other feature's own accept impossible. */
export function loadAllScenarioRecords(rootDir: string, stateDir: string): ScenarioRecord[] {
  const scenariosDir = path.join(rootDir, stateDir, "scenarios");

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
      // same "collapse to absent, keep going" stance src/receipt/
      // read-receipt.ts already takes for a single receipt.json.
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
 * parsing the feature file fresh (spec decision 4: parse the feature with
 * the existing loader and enumerate its pickles).
 */
export function selectAcceptableRun(
  featureRecords: readonly ScenarioRecord[],
  featureLines: ReadonlySet<number>,
): SelectRunResult {
  if (featureRecords.length === 0) {
    return { kind: "none-ever" };
  }

  const groups = new Map<string, ScenarioRecord[]>();
  for (const record of featureRecords) {
    const existing = groups.get(record.run_id);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(record.run_id, [record]);
    }
  }

  let sawFullCoverage = false;
  let best: { group: ScenarioRecord[]; startedAt: Date } | null = null;
  // Tracked alongside `best` (this file's own header,
  // partial-run-visibility task spec): the data a "red"/"partial-only"
  // refusal needs to name a run, which `best` alone can't supply once it
  // stays `null`.
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
