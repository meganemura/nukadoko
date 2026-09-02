import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readStepRecordById } from "../record/read-step-record.js";
import type { ScenarioRecord } from "../run/record-types.js";
import type { TendIssue } from "./types.js";

// Responsibility: find repeated scenario openings in the latest run's live
// records. It reports measured repetition only and does not recommend a fix.

interface TrieNode {
  readonly texts: readonly string[];
  readonly parent: TrieNode | null;
  readonly children: Map<string, TrieNode>;
  count: number;
  ms: number;
  firstFeature: string | null;
}

function isScenarioRecord(value: unknown): value is ScenarioRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.run_id !== "string" ||
    typeof record.feature !== "string" ||
    typeof record.started_at !== "string" ||
    typeof record.finished_at !== "string" ||
    !Array.isArray(record.steps)
  ) return false;
  return record.steps.every((value) => {
    if (value === null || typeof value !== "object") return false;
    const step = value as Record<string, unknown>;
    return (
      typeof step.text === "string" &&
      (step.step_record_id === null || typeof step.step_record_id === "string")
    );
  });
}

function readScenarioRecords(rootDir: string, stateDir: string): ScenarioRecord[] {
  const recordsDir = path.join(rootDir, stateDir, "records", "scenarios");
  let entries: string[];
  try {
    entries = readdirSync(recordsDir).sort();
  } catch {
    return [];
  }

  const records: ScenarioRecord[] = [];
  for (const entry of entries) {
    try {
      const record: unknown = JSON.parse(readFileSync(path.join(recordsDir, entry, "record.json"), "utf8"));
      if (isScenarioRecord(record)) records.push(record);
    } catch {
      // A damaged record cannot support measured timing, but it must not hide
      // healthy records from the same run.
    }
  }
  return records;
}

// "When did this run begin" is the earliest `started_at` among its own
// records, and the newest such run wins. That is the same rule
// src/accept/select-run.ts uses to pick the run a sign-off may freeze,
// followed here so both commands answer "which run" the same way. The two
// rules can disagree: a long run that began first can hold the latest
// scenario start of all, so picking by the latest start would name it the
// newest run while `nuka accept` named a shorter, later one.
function latestRun(records: readonly ScenarioRecord[]): ScenarioRecord[] {
  const byRun = new Map<string, { startedAt: number; records: ScenarioRecord[] }>();
  for (const record of records) {
    const startedAt = Date.parse(record.started_at);
    if (typeof record.run_id !== "string" || Number.isNaN(startedAt)) continue;
    const group = byRun.get(record.run_id);
    if (group === undefined) {
      byRun.set(record.run_id, { startedAt, records: [record] });
    } else {
      group.startedAt = Math.min(group.startedAt, startedAt);
      group.records.push(record);
    }
  }

  let selected: { startedAt: number; records: ScenarioRecord[] } | undefined;
  for (const group of byRun.values()) {
    if (selected === undefined || group.startedAt > selected.startedAt) selected = group;
  }
  return selected?.records ?? [];
}

function elapsedMs(startedAt: string, finishedAt: string): number {
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

function buildTrie(rootDir: string, stateDir: string, records: readonly ScenarioRecord[]): TrieNode {
  const root: TrieNode = {
    texts: [], parent: null, children: new Map(), count: 0, ms: 0, firstFeature: null,
  };

  for (const record of records) {
    let node = root;
    let prefixMs = 0;
    for (const step of record.steps) {
      if (step.step_record_id !== null) {
        const stepRecord = readStepRecordById(rootDir, stateDir, step.step_record_id);
        if (stepRecord !== null) prefixMs += elapsedMs(stepRecord.started_at, stepRecord.finished_at);
      }

      let child = node.children.get(step.text);
      if (child === undefined) {
        child = {
          texts: [...node.texts, step.text],
          parent: node,
          children: new Map(),
          count: 0,
          ms: 0,
          firstFeature: null,
        };
        node.children.set(step.text, child);
      }
      child.count += 1;
      child.ms += prefixMs;
      child.firstFeature ??= record.feature;
      node = child;
    }
  }
  return root;
}

function collectCandidates(root: TrieNode, minimumMs: number): TrieNode[] {
  const candidates: TrieNode[] = [];
  const visit = (node: TrieNode): void => {
    if (node.count >= 2 && node.ms >= minimumMs) candidates.push(node);
    for (const child of node.children.values()) visit(child);
  };
  for (const child of root.children.values()) visit(child);
  return candidates;
}

function isAncestor(ancestor: TrieNode, descendant: TrieNode): boolean {
  for (let node = descendant.parent; node !== null; node = node.parent) {
    if (node === ancestor) return true;
  }
  return false;
}

function removeOverlaps(candidates: readonly TrieNode[]): TrieNode[] {
  const remaining = [...candidates];
  const selected: TrieNode[] = [];
  while (remaining.length > 0) {
    let best = remaining[0]!;
    for (const candidate of remaining.slice(1)) {
      if (candidate.ms > best.ms) best = candidate;
    }
    selected.push(best);
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index]!;
      if (candidate === best || isAncestor(candidate, best) || isAncestor(best, candidate)) {
        remaining.splice(index, 1);
      }
    }
  }
  return selected;
}

function formatNumber(value: number, maximumFractionDigits: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits, useGrouping: false });
}

function toIssue(node: TrieNode, totalScenarioMs: number): TendIssue {
  // One decimal on the seconds: a wall-clock measurement of a whole
  // scenario prefix carries nowhere near millisecond accuracy, and printing
  // three decimals would claim it does.
  const seconds = formatNumber(node.ms / 1_000, 1);
  const percentage = formatNumber((node.ms / totalScenarioMs) * 100, 1);
  const steps = node.texts.map((text) => `"${text}"`).join(", ");
  return {
    code: "repeated-scenario-prefix",
    file: node.firstFeature ?? undefined,
    message:
      `${node.count} scenarios begin with the same ${node.texts.length} ` +
      `step${node.texts.length === 1 ? "" : "s"}, which took ${seconds} seconds across them, ` +
      `${percentage}% of this run's summed scenario time. The shared steps: ${steps}. ` +
      `The place to lift a shared opening into is a "process"-scope fixture (nukadoko.config.ts fixtures); ` +
      `whether these scenarios can share what it builds depends on which of them write to that state, ` +
      `which this tool cannot see.`,
  };
}

export function findRepeatedScenarioPrefixes(rootDir: string, stateDir: string): TendIssue[] {
  const records = latestRun(readScenarioRecords(rootDir, stateDir));
  if (records.length === 0) return [];
  const totalScenarioMs = records.reduce(
    (total, record) => total + elapsedMs(record.started_at, record.finished_at),
    0,
  );
  if (totalScenarioMs === 0) return [];
  const root = buildTrie(rootDir, stateDir, records);
  return removeOverlaps(collectCandidates(root, totalScenarioMs * 0.02)).map((node) =>
    toIssue(node, totalScenarioMs),
  );
}
