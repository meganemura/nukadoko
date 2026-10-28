import type { Background, GherkinDocument, Pickle, Rule, Scenario, Step, TableRow } from "@cucumber/messages";
import { HELD_TAG, isConditionShaped } from "../condition/condition.js";

// Responsibility: what one criterion is, and how `nuka run --base <ref>`
// finds the same criterion at the ref (docs/spec.md "Verdicts"). A
// criterion is one pickle: a scenario, or one Examples row of an outline.
// Its identity is its feature file and its name. Its content is what a
// person approved: the steps in order, Background steps first, each with
// its effective keyword (an And or a But takes the keyword it continues),
// its text, its docstring, and its table; the Examples row; and the
// condition tags and `@held`, which decide where it must hold. Boundary:
// pure. Reading the ref's files is src/run/base-run.ts's.
//
// Other tags and the name are not content: a scenario renamed, moved to
// another file, or tagged `@smoke` still says what it said. A tag can still
// change what runs (a hook selected by tag, a World that reads the tags),
// so a criterion whose tags changed keeps its identity and its change and
// is marked `retagged`, which runs it in the old world as a changed
// mapping does. A name or a file can too (a hook or a World that reads the
// pickle's name or its document), so a criterion matched under another
// identity (`renamedFrom`) runs there as well. A name and a
// line are what a person reads, so the lines a row carries are rebuilt from
// the document, and only the content is compared, as JSON, so a table cell
// that holds `|` cannot collide with two cells.
//
// Matching, in order: the same identity and the same content is
// `unchanged`; the same content under another identity is `unchanged` with
// `renamed_from`; the same identity left over once on each side is
// `changed`; what is left at head is `new`, and what is left at the ref is
// `removed`. A rename is taken only where it is the one answer: a candidate
// in the same feature file first, then one anywhere, and in each round only
// a pair where the head criterion has one candidate and that candidate one
// head criterion claiming it. Taking the first of several would make the
// answer depend on the order the files were read in, and either of two
// equal candidates is a guess. A name that repeats with differing content
// on both sides is left `new` and `removed` rather than paired by position,
// for the same reason; all of those are judged as strictly as `changed`.

/** One pickle as `--base` reads it. */
export interface Criterion {
  /** The feature file, relative to the project root. */
  readonly feature: string;
  /** The pickle's line in that file. */
  readonly line: number;
  readonly name: string;
  /** What is compared, as JSON. */
  readonly content: string;
  /** Its condition tags and `@held`, the tags that are content. */
  readonly tags: readonly string[];
  /** Every tag it carries, each once, sorted: what a retag compares. */
  readonly allTags: readonly string[];
  /** The criterion as a person reads it. Display only. */
  readonly lines: readonly string[];
}

/** Where a criterion was at the ref, by identity. */
export interface CriterionPlace {
  readonly feature: string;
  readonly name: string;
}

/** What one criterion at head is, against the ref. */
export type CriterionChange =
  | {
      readonly change: "unchanged";
      /** The same criterion at the ref, where the ref's world runs it. */
      readonly at: { readonly feature: string; readonly line: number };
      /** Present when the ref holds it under another name or file. */
      readonly renamedFrom?: CriterionPlace;
      /** Present when its tags differ from the ref's. */
      readonly retagged?: true;
    }
  | { readonly change: "changed" | "new" };

export interface CriteriaComparison {
  /** Keyed by `criterionKey` of the head criterion. */
  readonly changes: ReadonlyMap<string, CriterionChange>;
  /** Criteria the ref holds that head does not, in the ref's order. */
  readonly removed: readonly Criterion[];
}

/** The key a row and a cell find one criterion by: its file and line. */
export function criterionKey(feature: string, line: number): string {
  return `${feature}\u0000${line}`;
}

function rowLine(row: TableRow): string {
  return `| ${row.cells.map((cell) => cell.value.replaceAll("\\", "\\\\").replaceAll("|", "\\|")).join(" | ")} |`;
}

function stepLines(step: Step): string[] {
  const lines = [`${step.keyword.trim()} ${step.text}`];
  if (step.docString !== undefined) {
    const fence = step.docString.delimiter;
    lines.push(`${fence}${step.docString.mediaType ?? ""}`, ...step.docString.content.split("\n"), fence);
  }
  for (const row of step.dataTable?.rows ?? []) lines.push(rowLine(row));
  return lines;
}

interface ScenarioPlace {
  readonly rule: Rule | null;
  readonly backgrounds: readonly Background[];
  readonly scenario: Scenario;
}

function placesById(document: GherkinDocument): Map<string, ScenarioPlace> {
  const places = new Map<string, ScenarioPlace>();
  const feature = document.feature;
  if (feature === undefined) return places;
  const featureBackgrounds = feature.children.flatMap((child) => (child.background !== undefined ? [child.background] : []));
  for (const child of feature.children) {
    if (child.scenario !== undefined) places.set(child.scenario.id, { rule: null, backgrounds: featureBackgrounds, scenario: child.scenario });
    if (child.rule !== undefined) {
      const rule = child.rule;
      const backgrounds = [...featureBackgrounds, ...rule.children.flatMap((ruleChild) => (ruleChild.background !== undefined ? [ruleChild.background] : []))];
      for (const ruleChild of rule.children) {
        if (ruleChild.scenario !== undefined) places.set(ruleChild.scenario.id, { rule, backgrounds, scenario: ruleChild.scenario });
      }
    }
  }
  return places;
}

