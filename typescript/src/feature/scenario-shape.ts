import { StepKeywordType, type GherkinDocument, type Scenario, type Step } from "@cucumber/messages";

// Responsibility: the two scenario shapes `nuka check` warns about that the
// document alone decides, read before the pickle list is all a caller keeps:
// a scenario with no Then, and an outline whose rows all share one name.
// Boundary: it reads keywords and Examples headers only. A scenario of only
// `*` lines has no Then either: a claim step on a `*` line is refused, so
// such a scenario judges no claim and passes whenever its steps run. Whether
// a Then line binds a claim step needs the vocabulary, so src/check/
// feature-check.ts reports that half of the same warning.

export interface ScenarioWithoutThen {
  readonly code: "scenario-without-then";
  readonly relativePath: string;
  readonly line: number;
  readonly name: string;
  /** Every step of the scenario's own is a `*` line. */
  readonly starsOnly: boolean;
}

export interface OutlineRowsShareName {
  readonly code: "outline-rows-share-name";
  readonly relativePath: string;
  readonly line: number;
  readonly name: string;
  readonly rows: number;
  /** The Examples header cells, in order, each once. */
  readonly columns: readonly string[];
}

export type ScenarioShapeFinding = ScenarioWithoutThen | OutlineRowsShareName;

/** Each step's keyword type with `And` and `But` read as the step before
 * them, the way the pickle compiler reads them. A `*` line is Unknown, and
 * so is a conjunction that follows one. */
export function resolvedKeywordTypes(steps: readonly Step[]): StepKeywordType[] {
  let last: StepKeywordType = StepKeywordType.UNKNOWN;
  return steps.map((step) => {
    const type = step.keywordType ?? StepKeywordType.UNKNOWN;
    last = type === StepKeywordType.CONJUNCTION ? last : type;
    return last;
  });
}

// The Background counts toward the Then (a conjunction in the scenario reads
// the Background's last keyword). A scenario with no steps of its own is
// not one anybody runs for an outcome, so it is left alone.
function withoutThen(background: readonly Step[], steps: readonly Step[]): { readonly starsOnly: boolean } | null {
  const types = resolvedKeywordTypes([...background, ...steps]);
  const own = types.slice(background.length);
  if (own.length === 0 || types.includes(StepKeywordType.OUTCOME)) return null;
  return { starsOnly: own.every((type) => type === StepKeywordType.UNKNOWN) };
}

function columnsOf(scenario: Scenario): string[] {
  const columns = scenario.examples.flatMap((block) => block.tableHeader?.cells.map((cell) => cell.value) ?? []);
  return [...new Set(columns)];
}

export function findScenarioShapeFindings(
  gherkinDocument: GherkinDocument,
  relativePath: string,
): readonly ScenarioShapeFinding[] {
  const feature = gherkinDocument.feature;
  if (feature === undefined) {
    return [];
  }
  const findings: ScenarioShapeFinding[] = [];

  const checkScenario = (scenario: Scenario, background: readonly Step[]): void => {
    const missing = withoutThen(background, scenario.steps);
    if (missing !== null) {
      findings.push({
        code: "scenario-without-then",
        relativePath,
        line: scenario.location.line,
        name: scenario.name,
        starsOnly: missing.starsOnly,
      });
    }
    const rows = scenario.examples.reduce((total, block) => total + block.tableBody.length, 0);
    const columns = columnsOf(scenario);
    if (rows > 1 && !columns.some((column) => scenario.name.includes(`<${column}>`))) {
      findings.push({
        code: "outline-rows-share-name",
        relativePath,
        line: scenario.location.line,
        name: scenario.name,
        rows,
        columns,
      });
    }
  };

  const featureBackground: Step[] = [];
  for (const child of feature.children) {
    if (child.background) {
      featureBackground.push(...child.background.steps);
    } else if (child.scenario) {
      checkScenario(child.scenario, featureBackground);
    } else if (child.rule) {
      const ruleBackground = [...featureBackground];
      for (const ruleChild of child.rule.children) {
        if (ruleChild.background) {
          ruleBackground.push(...ruleChild.background.steps);
        } else if (ruleChild.scenario) {
          checkScenario(ruleChild.scenario, ruleBackground);
        }
      }
    }
  }
  return findings;
}
