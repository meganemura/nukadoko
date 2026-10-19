import type { Background, GherkinDocument, Pickle, Rule, Scenario, Step, TableRow } from "@cucumber/messages";
import { parseFeatureSource } from "../feature/load-features.js";
import type { RemovedCriterion, RunCriteria, StepFileChange } from "../record/run-result.js";
import { listFeatureFilesAtCommit, readAtCommit, stepFileChange } from "./git-since.js";

// Responsibility: `nuka run --since <ref>`'s one judgment: whether each
// scenario's own criteria are unchanged, changed, new, or not decidable
// since the ref, which criteria the ref held that are gone, and whether
// each step file differs from the ref. `compareSince` is the one entry
// point src/cli/run.ts calls; the matching under it is pure and exported
// for its tests. Boundary: reading the ref out of git is
// src/run/git-since.ts, and writing the result into run.json is
// src/cli/run.ts.
//
// What counts as a scenario's criteria: what decides how the scenario
// runs, read from the compiled pickle rather than the file. That is every
// tag it carries (Feature, Rule, Scenario, and Examples tags choose hooks,
// serial runs, and selection), then each step, Background steps first,
// with its effective keyword (an `And` or `But` takes the keyword it
// continues), its text, its docstring's content and media type, and its
// data table's cells, and, for one row of a Scenario Outline, the
// Examples header and that row. Indentation, blank lines, comments, a
// docstring's delimiter, and the order of other scenarios never count.
// The comparison is of that structure, serialized as JSON, so a table
// cell that holds `|` cannot collide with two cells. The readable lines
// (`lines`) are for a person and are never compared.
//
// How a scenario is found at the ref: by its Rule's name and its own name,
// never by its line, which moves whenever anything above it changes. An
// Examples row is found by its header and cell values, so a row whose
// values changed reads as new and the row it replaced as removed. When a
// name repeats, at the ref or now, the scenarios of that name are matched
// by content first; what content cannot pair one to one is `ambiguous`,
// with the reason, rather than matched by position, which is a guess.

/** The key run.json and the summary find one scenario execution by: its
 * feature file and its pickle's line. */
export function scenarioKey(feature: string, line: number): string {
  return `${feature}\u0000${line}`;
}

/** One pickle's criteria. */
export interface Criterion {
  /** The pickle's line, which `scenarioKey` keys a scenario by. */
  readonly line: number;
  readonly rule: string | null;
  readonly name: string;
  /** Rule, name, and, for an Examples row, its header and values: how
   * the same criterion is found in another version of the file. */
  readonly group: string;
  /** The structure that is compared, as JSON. */
  readonly form: string;
  /** The criteria as a person reads them. Display only. */
  readonly lines: readonly string[];
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

/** One criterion per pickle, built in one pass over the document, in
 * pickle order. Pure. */
export function criteriaOfDocument(document: GherkinDocument, pickles: readonly Pickle[]): Criterion[] {
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
    const tags = [...new Set(pickle.tags.map((tag) => tag.name))].sort();
    const form = JSON.stringify({
      tags,
      steps: pickle.steps.map((step) => ({
        keyword: step.type ?? "Unknown",
        text: step.text,
        docString: step.argument?.docString === undefined ? null : { mediaType: step.argument.docString.mediaType ?? null, content: step.argument.docString.content },
        rows: step.argument?.dataTable === undefined ? null : step.argument.dataTable.rows.map((row) => row.cells.map((cell) => cell.value)),
      })),
      example: example === undefined ? null : { header: cells(example.header), row: cells(example.row) },
    });
    const rule = place.rule?.name ?? null;
    const name = place.scenario.name;
    const group = JSON.stringify([rule, name, ...(example === undefined ? [] : [cells(example.header), cells(example.row)])]);
    const lines = [
      ...(tags.length === 0 ? [] : [tags.join(" ")]),
      ...place.backgrounds.flatMap((background) => background.steps.flatMap(stepLines)),
      ...place.scenario.steps.flatMap(stepLines),
      ...(example === undefined ? [] : [...(example.header === undefined ? [] : [rowLine(example.header)]), rowLine(example.row)]),
    ];
    criteria.push({ line: pickle.location?.line ?? 0, rule, name, group, form, lines });
  }
  return criteria;
}

export type CriterionVerdict =
  | { readonly change: "unchanged" | "changed" | "new" }
  | { readonly change: "ambiguous"; readonly reason: string };

export interface CriteriaMatch {
  /** Keyed by the criterion's line now. */
  readonly verdicts: ReadonlyMap<number, CriterionVerdict>;
  /** Criteria the ref held that nothing now matches, in the ref's order. */
  readonly removed: readonly Criterion[];
}

/** Matches one file's criteria at the ref with its criteria now. `before`
 * is `null` when the ref holds no such file. Pure. */