/** The tags that are content: condition tags, as written, and `@held`,
 * each once and in a fixed order, since the order tags stand in on a line
 * means nothing. Pure. */
export function contentTags(tags: readonly string[]): string[] {
  return [...new Set(tags.filter((tag) => tag === HELD_TAG || isConditionShaped(tag)))].sort();
}

/** One criterion per pickle of one feature file, in pickle order. Pure. */
export function criteriaOfFeature(feature: string, document: GherkinDocument, pickles: readonly Pickle[]): Criterion[] {
  const places = placesById(document);
  const rows = new Map<string, { header: TableRow | undefined; row: TableRow }>();
  for (const place of places.values()) {
    for (const examples of place.scenario.examples) {
      for (const row of examples.tableBody) rows.set(row.id, { header: examples.tableHeader, row });
    }
  }
  const criteria: Criterion[] = [];
  for (const pickle of pickles) {
    const [scenarioId, rowId] = pickle.astNodeIds;
    const place = scenarioId === undefined ? undefined : places.get(scenarioId);
    if (place === undefined) continue;
    const example = rowId === undefined ? undefined : rows.get(rowId);
    const cells = (row: TableRow | undefined): string[] => row?.cells.map((cell) => cell.value) ?? [];
    const tags = contentTags(pickle.tags.map((tag) => tag.name));
    const content = JSON.stringify({
      steps: pickle.steps.map((step) => ({
        keyword: step.type ?? "Unknown",
        text: step.text,
        docString: step.argument?.docString === undefined ? null : { mediaType: step.argument.docString.mediaType ?? null, content: step.argument.docString.content },
        rows: step.argument?.dataTable === undefined ? null : step.argument.dataTable.rows.map((row) => row.cells.map((cell) => cell.value)),
      })),
      example: example === undefined ? null : { header: cells(example.header), row: cells(example.row) },
      tags,
    });
    const lines = [
      ...(tags.length === 0 ? [] : [tags.join(" ")]),
      ...place.backgrounds.flatMap((background) => background.steps.flatMap(stepLines)),
      ...place.scenario.steps.flatMap(stepLines),
      ...(example === undefined ? [] : [...(example.header === undefined ? [] : [rowLine(example.header)]), rowLine(example.row)]),
    ];
    const allTags = [...new Set(pickle.tags.map((tag) => tag.name))].sort();
    criteria.push({ feature, line: pickle.location?.line ?? 0, name: pickle.name, content, tags, allTags, lines });
  }
  return criteria;
}

function identity(criterion: Pick<Criterion, "feature" | "name">): string {
  return `${criterion.feature}\u0000${criterion.name}`;
}

/** Each head criterion's change against the ref, and the criteria the ref
 * holds that head does not (this file's header). Pure. */
export function compareCriteria(base: readonly Criterion[], head: readonly Criterion[]): CriteriaComparison {
  const changes = new Map<string, CriterionChange>();
  const unmatchedBase = new Set(base);
  const unmatchedHead: Criterion[] = [];
  const take = (found: Criterion, criterion: Criterion, renamed: boolean): void => {
    unmatchedBase.delete(found);
    changes.set(criterionKey(criterion.feature, criterion.line), {
      change: "unchanged",
      at: { feature: found.feature, line: found.line },
      ...(renamed ? { renamedFrom: { feature: found.feature, name: found.name } } : {}),
      ...(found.allTags.join("\u0000") === criterion.allTags.join("\u0000") ? {} : { retagged: true as const }),
    });
  };
  for (const criterion of head) {
    const found = [...unmatchedBase].find((candidate) => identity(candidate) === identity(criterion) && candidate.content === criterion.content);
    if (found === undefined) unmatchedHead.push(criterion);
    else take(found, criterion, false);
  }
  let leftAfterRename = unmatchedHead;
  for (const sameFile of [true, false]) {
    const candidatesOf = new Map<Criterion, Criterion[]>();
    const claimants = new Map<Criterion, number>();
    for (const criterion of leftAfterRename) {
      const candidates = [...unmatchedBase].filter((candidate) => candidate.content === criterion.content && (!sameFile || candidate.feature === criterion.feature));
      candidatesOf.set(criterion, candidates);
      for (const candidate of candidates) claimants.set(candidate, (claimants.get(candidate) ?? 0) + 1);
    }
    const left: Criterion[] = [];
    for (const criterion of leftAfterRename) {
      const candidates = candidatesOf.get(criterion)!;
      if (candidates.length === 1 && claimants.get(candidates[0]!) === 1) take(candidates[0]!, criterion, true);
      else left.push(criterion);
    }
    leftAfterRename = left;
  }
  const byIdentity = (list: Iterable<Criterion>): Map<string, Criterion[]> => {
    const groups = new Map<string, Criterion[]>();
    for (const criterion of list) groups.set(identity(criterion), [...(groups.get(identity(criterion)) ?? []), criterion]);
    return groups;
  };
  const baseGroups = byIdentity(unmatchedBase);
  const headGroups = byIdentity(leftAfterRename);
  for (const [key, group] of headGroups) {
    const before = baseGroups.get(key) ?? [];
    const paired = group.length === 1 && before.length === 1;
    if (paired) unmatchedBase.delete(before[0]!);
    for (const criterion of group) changes.set(criterionKey(criterion.feature, criterion.line), { change: paired ? "changed" : "new" });
  }
  return { changes, removed: base.filter((criterion) => unmatchedBase.has(criterion)) };
}
