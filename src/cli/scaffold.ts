import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { isCommonJsProject } from "../config/module-kind.js";
import { UndefinedParameterTypeError } from "@cucumber/cucumber-expressions/dist/Errors.js";
import { duplicateCaptureKeys } from "../binding/capture.js";
import { buildExpression } from "../binding/expression.js";
import { type Capture, stripCaptureNames } from "../binding/pattern.js";
import { createParameterTypeRegistry } from "../binding/registry.js";
import type { PrimitiveClass } from "../binding/schema-shape.js";
import { CAPTURED_CLASS } from "../check/binding-check.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka scaffold <name>`'s actual work, kept out of
// run-cli.ts so it's unit-testable without going
// through yargs (same split as cli/do.ts and cli/init.ts). Unlike `init`,
// this command assumes a project already exists: it needs `featuresDir` from
// a successfully loaded config, so a load
// failure here is reported exactly like any other command that loads config
// (cli/vocabulary.ts's `formatVocabularyError`), not a scaffold-specific
// error.
//
// `name` becomes the generated file's name, so it is restricted to
// `[a-z0-9-]+` (kebab-case — the existing "1 step = 1 file, file name is the
// step name" convention from docs/spec.md "Typed steps"), checked before
// anything else so an invalid name never reaches the filesystem. An
// existing file at the target path is refused rather than overwritten: a
// step that already has a real implementation must never be silently
// replaced by this template.
//
// The template keeps one comment line per lesson a first reader needs, not
// the lesson itself: `returns` carries the values a failure is diagnosed
// from, not only what later steps cite, and an absence (`false`, `0`) needs
// proof the read was valid beside it (docs/spec.md "Typed steps" has the
// reasoning). `run` always throws `not implemented: <name>`, so the step is
// discoverable (`nuka steps`) the moment it is scaffolded but fails every
// `nuka do`/`nuka run` call until someone replaces the body: "fails until
// implemented" (docs/spec.md "CLI summary"), enforced by the template
// itself rather than by a separate check.
//
// `--pattern` writes the pattern and one args field per `{key:type}`
// capture, so the file passes `nuka check` against a feature line as
// written: a capture with no args key, or a key nothing fills, is a check
// error. A built-in type gets the schema of the value it produces (the same
// table `nuka check` compares captures against); a custom type gets
// `z.unknown()`, because only its transformer knows what it produces. A
// pattern that `nuka check` would refuse whatever the project declares
// (an unnamed or repeated capture, an unterminated `{`, a
// cucumber-expressions syntax error) is refused here instead, before a file
// exists. An unknown type name is not refused: it may be a custom type the
// project registers, and only `nuka check` sees the whole registry.
//
// `--then` is for an assertion step. It writes `mutates: false`, which a
// step bound to a Then line must declare (`then-mutates`), and no `returns`,
// so the body can throw on a failed assertion and otherwise return nothing.
// It is a flag rather than a default because whether a step changes state
// is the author's declaration: nukadoko does not guess it.

export interface RunScaffoldOptions {
  rootDir: string;
  name: string;
  /** The `--pattern` text, or `null` for a step called by name only. */
  pattern: string | null;
  then: boolean;
  stdout: WritableSink;
  stderr: WritableSink;
}

const VALID_STEP_NAME = /^[a-z0-9-]+$/;

const ZOD_FOR_CLASS: ReadonlyMap<PrimitiveClass, string> = new Map([
  ["number", "z.number()"],
  ["string", "z.string()"],
  ["bigint", "z.bigint()"],
]);

interface StepTemplate {
  readonly name: string;
  readonly pattern: string | null;
  readonly captures: readonly Capture[];
  readonly then: boolean;
}

