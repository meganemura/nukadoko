import path from "node:path";
import { PickleStepType, type Pickle, type PickleStep, type PickleStepArgument } from "@cucumber/messages";
import type { Finding } from "../finding/finding.js";
import { runCodeInfo } from "../finding/run-codes.js";
import { readStepRecord } from "../record/read-step-record.js";
import type { RunScenario } from "../record/run-result.js";

// Responsibility: the `repeated-scenario-prefix` note of a finished run:
// scenarios of this run that open with the same steps. Boundary: it reads
// the run's own scenario entries and the step records they cite, and
// writes nothing; `nuka run` adds the notes to the run's findings before
// run.json is written, so run.json, the summary, and `--json` carry the
// same notes. A note never changes the exit code.
//
// It reports measured repetition, and names a process-scope fixture
// as the place to lift an opening only when every shared step declares
// `mutates: false`. An opening ends at the first When or Then, since a step
// there is what the scenario exercises, not its setup; and two steps are the
// same step only when their docstring or table is the same too. Both facts
// come from the scenario as the run's features hold it. An entry whose
// scenario the features do not hold with the same step texts is keyed by
// its texts alone.
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

/** One scenario of the run, with each step's record directory resolved. */
interface ScenarioRecord {
  readonly feature: string;
  readonly line: number;
  readonly started_at: string;
  readonly finished_at: string;
  /** Each step's text, and its step record's directory as an absolute
   * path, `null` when it has none. */
  readonly steps: readonly { readonly text: string; readonly recordDir: string | null }[];
}

/** A run.json scenario entry, with each step's `record` (relative to the
 * run directory) resolved against `runDir`. */
function asScenario(entry: RunScenario, runDir: string): ScenarioRecord {
  return {
    feature: entry.feature,
    line: entry.line,
    started_at: entry.started_at,
    finished_at: entry.finished_at,
    steps: entry.steps.map((step) => ({ text: step.text, recordDir: step.record === null ? null : path.join(runDir, step.record) })),
  };
}

/** The features the run selected: each file's path and the pickles it ran. */
export interface RunFeature {
  readonly relativePath: string;
  readonly pickles: readonly Pickle[];
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

/** The pickle steps of the scenario a record ran, when the run's features
 * hold that scenario with the same step texts. */
function pickleStepsFor(
  record: ScenarioRecord,
  pickles: ReadonlyMap<string, readonly PickleStep[]>,
): readonly PickleStep[] | undefined {
  const steps = pickles.get(`${record.feature}\u0000${record.line}`);
  if (steps === undefined || steps.length !== record.steps.length) return undefined;
  return steps.every((step, index) => step.text === record.steps[index]!.text) ? steps : undefined;
}

function picklesByScenario(features: readonly RunFeature[]): Map<string, readonly PickleStep[]> {
  const pickles = new Map<string, readonly PickleStep[]>();
  for (const feature of features) {
    for (const pickle of feature.pickles) {
      if (pickle.location !== undefined) {
        pickles.set(`${feature.relativePath}\u0000${pickle.location.line}`, pickle.steps);
      }
    }
  }
  return pickles;
}

function buildTrie(records: readonly ScenarioRecord[], features: readonly RunFeature[]): TrieNode {
  const root: TrieNode = {
    texts: [], withArgument: false, parent: null, children: new Map(), count: 0, ms: 0, first: null, mayWrite: false,
  };
  const pickles = picklesByScenario(features);

  for (const record of records) {
    let node = root;
    let prefixMs = 0;
    const position: SourcePosition = { feature: record.feature, line: record.line };
    const pickleSteps = pickleStepsFor(record, pickles);
    for (const [index, step] of record.steps.entries()) {
      const pickleStep = pickleSteps?.[index];
      if (pickleStep?.type === PickleStepType.ACTION || pickleStep?.type === PickleStepType.OUTCOME) break;
      const stepRecord = step.recordDir === null ? null : readStepRecord(step.recordDir);
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

function toFinding(node: TrieNode, totalScenarioMs: number): Finding {
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
  const info = runCodeInfo("repeated-scenario-prefix");
  return {
    severity: info.severity,
    code: "repeated-scenario-prefix",
    ...(node.first === null ? {} : { file: node.first.feature }),
    fix: info.fix,
    message:
      `${node.count} scenarios begin with the same ${node.texts.length} ` +
      `step${node.texts.length === 1 ? "" : "s"}, which took ${seconds} seconds across them, ` +
      `${percentage}% of this run's summed scenario time. The shared steps: ${steps}. ` +
      (node.withArgument ? "The shared steps take the same docstring or table. " : "") +
      lift,
  };
}

/** One record per scenario (feature and line), the latest started: a
 * `nuka run --repeat <n>` run holds `n` records for one scenario, and a
 * run over several environments (`--env a --env b`) holds one per
 * environment. Counting them would report the scenario's own repetition as
 * a shared opening between "n scenarios" that are the same one; a process
 * fixture is built once per environment anyway, so lifting it would save
 * nothing across them. */
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

/** The run's `repeated-scenario-prefix` notes. `runDir` is the run
 * directory, absolute, that each step's `record` is relative to. */
export function findRepeatedScenarioPrefixes(
  runDir: string,
  scenarios: readonly RunScenario[],
  features: readonly RunFeature[],
): Finding[] {
  const records = onePerScenario(scenarios.map((entry) => asScenario(entry, runDir)));
  if (records.length === 0) return [];
  const totalScenarioMs = records.reduce(
    (total, record) => total + elapsedMs(record.started_at, record.finished_at),
    0,
  );
  if (totalScenarioMs === 0) return [];
  const root = buildTrie(records, features);
  return removeOverlaps(collectCandidates(root, totalScenarioMs * 0.02)).map((node) =>
    toFinding(node, totalScenarioMs),
  );
}
