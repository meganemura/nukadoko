import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
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
import { discoverSteps, type TypedVocabularyEntry } from "../discover/discover-steps.js";
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
//
// `--from <step>.<key>` writes the chain to an earlier step: the import of
// the producer's file, an args field, the `from` entry, and the key in
// `run`'s destructuring. The args field is the producer's own schema for
// that key (`producer.returns.shape.key`) rather than a copy of it, so the
// two cannot drift apart and the producer's `.describe()` text reaches
// `nuka describe` for this step too. Scaffold reads the producer through
// discovery, the same as `nuka steps`, so a producer that does not return
// the key is refused here with the keys it does return, not later as a
// `from` finding in `nuka check`.

export interface RunScaffoldOptions {
  rootDir: string;
  name: string;
  /** The `--pattern` text, or `null` for a step called by name only. */
  pattern: string | null;
  then: boolean;
  /** Each `--from` value as typed, `<step>.<key>`, in order. */
  from: readonly string[];
  stdout: WritableSink;
  stderr: WritableSink;
}

const VALID_STEP_NAME = /^[a-z0-9-]+$/;

const ZOD_FOR_CLASS: ReadonlyMap<PrimitiveClass, string> = new Map([
  ["number", "z.number()"],
  ["string", "z.string()"],
  ["bigint", "z.bigint()"],
]);

/** One `--from` value, split. The key is the producer's `returns` key and
 * also the args key it fills. */
export interface FromRequest {
  readonly step: string;
  readonly key: string;
}

/** One `--from` resolved against the vocabulary: the identifier the
 * producer is imported as and the specifier it is imported from. */
interface ChainedField extends FromRequest {
  readonly identifier: string;
  readonly specifier: string;
}

interface StepTemplate {
  readonly name: string;
  readonly pattern: string | null;
  readonly captures: readonly Capture[];
  readonly chained: readonly ChainedField[];
  readonly then: boolean;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Words a binding may not take: neither an import nor a key destructured
// shorthand in `run`'s parameters.
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "eval", "export", "extends", "false", "finally", "for", "function", "if",
  "implements", "import", "in", "instanceof", "interface", "let", "new", "null", "package", "private",
  "protected", "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield",
]);

// An import also may not shadow the template's own imports.
const TAKEN_IDENTIFIERS: ReadonlySet<string> = new Set(["defineStep", "z", ...RESERVED_WORDS]);

/** `<step>.<key>`, or the reason it is not one. The key has to be an
 * identifier because the template destructures it in `run`'s parameters. */
export function parseFromFlag(text: string): FromRequest | { refusal: string } {
  const dot = text.indexOf(".");
  const step = dot === -1 ? "" : text.slice(0, dot);
  const key = dot === -1 ? "" : text.slice(dot + 1);
  if (!VALID_STEP_NAME.test(step) || !IDENTIFIER.test(key) || RESERVED_WORDS.has(key)) {
    return {
      refusal: `--from takes <step>.<key>, a step name and one identifier that is not a reserved word, and got ${JSON.stringify(text)}`,
    };
  }
  return { step, key };
}

/** The binding each producer step is imported as: its kebab-case name in
 * camelCase (`run-greet` is `runGreet`, as a person would write it), made
 * a legal identifier that does not shadow the template's own imports, and
 * distinct for distinct names. */
export function importIdentifiers(stepNames: readonly string[]): ReadonlyMap<string, string> {
  const identifiers = new Map<string, string>();
  const used = new Set<string>(TAKEN_IDENTIFIERS);
  for (const stepName of stepNames) {
    if (identifiers.has(stepName)) continue;
    const parts = stepName.split("-").filter((part) => part !== "");
    let base = parts.map((part, index) => (index === 0 ? part : part[0]!.toUpperCase() + part.slice(1))).join("");
    if (base === "" || /^[0-9]/.test(base)) base = `step${base[0]?.toUpperCase() ?? ""}${base.slice(1)}`;
    let identifier = TAKEN_IDENTIFIERS.has(base) ? `${base}Step` : base;
    for (let suffix = 2; used.has(identifier); suffix += 1) {
      identifier = `${base}${suffix}`;
    }
    used.add(identifier);
    identifiers.set(stepName, identifier);
  }
  return identifiers;
}

/** The relative specifier one step file imports another by. A `.ts` file
 * is imported as `.js` (and `.mts` as `.mjs`): that is the spelling both
 * `tsc` under NodeNext and the runtime discovery uses resolve, while a
 * `.ts` specifier needs a compiler option a project may not set. */
export function importSpecifier(fromDir: string, toFile: string): string {
  const relative = path.relative(fromDir, toFile).split(path.sep).join("/");
  const withDot = relative.startsWith(".") ? relative : `./${relative}`;
  return withDot.replace(/\.([mc]?)tsx?$/, ".$1js");
}