function argsLines(captures: readonly Capture[]): string[] {
  if (captures.length === 0) {
    return ["  args: z.object({}),"];
  }
  const fields = captures.map((capture) => {
    const captured = CAPTURED_CLASS.get(capture.type);
    const schema = (captured && ZOD_FOR_CLASS.get(captured)) ?? "z.unknown()";
    return `    ${capture.key}: ${schema},`;
  });
  return ["  args: z.object({", ...fields, "  }),"];
}

function stepTemplate({ name, pattern, captures, then }: StepTemplate): string {
  const patternLine =
    pattern === null
      ? ['  // pattern: "the feature line this step matches", (without one, the step is called by name only)']
      : [`  pattern: ${JSON.stringify(pattern)},`];
  const outcomeLines = then
    ? ["  mutates: false,"]
    : [
        "  // Return what later steps cite and the values this step's correctness rests on;",
        '  // beside an absence (false, 0, ""), return proof the read was valid.',
        "  returns: z.object({}),",
      ];
  const runParameters = captures.length === 0 ? "" : `{}, { ${captures.map((capture) => capture.key).join(", ")} }`;
  return [
    'import { defineStep, z } from "nukadoko";',
    "",
    "export default defineStep({",
    `  description: "TODO: describe ${name}",`,
    ...patternLine,
    "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
    ...argsLines(captures),
    ...outcomeLines,
    "  // Why this shape, and what was rejected. `nuka tend` reports step-rationale-missing without it.",
    '  // rationale: "",',
    `  run(${runParameters}) {`,
    `    throw new Error("not implemented: ${name}");`,
    "  },",
    "});",
    "",
  ].join("\n");
}

/** The pattern's captures, or the reason `nuka check` would refuse it in
 * any project. */
function readPattern(pattern: string): { captures: readonly Capture[] } | { refusal: string } {
  if (pattern === "") {
    // defineStep reads an empty `pattern` as no pattern at all, so the step
    // would quietly match no feature line.
    return { refusal: "the pattern is empty" };
  }
  let captures: readonly Capture[];
  try {
    captures = buildExpression(pattern, createParameterTypeRegistry()).captures;
  } catch (error) {
    if (!(error instanceof UndefinedParameterTypeError)) {
      return { refusal: error instanceof Error ? error.message : String(error) };
    }
    captures = stripCaptureNames(pattern).captures;
  }
  const repeated = duplicateCaptureKeys(captures);
  if (repeated.length > 0) {
    return { refusal: `the pattern captures ${repeated.map((key) => `"${key}"`).join(", ")} more than once, and one args field holds one value` };
  }
  return { captures };
}

export async function runScaffold(options: RunScaffoldOptions): Promise<number> {
  const { rootDir, name, pattern, then, stdout, stderr } = options;

  if (!VALID_STEP_NAME.test(name)) {
    stderr.write(
      `Invalid step name "${name}": must match [a-z0-9-]+ (kebab-case; it becomes the step's file name)\n`,
    );
    return 1;
  }

  const read = pattern === null ? { captures: [] } : readPattern(pattern);
  if ("refusal" in read) {
    stderr.write(`Refusing to scaffold: ${read.refusal}\n`);
    return 1;
  }

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  // The same `isCommonJsProject` call `nuka init` already defers to
  // (src/config/module-kind.ts's own header): a project with no
  // "type": "module" in package.json reads a plain .ts file as CommonJS,
  // and nukadoko is ESM-only, so a step file scaffolded there has to be
  // .mts or `nuka check` immediately flags the very file this command just
  // wrote.
  const stepExtension = isCommonJsProject(rootDir) ? ".mts" : ".ts";
  const relativeFilePath = path.join(config.featuresDir, "steps", `${name}${stepExtension}`);
  const filePath = path.join(rootDir, relativeFilePath);

  if (existsSync(filePath)) {
    stderr.write(`Refusing to scaffold: ${relativeFilePath} already exists\n`);
    return 1;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stepTemplate({ name, pattern, captures: read.captures, then }));

  stdout.write(`${relativeFilePath}\n`);
  return 0;
}
