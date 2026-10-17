import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CucumberExpressionGenerator,
  type ParameterType,
  type ParameterTypeRegistry,
} from "@cucumber/cucumber-expressions";
import { PickleStepType } from "@cucumber/messages";
import { buildExpression } from "../binding/expression.js";
import { ParameterTypeCollisionError } from "../binding/parameter-type-errors.js";
import { patternLiteralFragments, stripCaptureNames } from "../binding/pattern.js";
import { createParameterTypeRegistry } from "../binding/registry.js";
import { analyzeRunSelectionKeepingSteps } from "../check/analyze.js";
import { CAPTURED_CLASS } from "../check/binding-check.js";
import type { UndefinedStepLine } from "../check/feature-check.js";
import { loadConfig } from "../config/load-config.js";
import { isCommonJsProject } from "../config/module-kind.js";
import { attachStepLines, loadFeaturesFromDirs } from "../feature/load-features.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { readCheckTargets } from "./check.js";
import { stepTemplate } from "./scaffold.js";
import { formatVocabularyError } from "./vocabulary.js";

// Responsibility: `nuka scaffold --feature <path>`, one stub per line that
// `nuka check <path>` reports as `undefined-step`, so a sentence is typed
// once, in the feature. Which lines are undefined is the check's own
// verdict (the same analysis, the same selection), not a second matcher;
// each file is the template `nuka scaffold <name> --pattern` writes, and a
// Then line gets the `--then` shape.
//
// The pattern is read from the line by cucumber-expressions' own generator,
// over the registry `nuka check` builds (built-ins, `config.parameterTypes`,
// compat `defineParameterType`), the same reading cucumber-js prints as a
// snippet. Capture keys are `value`, `value2`, ...: the line cannot say what
// a value means, and a key is renamed in the pattern and the args together.
//
// A pattern is written with captures only when the reading ends one way.
// The generator lists every reading; readings that differ only between
// built-in types that hand the step the same kind of value (`{int}` and
// `{float}` for `3`) give the same args schema and the same value for this
// line, so the generator's first is taken. Any other disagreement (a
// project type against a built-in, two project types) is a choice the line
// cannot make, and so is a pattern that would also match some other line of
// the project, which would turn that line into `ambiguous-step`. Then the
// stub's pattern is the line as written, escaped, with no capture, and the
// command says so on stderr. An outline line whose Examples rows read
// differently has no single literal to fall back to, so it gets no file and
// a note instead.
//
// Names come from the pattern's literal words in kebab-case, made distinct
// from every step the project defines and every file in the steps
// directory, so nothing is overwritten and no name is defined twice. Lines
// that read as one pattern share one file.

export interface RunScaffoldFeatureOptions {
  rootDir: string;
  /** The `--feature` value: a feature file, an oath, or a directory. */
  feature: string;
  stdout: WritableSink;
  stderr: WritableSink;
}

/** How a line is read: with the captures its literals stand for, or, when
 * that reading is not the only one, as the line itself. */
export type InferredPattern =
  | { readonly kind: "captured"; readonly pattern: string }
  | { readonly kind: "literal"; readonly pattern: string; readonly readings: readonly string[] };

const NAME_LIMIT = 60;

/** A step file by any of these names would define the same step name. */
const STEP_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

function captureKey(index: number): string {
  return index === 0 ? "value" : `value${index + 1}`;
}

/** Gives each `{type}` token of a generated expression a key. The
 * generator escapes a literal brace, so every unescaped `{...}` is one of
 * its parameters, in order. */
