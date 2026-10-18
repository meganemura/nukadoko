import { PickleStepType, type PickleStepArgument } from "@cucumber/messages";
import type { FeatureFile, FeaturePickleStep } from "../feature/load-features.js";
import { rankRunsNewestFirst } from "../record/newest-run.js";
import { readStepRecordById } from "../record/read-step-record.js";
import { readEndedRuns } from "../record/run-result.js";
import type { TendIssue } from "./types.js";

// Responsibility: find repeated scenario openings in the latest run's live
// records. It reports measured repetition, and names a process-scope fixture
// as the place to lift an opening only when every shared step declares
// `mutates: false`. An opening ends at the first When or Then, since a step
// there is what the scenario exercises, not its setup; and two steps are the
// same step only when their docstring or table is the same too. Both facts
// come from the scenario as the scanned features hold it now. A record whose
// scenario is no longer there, or no longer has the same step texts, is keyed
// by its texts alone.
//
// Which opening a note names depends on the scenarios alone: within one
// family of nested openings, the one that covers the most step executions,
// then the longer one, then the one that comes first in the feature files.
// Measured time only decides whether an opening clears the 2% floor. Ranking
// by time named a different opening from run to run on a fast suite, where
// the differences were timing noise.

interface TrieNode {
  readonly texts: readonly string[];
  /** True when a step on the path to this node carries a docstring or table. */
  readonly withArgument: boolean;
  readonly parent: TrieNode | null;
  readonly children: Map<string, TrieNode>;
  count: number;
  ms: number;
  /** The earliest scenario, in source order, that opens with this prefix. */
  first: SourcePosition | null;
  /** True when some record of this node's own step lacks `mutates: false`:
   * it declares `mutates: true`, is a compat step with no declaration, or
   * has no step record to read the declaration from. */
  mayWrite: boolean;
}

interface SourcePosition {
  readonly feature: string;
  readonly line: number;
}

function comesBefore(a: SourcePosition, b: SourcePosition): boolean {
  return a.feature < b.feature || (a.feature === b.feature && a.line < b.line);
}

/** One scenario of the latest run, as its run.json entry names it. */
interface ScenarioRecord {
  readonly feature: string;
  readonly line: number;
  readonly started_at: string;
  readonly finished_at: string;
  readonly steps: readonly { readonly text: string; readonly step_record_id: string | null }[];
}

function asScenario(value: unknown): ScenarioRecord | null {
  if (value === null || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.feature !== "string" ||
    typeof entry.line !== "number" ||
    typeof entry.started_at !== "string" ||
    typeof entry.finished_at !== "string" ||
    !Array.isArray(entry.steps)
  ) return null;
  const steps: { text: string; step_record_id: string | null }[] = [];
  for (const value of entry.steps) {
    if (value === null || typeof value !== "object") return null;
    const step = value as Record<string, unknown>;
    if (typeof step.text !== "string" || (step.step_record_id !== null && typeof step.step_record_id !== "string")) return null;
    steps.push({ text: step.text, step_record_id: step.step_record_id });
  }
  return { feature: entry.feature, line: entry.line, started_at: entry.started_at, finished_at: entry.finished_at, steps };
}

/** The scenarios of the newest run that wrote its run.json. A damaged entry
 * cannot support measured timing, but it must not hide healthy entries from
 * the same run. */
function readLatestRunScenarios(rootDir: string, stateDir: string): ScenarioRecord[] {
  const latest = rankRunsNewestFirst(readEndedRuns(rootDir, stateDir))[0]?.run;
  if (latest === undefined) return [];
  return latest.scenarios.flatMap((entry) => {
    const scenario = asScenario(entry);
    return scenario === null ? [] : [scenario];
  });
}

