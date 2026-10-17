import { StepKeywordType, type GherkinDocument, type Scenario, type Step } from "@cucumber/messages";

// Responsibility: the two scenario shapes `nuka check` warns about that the
// document alone decides, read before the pickle list is all a caller keeps:
// a scenario with no Then, and an outline whose rows all share one name.
// Boundary: it reads keywords and Examples headers only; whether a step
// asserts anything is the step's business, so a scenario of only `*` lines
// is left alone (its author chose not to say which steps are outcomes).

export interface ScenarioWithoutThen {
  readonly code: "scenario-without-then";
  readonly relativePath: string;
  readonly line: number;
  readonly name: string;
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
// the Background's last keyword), but only the scenario's own steps decide
// whether its author named positions at all: a Background is shared setup, so
// a scenario of only `*` lines under a Given Background is still left alone.
function withoutThen(background: readonly Step[], steps: readonly Step[]): boolean {
  const types = resolvedKeywordTypes([...background, ...steps]);
  const own = types.slice(background.length);
  return (
    !types.includes(StepKeywordType.OUTCOME) &&
    own.some((type) => type === StepKeywordType.CONTEXT || type === StepKeywordType.ACTION)
  );
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
    if (withoutThen(background, scenario.steps)) {
      findings.push({
        code: "scenario-without-then",
        relativePath,
        line: scenario.location.line,
        name: scenario.name,
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