function argsLines(captures: readonly Capture[], chained: readonly ChainedField[]): string[] {
  if (captures.length === 0 && chained.length === 0) {
    return ["  args: z.object({}),"];
  }
  const fields = captures.map((capture) => {
    const captured = CAPTURED_CLASS.get(capture.type);
    const schema = (captured && ZOD_FOR_CLASS.get(captured)) ?? "z.unknown()";
    return `    ${capture.key}: ${schema},`;
  });
  const chainedFields = chained.map((field) => `    ${field.key}: ${field.identifier}.returns.shape.${field.key},`);
  return ["  args: z.object({", ...fields, ...chainedFields, "  }),"];
}

function fromLines(chained: readonly ChainedField[]): string[] {
  if (chained.length === 0) return [];
  return [
    "  from: {",
    ...chained.map((field) => `    ${field.key}: [${field.identifier}, ${JSON.stringify(field.key)}],`),
    "  },",
  ];
}

function importLines(chained: readonly ChainedField[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const field of chained) {
    if (seen.has(field.identifier)) continue;
    seen.add(field.identifier);
    lines.push(`import ${field.identifier} from ${JSON.stringify(field.specifier)};`);
  }
  return lines;
}

function stepTemplate({ name, pattern, captures, chained, then }: StepTemplate): string {
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
  const keys = [...captures.map((capture) => capture.key), ...chained.map((field) => field.key)];
  const runParameters = keys.length === 0 ? "" : `{}, { ${keys.join(", ")} }`;
  return [
    'import { defineStep, z } from "nukadoko";',
    ...importLines(chained),
    "",
    "export default defineStep({",
    `  description: "TODO: describe ${name}",`,
    ...patternLine,
    "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
    ...argsLines(captures, chained),
    ...fromLines(chained),
    ...outcomeLines,
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

/** The `--from` requests, or why they cannot all fill a distinct args key
 * beside the pattern's captures. */
function readFromFlags(
  texts: readonly string[],
  captures: readonly Capture[],
): { requests: readonly FromRequest[] } | { refusal: string } {
  const requests: FromRequest[] = [];
  const keys = new Set(captures.map((capture) => capture.key));
  for (const text of texts) {
    const request = parseFromFlag(text);
    if ("refusal" in request) return request;
    if (keys.has(request.key)) {
      return {
        refusal: `args key "${request.key}" is filled twice (a capture or another --from), and one args field holds one value`,
      };
    }
    keys.add(request.key);
    requests.push(request);
  }
  return { requests };
}

/** Resolves each request against the project's typed steps, or names the
 * first producer that cannot give the key. */
function resolveChain(
  requests: readonly FromRequest[],
  typedSteps: ReadonlyMap<string, TypedVocabularyEntry>,
  rootDir: string,
  stepDir: string,
  importFailureCount: number,
): { chained: readonly ChainedField[] } | { refusal: string } {
  const identifiers = importIdentifiers(requests.map((request) => request.step));
  const chained: ChainedField[] = [];
  for (const request of requests) {
    const producer = typedSteps.get(request.step);
    if (producer === undefined) {
      const unread =
        importFailureCount === 0 ? "" : `; ${importFailureCount} step file(s) did not import, and \`nuka check\` names them`;
      return { refusal: `no typed step is named "${request.step}" (\`nuka steps\` lists the vocabulary)${unread}` };
    }
    const returns = producer.step.returns as z.ZodTypeAny;
    if (returns.type !== "object") {
      return { refusal: `${request.step}'s returns is not a z.object, so it has no key to chain` };
    }
    const returnKeys = Object.keys((returns as z.ZodObject).shape);
    if (!returnKeys.includes(request.key)) {
      const named = returnKeys.length === 0 ? "it returns no keys" : `its keys are ${returnKeys.join(", ")}`;
      return { refusal: `${request.step} does not return "${request.key}"; ${named}` };
    }
    chained.push({
      ...request,
      identifier: identifiers.get(request.step)!,
      specifier: importSpecifier(stepDir, path.resolve(rootDir, producer.filePath)),
    });
  }
  return { chained };
}

export async function runScaffold(options: RunScaffoldOptions): Promise<number> {
  const { rootDir, name, pattern, then, from, stdout, stderr } = options;

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
  const fromFlags = readFromFlags(from, read.captures);
  if ("refusal" in fromFlags) {
    stderr.write(`Refusing to scaffold: ${fromFlags.refusal}\n`);
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

  let chained: readonly ChainedField[] = [];
  if (fromFlags.requests.length > 0) {
    // Tolerant, as `nuka check` is: an unrelated broken step file must not
    // stop a chain to a producer that loads.
    const { vocabulary, importFailures } = await discoverSteps(rootDir, config.featuresDir, {
      tolerateImportFailures: true,
    });
    const typedSteps = new Map<string, TypedVocabularyEntry>();
    for (const entry of vocabulary.values()) {
      if (entry.kind === "typed") typedSteps.set(entry.name, entry);
    }
    const resolved = resolveChain(
      fromFlags.requests,
      typedSteps,
      rootDir,
      path.dirname(filePath),
      importFailures.length,
    );
    if ("refusal" in resolved) {
      stderr.write(`Refusing to scaffold: ${resolved.refusal}\n`);
      return 1;
    }
    chained = resolved.chained;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stepTemplate({ name, pattern, captures: read.captures, chained, then }));

  stdout.write(`${relativeFilePath}\n`);
  return 0;
}
