import type { Background, GherkinDocument, Pickle, Scenario, Step } from "@cucumber/messages";
import { parseFeatureSource } from "../feature/load-features.js";
import type { CriteriaChange } from "../record/run-result.js";

// Responsibility: `nuka run --since <ref>`'s one judgment, pure: whether a
// scenario's own criteria are unchanged, changed, or new since the ref.
// Boundary: it takes feature text and parsed documents and returns lines
// and verdicts; reading the ref's text out of git is src/run/git-since.ts,
// and writing the verdict into run.json is src/cli/run.ts.
//
// What counts as a scenario's criteria: the lines a person approved, read
// from the Gherkin tree rather than the file, so indentation, blank lines,
// comments, tags, and the order of other scenarios never count as a
// change. They are every Background step of the feature and of the Rule
// that holds the scenario, then the scenario's own steps, each with its
// keyword, docstring, and data table, and, for one row of a Scenario
// Outline, the Examples header and that row.
//
// How a scenario is found at the ref: by its Rule's name, its own name, and
// which scenario of that name it is in the file, never by its line, which
// moves whenever anything above it changes. An Examples row is found by its
// cell values (and which row of those values it is), so a row whose values
// changed reads as new, and the row it replaced is no longer selected. A
// renamed scenario is new for the same reason: the name is how a reader
// says which criterion they mean.

interface ScenarioPlace {
  readonly rule: string | null;
  readonly backgrounds: readonly Background[];
  readonly scenario: Scenario;
  /** Which scenario of this rule and name it is, from 0, in file order. */
  readonly occurrence: number;
}

function placesOf(document: GherkinDocument): ScenarioPlace[] {
  const places: ScenarioPlace[] = [];
  const seen = new Map<string, number>();
  const feature = document.feature;
  if (feature === undefined) return places;
  const featureBackgrounds = feature.children.flatMap((child) => (child.background !== undefined ? [child.background] : []));
  const visit = (rule: string | null, backgrounds: readonly Background[], scenario: Scenario): void => {
    const name = `${rule ?? ""}\u0000${scenario.name}`;
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    places.push({ rule, backgrounds, scenario, occurrence });
  };
  for (const child of feature.children) {
    if (child.scenario !== undefined) visit(null, featureBackgrounds, child.scenario);
    if (child.rule !== undefined) {
      const ruleBackgrounds = child.rule.children.flatMap((ruleChild) => (ruleChild.background !== undefined ? [ruleChild.background] : []));
      for (const ruleChild of child.rule.children) {
        if (ruleChild.scenario !== undefined) visit(child.rule.name, [...featureBackgrounds, ...ruleBackgrounds], ruleChild.scenario);
      }
    }
  }
  return places;
}

function tableRow(cells: readonly { readonly value: string }[]): string {
  return `| ${cells.map((cell) => cell.value).join(" | ")} |`;
}

function stepLines(step: Step): string[] {
  const lines = [`${step.keyword.trim()} ${step.text}`];
  if (step.docString !== undefined) {
    lines.push(step.docString.delimiter, ...step.docString.content.split("\n"), step.docString.delimiter);
  }
  for (const row of step.dataTable?.rows ?? []) lines.push(tableRow(row.cells));
  return lines;
}

function placeKey(place: ScenarioPlace): string {
  return `${place.rule ?? ""}\u0000${place.scenario.name}\u0000${place.occurrence}`;
}

interface CriteriaEntry {
  readonly key: string;
  readonly scenarioId: string;
  /** The Examples row's id, or `null` for a scenario with no Examples. */
  readonly rowId: string | null;
  readonly lines: readonly string[];
}

/** One entry per pickle a document compiles to, under the key that finds
 * the same criterion in another version of the file, with its lines. */
function criteriaEntries(document: GherkinDocument): CriteriaEntry[] {
  const entries: CriteriaEntry[] = [];
  for (const place of placesOf(document)) {
    const base = [
      ...place.backgrounds.flatMap((background) => background.steps.flatMap(stepLines)),
      ...place.scenario.steps.flatMap(stepLines),
    ];
    if (place.scenario.examples.length === 0) {
      entries.push({ key: placeKey(place), scenarioId: place.scenario.id, rowId: null, lines: base });
      continue;
    }
    const rowsSeen = new Map<string, number>();
    for (const examples of place.scenario.examples) {
      const header = examples.tableHeader === undefined ? [] : [tableRow(examples.tableHeader.cells)];
      for (const row of examples.tableBody) {
        const values = `${header.join("")}\u0000${row.cells.map((cell) => cell.value).join("\u0000")}`;
        const occurrence = rowsSeen.get(values) ?? 0;
        rowsSeen.set(values, occurrence + 1);
        entries.push({
          key: `${placeKey(place)}\u0000${values}\u0000${occurrence}`,
          scenarioId: place.scenario.id,
          rowId: row.id,
          lines: [...base, ...header, tableRow(row.cells)],
        });
      }
    }
  }
  return entries;
}

/** A pickle's criteria in `document`, the document it was compiled from:
 * its key and its lines. `undefined` for a pickle the document does not
 * hold. Pure. */
export function criteriaOf(document: GherkinDocument, pickle: Pickle): { readonly key: string; readonly lines: readonly string[] } | undefined {
  const [scenarioId, rowId] = pickle.astNodeIds;
  const entry = criteriaEntries(document).find((candidate) => candidate.scenarioId === scenarioId && candidate.rowId === (rowId ?? null));
  return entry === undefined ? undefined : { key: entry.key, lines: entry.lines };
}

/** Compares lines at the ref with lines now: `new` when the ref holds no
 * such criterion. Pure. */
export function classifyCriteria(before: readonly string[] | undefined, after: readonly string[]): CriteriaChange {
  if (before === undefined) return "new";
  return before.length === after.length && before.every((line, index) => line === after[index]) ? "unchanged" : "changed";
}

/** The ref's criteria for one feature file, keyed as `criteriaOf` keys
 * them: an empty map for a file the ref does not hold or cannot parse,
 * so every scenario of it is new. Pure. */
export function criteriaAtRef(source: string | undefined, relativePath: string): ReadonlyMap<string, readonly string[]> {
  if (source === undefined) return new Map();
  let document: GherkinDocument;
  try {
    document = parseFeatureSource(source, relativePath).gherkinDocument;
  } catch {
    return new Map();
  }
  return new Map(criteriaEntries(document).map((entry) => [entry.key, entry.lines]));
}