export function nameCaptures(source: string): string {
  let result = "";
  let index = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\" && i + 1 < source.length) {
      result += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "{") {
      const end = source.indexOf("}", i + 1);
      result += `{${captureKey(index)}:${source.slice(i + 1, end)}}`;
      index += 1;
      i = end + 1;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

/** Whether two readings of one literal give the step the same value: the
 * same type, or two built-ins of one value class. */
function sameReading(a: ParameterType<unknown>, b: ParameterType<unknown>): boolean {
  if (a === b) return true;
  const classOfA = CAPTURED_CLASS.get(a.name ?? "");
  return classOfA !== undefined && classOfA === CAPTURED_CLASS.get(b.name ?? "");
}

function matches(pattern: string, text: string, registry: ParameterTypeRegistry): boolean {
  try {
    return buildExpression(pattern, registry).expression.match(text) !== null;
  } catch {
    return false;
  }
}

/** The generator escapes `(`, `{`, and `/` but leaves a backslash bare,
 * which cucumber-expressions then refuses; doubling it first makes every
 * backslash in the output an escape the parser reads as itself. */
function generate(text: string, parameterTypes: readonly ParameterType<unknown>[]) {
  return new CucumberExpressionGenerator(() => parameterTypes).generateExpressions(text.replaceAll("\\", "\\\\"));
}

/** The line as a pattern that matches it and nothing else. */
export function literalPattern(text: string): string {
  return generate(text, [])[0]!.source;
}

/** Reads one feature line as a pattern under `registry`. A captured
 * pattern always matches the line it was read from. */
export function inferPattern(text: string, registry: ParameterTypeRegistry): InferredPattern {
  const generated = generate(text, [...registry.parameterTypes]);
  const first = generated[0]!;
  const oneReading = generated.every(
    (expression) =>
      expression.parameterTypes.length === first.parameterTypes.length &&
      expression.parameterTypes.every((type, index) => sameReading(type, first.parameterTypes[index]!)),
  );
  const pattern = nameCaptures(first.source);
  if (oneReading && matches(pattern, text, registry)) return { kind: "captured", pattern };
  return { kind: "literal", pattern: literalPattern(text), readings: generated.map((expression) => expression.source) };
}

/** The step name a pattern's literal words make, in kebab-case. */
export function stepNameFor(pattern: string): string {
  const words = patternLiteralFragments(pattern)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (words === "") return "step";
  if (words.length <= NAME_LIMIT) return words;
  const cut = words.slice(0, NAME_LIMIT + 1);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut.slice(0, NAME_LIMIT)).replace(/-+$/, "");
}

