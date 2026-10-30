import { randomInt } from "node:crypto";
import path from "node:path";
import type { RunOrder } from "../record/run-result.js";
import { shellWord } from "../shell/shell-word.js";

// Responsibility: the order `nuka run` executes its selection in
// (docs/spec.md "Order"), and the rerun line that replays it. File order
// is the order the targets select, unchanged. A shuffled order sorts the
// feature files, then the scenarios inside each file, by a key drawn from
// the seed and each one's path and line. Boundary: which scenarios are
// selected, and how a pass runs them, are src/run/select-pickles.ts's and
// src/cli/run.ts's; this module only puts what was selected in order and
// names the scenarios a rerun runs.
//
// A file stays whole, and only its place and its scenarios' places move:
// `--concurrency` hands a worker whole files, so one seed gives the same
// order at every concurrency. A shuffle that mixed the scenarios of
// several files would give a different order to each worker count.
//
// Sorting by a key, rather than shuffling a list in place, is what keeps
// a rerun exact: the key of a scenario does not depend on what else was
// selected, so any part of a selection runs in the order the whole gave
// it. A rerun line can then name the scenarios that ran before a failed
// one, and a reader who deletes some of them keeps the rest in the same
// order.

/** The largest seed: the key below is 32 bits, so a larger number would
 * name an order a smaller one already names. */
export const MAX_ORDER_SEED = 0xffff_ffff;

const FILE_ORDER: RunOrder = { kind: "file" };

/** `--order`'s value, or `undefined` when it is none of `file`,
 * `shuffled`, and `shuffled:<seed>`. `shuffled` alone takes its seed from
 * `drawSeed`, so the order is recorded with a seed either way. */
export function readOrder(value: string | undefined, drawSeed: () => number = drawOrderSeed): RunOrder | undefined {
  if (value === undefined || value === "file") return FILE_ORDER;
  if (value === "shuffled") return { kind: "shuffled", seed: drawSeed() };
  const match = /^shuffled:(0|[1-9][0-9]{0,9})$/.exec(value);
  if (match === null) return undefined;
  const seed = Number(match[1]);
  return seed > MAX_ORDER_SEED ? undefined : { kind: "shuffled", seed };
}

export function drawOrderSeed(): number {
  return randomInt(0, MAX_ORDER_SEED + 1);
}

/** The order as `--order` spells it. */
export function orderText(order: RunOrder): string {
  return order.kind === "file" ? "file" : `shuffled:${order.seed}`;
}

/** The flags a command needs to run in `order`: none for file order,
 * which is what a command without `--order` runs. */
export function orderFlags(order: RunOrder): readonly string[] {
  return order.kind === "file" ? [] : ["--order", orderText(order)];
}

/** What the order reads of one selected file. */
export interface OrderedFile<P> {
  readonly relativePath: string;
  readonly pickles: readonly P[];
  readonly selectedLines: readonly number[] | null;
}

type Located = { readonly location?: { readonly line: number } };

/** `features` in the run's order. Under a shuffled order each file's
 * `selectedLines` lists its scenarios in their order, since a worker runs
 * the lines it is given in the order given. Pure. */
export function inRunOrder<P extends Located, F extends OrderedFile<P>>(features: readonly F[], order: RunOrder): F[] {
  if (order.kind === "file") return [...features];
  const { seed } = order;
  return sortByKey(features, (feature) => fileKey(seed, feature.relativePath), (feature) => feature.relativePath).map((feature) => {
    const pickles = sortByKey(feature.pickles, (pickle) => scenarioKey(seed, feature.relativePath, lineOf(pickle)), (pickle) => lineOf(pickle));
    return { ...feature, pickles, selectedLines: pickles.map(lineOf) };
  });
}

/** One scenario of a pass, as a rerun target names it. */
export interface PassScenario {
  readonly feature: string;
  readonly line: number;
}

/** The targets that run, in a shuffled order, what ran before `scenario`
 * in its pass and then `scenario`: `sequence` is every scenario of the
 * pass in the order it ran. A file whose every scenario of the pass is
 * among them is named whole when the run's targets named it whole
 * (`wholeFiles`), and by its lines otherwise. Each target is written in
 * the order it ran. Pure. */
export function replayTargets(sequence: readonly PassScenario[], wholeFiles: ReadonlySet<string>, scenario: PassScenario): string[] {
  const at = sequence.findIndex((entry) => entry.feature === scenario.feature && entry.line === scenario.line);
  const ran = at === -1 ? [scenario] : sequence.slice(0, at + 1);
  const inPass = new Map<string, number>();
  for (const entry of sequence) inPass.set(entry.feature, (inPass.get(entry.feature) ?? 0) + 1);
  const targets: string[] = [];
  for (let start = 0; start < ran.length; ) {
    const feature = ran[start]!.feature;
    let end = start;
    while (end < ran.length && ran[end]!.feature === feature) end += 1;
    if (wholeFiles.has(feature) && end - start === inPass.get(feature)) {
      targets.push(feature);
    } else {
      for (const entry of ran.slice(start, end)) targets.push(`${entry.feature}:${entry.line}`);
    }
    start = end;
  }
  return targets;
}

/** `nuka run` with `words`, quoted for a shell. */
export function runCommand(words: readonly string[]): string {
  return ["nuka", "run", ...words].map(shellWord).join(" ");
}

function lineOf(pickle: Located): number {
  return pickle.location?.line ?? 0;
}

// A path is keyed with `/` separators, so one seed names one order on
// every platform.
function fileKey(seed: number, relativePath: string): number {
  return keyOf(seed, relativePath.split(path.sep).join("/"));
}

function scenarioKey(seed: number, relativePath: string, line: number): number {
  return keyOf(seed, `${relativePath.split(path.sep).join("/")}:${line}`);
}

// The seed is mixed before the text and the result after it, so two
// seeds a step apart give unrelated orders, and two names that differ in
// one character get unrelated keys.
function keyOf(seed: number, text: string): number {
  let hash = mix(seed ^ 0x9e37_79b9);
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x0100_0193);
  }
  return mix(hash);
}

function mix(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85eb_ca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2_ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

// Two entries with the same key keep a fixed order, by their name, so a
// collision cannot make a seed name two orders.
function sortByKey<T, N extends string | number>(items: readonly T[], key: (item: T) => number, name: (item: T) => N): T[] {
  return items
    .map((item) => ({ item, key: key(item), name: name(item) }))
    .sort((a, b) => a.key - b.key || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => entry.item);
}