export function matchCriteria(before: readonly Criterion[] | null, now: readonly Criterion[]): CriteriaMatch {
  const verdicts = new Map<number, CriterionVerdict>();
  if (before === null) {
    for (const criterion of now) verdicts.set(criterion.line, { change: "new" });
    return { verdicts, removed: [] };
  }
  const groups = new Map<string, { before: Criterion[]; now: Criterion[] }>();
  const groupOf = (key: string) => {
    let group = groups.get(key);
    if (group === undefined) {
      group = { before: [], now: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const criterion of before) groupOf(criterion.group).before.push(criterion);
  for (const criterion of now) groupOf(criterion.group).now.push(criterion);
  const removed = new Set<Criterion>();
  for (const group of groups.values()) {
    // Content first: an identical criterion of the same name is the same one.
    const unmatchedBefore = [...group.before];
    const unmatchedNow: Criterion[] = [];
    for (const criterion of group.now) {
      const index = unmatchedBefore.findIndex((candidate) => candidate.form === criterion.form);
      if (index === -1) {
        unmatchedNow.push(criterion);
      } else {
        unmatchedBefore.splice(index, 1);
        verdicts.set(criterion.line, { change: "unchanged" });
      }
    }
    if (unmatchedNow.length === 0) {
      for (const criterion of unmatchedBefore) removed.add(criterion);
    } else if (unmatchedBefore.length === 0) {
      for (const criterion of unmatchedNow) verdicts.set(criterion.line, { change: "new" });
    } else if (unmatchedBefore.length === 1 && unmatchedNow.length === 1) {
      verdicts.set(unmatchedNow[0]!.line, { change: "changed" });
    } else {
      const { name } = unmatchedNow[0]!;
      const reason =
        `${unmatchedBefore.length} scenarios named ${JSON.stringify(name)} at the ref and ${unmatchedNow.length} now differ in content, ` +
        "so which one changed cannot be told";
      for (const criterion of unmatchedNow) verdicts.set(criterion.line, { change: "ambiguous", reason });
    }
  }
  return { verdicts, removed: before.filter((criterion) => removed.has(criterion)) };
}

export interface SinceFeature {
  /** Relative to the project root. */
  readonly relativePath: string;
  readonly source: string;
}

export interface CompareSinceInput {
  readonly rootDir: string;
  readonly commit: string;
  /** The feature files the run selected, whole. */
  readonly features: readonly SinceFeature[];
  /** The run's targets without their `:line`, relative to the project
   * root: the ref's feature files under a directory target are compared
   * too, so a file deleted since the ref has its criteria removed. */
  readonly targets: readonly string[];
  readonly stepFiles: readonly string[];
}

export interface SinceComparison {
  /** Keyed by `scenarioKey`, without `step_files`, which the caller adds
   * per scenario. */
  readonly criteria: ReadonlyMap<string, Omit<RunCriteria, "step_files">>;
  readonly removed: readonly RemovedCriterion[];
  readonly stepFiles: ReadonlyMap<string, StepFileChange>;
}

function parsed(source: string, relativePath: string): { readonly criteria: Criterion[] } | { readonly problem: string } {
  try {
    const { gherkinDocument, pickles } = parseFeatureSource(source, relativePath);
    return { criteria: criteriaOfDocument(gherkinDocument, pickles) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The parser's message is a heading line, then one line per error.
    return { problem: message.split("\n").map((line) => line.trim()).filter((line) => line !== "" && line !== "Parser errors:").join("; ") };
  }
}

/** Compares the run's feature files and step files with `commit`. Throws
 * src/run/git-since.ts's `SinceGitError` for a git failure other than a
 * file the commit does not hold. */
export async function compareSince(input: CompareSinceInput): Promise<SinceComparison> {
  const { rootDir, commit } = input;
  const criteria = new Map<string, Omit<RunCriteria, "step_files">>();
  const removed: RemovedCriterion[] = [];
  const toRemoved = (feature: string, criterion: Criterion): RemovedCriterion => ({
    feature,
    rule: criterion.rule,
    scenario: criterion.name,
    lines: criterion.lines,
  });
  const selectedPaths = new Set(input.features.map((feature) => feature.relativePath));
  for (const feature of input.features) {
    const now = parsed(feature.source, feature.relativePath);
    if ("problem" in now) throw new Error(`${feature.relativePath} no longer parses: ${now.problem}`);
    const source = await readAtCommit(rootDir, commit, feature.relativePath);
    const before = source === undefined ? null : parsed(source, feature.relativePath);
    if (before !== null && "problem" in before) {
      const reason = `${feature.relativePath} does not parse at the ref (${before.problem}), so its criteria cannot be compared`;
      for (const criterion of now.criteria) criteria.set(scenarioKey(feature.relativePath, criterion.line), { changed_since: "unknown", reason, lines: criterion.lines });
      continue;
    }
    const match = matchCriteria(before === null ? null : before.criteria, now.criteria);
    for (const criterion of now.criteria) {
      const verdict = match.verdicts.get(criterion.line);
      if (verdict === undefined) throw new Error(`${feature.relativePath}:${criterion.line} has no criteria verdict`);
      criteria.set(scenarioKey(feature.relativePath, criterion.line), {
        changed_since: verdict.change,
        ...("reason" in verdict ? { reason: verdict.reason } : {}),
        ...(verdict.change === "unchanged" ? {} : { lines: criterion.lines }),
      });
    }
    removed.push(...match.removed.map((criterion) => toRemoved(feature.relativePath, criterion)));
  }
  // A feature file the ref held under a directory the run targeted, and
  // the run no longer has: every criterion of it is removed.
  const gone = new Set<string>();
  for (const target of input.targets) {
    for (const file of await listFeatureFilesAtCommit(rootDir, commit, target)) {
      if (!selectedPaths.has(file)) gone.add(file);
    }
  }
  for (const file of [...gone].sort((a, b) => a.localeCompare(b))) {
    const source = await readAtCommit(rootDir, commit, file);
    if (source === undefined) continue;
    const before = parsed(source, file);
    // A file that did not parse at the ref held no criteria anyone ran.
    if ("problem" in before) continue;
    removed.push(...before.criteria.map((criterion) => toRemoved(file, criterion)));
  }
  const stepFiles = new Map<string, StepFileChange>();
  for (const file of input.stepFiles) {
    if (!stepFiles.has(file)) stepFiles.set(file, await stepFileChange(rootDir, commit, file));
  }
  return { criteria, removed, stepFiles };
}