function elapsedMs(startedAt: string, finishedAt: string): number {
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

/** The grouping key of one step: its text and its docstring or table, so
 * two steps with one sentence and different arguments never share a node. */
export function stepPrefixKey(step: { readonly text: string; readonly argument?: PickleStepArgument }): string {
  const docString = step.argument?.docString;
  const dataTable = step.argument?.dataTable;
  return JSON.stringify([
    step.text,
    docString === undefined ? null : [docString.mediaType ?? null, docString.content],
    dataTable === undefined ? null : dataTable.rows.map((row) => row.cells.map((cell) => cell.value)),
  ]);
}

/** The pickle steps of the scenario a record ran, when the scanned features
 * still hold that scenario with the same step texts. */
function pickleStepsFor(
  record: ScenarioRecord,
  pickles: ReadonlyMap<string, readonly FeaturePickleStep[]>,
): readonly FeaturePickleStep[] | undefined {
  const steps = typeof record.line === "number" ? pickles.get(`${record.feature}\u0000${record.line}`) : undefined;
  if (steps === undefined || steps.length !== record.steps.length) return undefined;
  return steps.every((step, index) => step.text === record.steps[index]!.text) ? steps : undefined;
}

function picklesByScenario(features: readonly FeatureFile[]): Map<string, readonly FeaturePickleStep[]> {
  const pickles = new Map<string, readonly FeaturePickleStep[]>();
  for (const feature of features) {
    for (const pickle of feature.pickles) {
      if (pickle.location !== undefined) {
        pickles.set(`${feature.relativePath}\u0000${pickle.location.line}`, pickle.steps);
      }
    }
  }
  return pickles;
}

function buildTrie(
  rootDir: string,
  stateDir: string,
  records: readonly ScenarioRecord[],
  features: readonly FeatureFile[],
): TrieNode {
  const root: TrieNode = {
    texts: [], withArgument: false, parent: null, children: new Map(), count: 0, ms: 0, first: null, mayWrite: false,
  };
  const pickles = picklesByScenario(features);

  for (const record of records) {
    let node = root;
    let prefixMs = 0;
    const position: SourcePosition = {
      feature: record.feature,
      line: typeof record.line === "number" ? record.line : Number.POSITIVE_INFINITY,
    };
    const pickleSteps = pickleStepsFor(record, pickles);
    for (const [index, step] of record.steps.entries()) {
      const pickleStep = pickleSteps?.[index];
      if (pickleStep?.type === PickleStepType.ACTION || pickleStep?.type === PickleStepType.OUTCOME) break;
      const stepRecord = step.step_record_id === null ? null : readStepRecordById(rootDir, stateDir, step.step_record_id);
      if (stepRecord !== null) prefixMs += elapsedMs(stepRecord.started_at, stepRecord.finished_at);

      const key = pickleStep === undefined ? stepPrefixKey(step) : stepPrefixKey(pickleStep);
      let child = node.children.get(key);
      if (child === undefined) {
        child = {
          texts: [...node.texts, step.text],
          withArgument: node.withArgument || pickleStep?.argument !== undefined,
          parent: node,
          children: new Map(),
          count: 0,
          ms: 0,
          first: null,
          mayWrite: false,
        };
        node.children.set(key, child);
      }
      child.count += 1;
      child.ms += prefixMs;
      if (child.first === null || comesBefore(position, child.first)) child.first = position;
      if (stepRecord?.mutates !== false) child.mayWrite = true;
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

/** True when `a` names a better opening than `b`: it covers more step
 * executions, or as many with more steps, or comes first in source order. Every
 * candidate has a `first`, since a record reached it. */
function ranksAbove(a: TrieNode, b: TrieNode): boolean {
  const executionsA = a.count * a.texts.length;
  const executionsB = b.count * b.texts.length;
  if (executionsA !== executionsB) return executionsA > executionsB;
  if (a.texts.length !== b.texts.length) return a.texts.length > b.texts.length;
  return comesBefore(a.first!, b.first!);
}

function removeOverlaps(candidates: readonly TrieNode[]): TrieNode[] {
  const remaining = [...candidates];
  const selected: TrieNode[] = [];
  while (remaining.length > 0) {
    let best = remaining[0]!;
    for (const candidate of remaining.slice(1)) {
      if (ranksAbove(candidate, best)) best = candidate;
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

/** The first shared step, in order, that may write. */
function firstWritingStep(node: TrieNode): string | undefined {
  const chain: TrieNode[] = [];
  for (let current: TrieNode | null = node; current !== null && current.parent !== null; current = current.parent) {
    chain.unshift(current);
  }
  return chain.find((step) => step.mayWrite)?.texts.at(-1);
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
  const writer = firstWritingStep(node);
  // `mutates` is the step's own declaration, so this trusts it rather than
  // guessing from the trace whether the opening wrote anything.
  const lift =
    writer === undefined
      ? `Every shared step declares mutates: false, so a "process"-scope fixture (nukadoko.config.ts fixtures) ` +
        `can build this opening once for all of them.`
      : `"${writer}" does not declare mutates: false, so a later scenario may read what this opening writes: ` +
        `a "process"-scope fixture would share that state between scenarios. ` +
        `A Background keeps the shared steps in one place and still runs them for each scenario.`;
  return {
    code: "repeated-scenario-prefix",
    file: node.first?.feature,
    message:
      `${node.count} scenarios begin with the same ${node.texts.length} ` +
      `step${node.texts.length === 1 ? "" : "s"}, which took ${seconds} seconds across them, ` +
      `${percentage}% of this run's summed scenario time. The shared steps: ${steps}. ` +
      (node.withArgument ? "The shared steps take the same docstring or table. " : "") +
      lift,
  };
}

/** One record per scenario (feature and line), the latest started: a
 * `nuka run --repeat <n>` run holds `n` records for one scenario, and
 * counting them would report the scenario's own repetition as a shared
 * opening between "n scenarios" that are the same one. */
function onePerScenario(records: readonly ScenarioRecord[]): ScenarioRecord[] {
  const latest = new Map<string, ScenarioRecord>();
  for (const record of records) {
    const key = `${record.feature}\u0000${record.line}`;
    const previous = latest.get(key);
    if (previous === undefined || Date.parse(record.started_at) >= Date.parse(previous.started_at)) {
      latest.set(key, record);
    }
  }
  return [...latest.values()];
}

export function findRepeatedScenarioPrefixes(
  rootDir: string,
  stateDir: string,
  features: readonly FeatureFile[] = [],
): TendIssue[] {
  const records = onePerScenario(readLatestRunScenarios(rootDir, stateDir));
  if (records.length === 0) return [];
  const totalScenarioMs = records.reduce(
    (total, record) => total + elapsedMs(record.started_at, record.finished_at),
    0,
  );
  if (totalScenarioMs === 0) return [];
  const root = buildTrie(rootDir, stateDir, records, features);
  return removeOverlaps(collectCandidates(root, totalScenarioMs * 0.02)).map((node) =>
    toIssue(node, totalScenarioMs),
  );
}