/** `base`, or `base-2`, `base-3`, ..., whichever is not taken. */
export function distinctName(base: string, isTaken: (name: string) => boolean): string {
  if (!isTaken(base)) return base;
  let suffix = 2;
  while (isTaken(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function location(step: UndefinedStepLine): string {
  return step.line === undefined ? step.file : `${step.file}:${step.line}`;
}

/** The undefined lines grouped by the line they sit on: an outline line
 * is reported once per Examples row that reads differently. */
function byLine(steps: readonly UndefinedStepLine[]): UndefinedStepLine[][] {
  const groups = new Map<string, UndefinedStepLine[]>();
  for (const step of steps) {
    const key = location(step);
    const group = groups.get(key) ?? [];
    group.push(step);
    groups.set(key, group);
  }
  return [...groups.values()];
}

interface PlannedStub {
  readonly pattern: string;
  readonly lines: UndefinedStepLine[];
}

interface ProjectLine {
  readonly where: string;
  readonly text: string;
}

export async function runScaffoldFeature(options: RunScaffoldFeatureOptions): Promise<number> {
  const { rootDir, feature, stdout, stderr } = options;
  let config;
  let selected;
  try {
    config = await loadConfig(rootDir);
    selected = await readCheckTargets(rootDir, [feature], "nuka scaffold --feature");
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }
  const unparsed = selected.parseErrors[0];
  if (unparsed !== undefined) {
    stderr.write(`Refusing to scaffold: ${unparsed.relativePath} does not parse: ${unparsed.message}\n`);
    return 1;
  }

  let analysis;
  try {
    analysis = await analyzeRunSelectionKeepingSteps(rootDir, selected.features);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }
  const { discovery, undefinedSteps } = analysis;
  if (discovery.importFailures.length > 0) {
    stderr.write(
      `Refusing to scaffold: ${discovery.importFailures.length} step file(s) did not import, so which lines are undefined is not known (a line may belong to a step in one of them); \`nuka check\` names them\n`,
    );
    return 1;
  }
  let registry: ParameterTypeRegistry;
  try {
    registry = createParameterTypeRegistry([...config.parameterTypes, ...discovery.compatParameterTypes]);
  } catch (error) {
    if (!(error instanceof ParameterTypeCollisionError)) throw error;
    stderr.write(`Refusing to scaffold: ${error.message}\n`);
    return 1;
  }
  if (undefinedSteps.length === 0) {
    stderr.write(`nothing to scaffold: every line in ${feature} matches a step\n`);
    return 0;
  }

  const projectLines: ProjectLine[] = [];
  const scanned = loadFeaturesFromDirs(rootDir, config.featuresDir, config.additionalFeatureDirs, config.oaths).features;
  const selectedFiles = selected.features.map((file) => ({
    relativePath: file.relativePath,
    pickles: attachStepLines(file.pickles, file.gherkinDocument),
  }));
  for (const file of [...scanned, ...selectedFiles]) {
    for (const pickle of file.pickles) {
      for (const step of pickle.steps) {
        projectLines.push({ where: step.line === undefined ? file.relativePath : `${file.relativePath}:${step.line}`, text: step.text });
      }
    }
  }

  const readingOf = new Map<string, InferredPattern>();
  for (const step of undefinedSteps) {
    if (!readingOf.has(step.text)) readingOf.set(step.text, inferPattern(step.text, registry));
  }
  const notes: string[] = [];
  const planned = new Map<string, PlannedStub>();
  for (const group of byLine(undefinedSteps)) {
    const where = location(group[0]!);
    const texts = new Set(group.map((step) => step.text));
    const readings = [...texts].map((text) => readingOf.get(text)!);
    const patterns = new Set(readings.map((reading) => reading.pattern));
    const reading = readings[0]!;
    if (patterns.size > 1) {
      notes.push(
        `${where}: its Examples rows read as different patterns (${[...patterns].map((pattern) => JSON.stringify(pattern)).join(", ")}), so no stub was written; scaffold it with nuka scaffold <name> --pattern "<line with {key:type} captures>"`,
      );
      continue;
    }
    let pattern = reading.pattern;
    if (reading.kind === "literal") {
      notes.push(
        `${where}: "${group[0]!.text}" reads as ${reading.readings.map((source) => JSON.stringify(source)).join(" or ")}, so the stub's pattern is the line as written, with no capture; put a {key:type} capture in it by hand`,
      );
    } else if (stripCaptureNames(pattern).captures.length > 0) {
      // A line that reads as this same pattern shares the stub; any other
      // line it matches would match two steps.
      const other = projectLines.find(
        (line) => readingOf.get(line.text)?.pattern !== pattern && matches(pattern, line.text, registry),
      );
      if (other !== undefined) {
        if (texts.size > 1) {
          notes.push(
            `${where}: its pattern ${JSON.stringify(pattern)} would also match "${other.text}" (${other.where}), and its Examples rows have no single line to write instead, so no stub was written`,
          );
          continue;
        }
        pattern = literalPattern(group[0]!.text);
        notes.push(
          `${where}: ${JSON.stringify(reading.pattern)} would also match "${other.text}" (${other.where}), so the stub's pattern is the line as written, with no capture`,
        );
      }
    }
    const stub = planned.get(pattern) ?? { pattern, lines: [] };
    stub.lines.push(...group);
    planned.set(pattern, stub);
  }

  const stepExtension = isCommonJsProject(rootDir) ? ".mts" : ".ts";
  const stepsDir = path.join(config.featuresDir, "steps");
  const taken = new Set<string>(discovery.vocabulary.keys());
  const written: string[] = [];
  for (const stub of planned.values()) {
    const name = distinctName(
      stepNameFor(stub.pattern),
      (candidate) =>
        taken.has(candidate) ||
        STEP_EXTENSIONS.some((extension) => existsSync(path.join(rootDir, stepsDir, `${candidate}${extension}`))),
    );
    taken.add(name);
    const relativeFilePath = path.join(stepsDir, `${name}${stepExtension}`);
    const then = stub.lines.some((line) => line.type === PickleStepType.OUTCOME);
    await mkdir(path.join(rootDir, stepsDir), { recursive: true });
    await writeFile(
      path.join(rootDir, relativeFilePath),
      stepTemplate({
        name,
        pattern: stub.pattern,
        captures: stripCaptureNames(stub.pattern).captures,
        chained: [],
        variant: then ? "then" : "when",
        entryPoint: null,
        description: null,
        relativeFilePath: relativeFilePath.split(path.sep).join("/"),
      }),
    );
    written.push(relativeFilePath);
  }
  for (const filePath of written) stdout.write(`${filePath}\n`);
  for (const note of notes) stderr.write(`note: ${note}\n`);
  return 0;
}
