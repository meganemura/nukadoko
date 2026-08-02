import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ScenarioRecord } from "../run/record-types.js";

// Responsibility: pick the one `nuka run` invocation `nuka accept <feature>`
// is allowed to freeze (m4b-accept task spec, "対象 run の特定"/"拒否条件"
// items 1, 4). Reads every `record.json` under `<stateDir>/scenarios/*`
// (there is no index of them anywhere else), keeps only the ones naming this
// feature, groups by `run_id` (one `nuka run` invocation's worth), and
// answers "which group, if any, may be accepted" — never *how* to report a
// "no" answer to a human (that wording is cli/accept.ts's job, since it also
// knows the feature argument the user typed) and never anything about git
// (the commit/clean checks are cli/accept.ts's own job too, reusing
// src/run/probe-git.ts — this module has no opinion on git at all).
//
// "Feature全体がカバーされ、かつ全部 passed" (spec decision 4) is checked per
// group, independently: a group's own `line` set must equal the feature's
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
// The three-way "no" (spec rejection item 4: "「1 つも run が無い」と「run
// はあるが赤かった」と「部分実行だけがある」は利用者にとって別の状況") is
// resolved by tracking, alongside the winning group search, whether *any*
// group ever had full line coverage regardless of its own pass/fail: if one
// did, every full-coverage group must have failed (else it would have won),
// so the answer is "red"; if none ever did, every group that exists for this
// feature was partial, so the answer is "partial-only"; and if there were no
// groups at all, no run has ever touched this feature.

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
  | { readonly kind: "red" }
  | { readonly kind: "partial-only" }
  | { readonly kind: "ok"; readonly group: readonly ScenarioRecord[]; readonly startedAt: Date };

/**
 * `featureRecords` must already be filtered to one feature's own records
 * (this module never reads `record.feature` itself — cli/accept.ts owns the
 * path-normalization that comparison needs, this file's own header).
 * `featureLines` is that feature's own pickle `location.line` set, from
 * parsing the feature file fresh (spec decision 4: "feature を既存の loader
 * でパースして pickle を列挙し").
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

  for (const group of groups.values()) {
    const lines = new Set(group.map((record) => record.line));
    const fullCoverage =
      lines.size === featureLines.size && [...featureLines].every((line) => lines.has(line));
    if (fullCoverage) {
      sawFullCoverage = true;
    }

    const allPassed = group.every((record) => record.status === "passed");
    if (fullCoverage && allPassed) {
      const startedAt = runStartedAt(group);
      if (best === null || startedAt.getTime() > best.startedAt.getTime()) {
        best = { group, startedAt };
      }
    }
  }

  if (best !== null) {
    return { kind: "ok", group: best.group, startedAt: best.startedAt };
  }
  return { kind: sawFullCoverage ? "red" : "partial-only" };
}
