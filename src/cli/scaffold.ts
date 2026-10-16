import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { loadConfig } from "../config/load-config.js";
import { isCommonJsProject } from "../config/module-kind.js";
import { UndefinedParameterTypeError } from "@cucumber/cucumber-expressions/dist/Errors.js";
import { duplicateCaptureKeys } from "../binding/capture.js";
import { buildExpression } from "../binding/expression.js";
import { type Capture, stripCaptureNames } from "../binding/pattern.js";
import { ParameterTypeCollisionError } from "../binding/parameter-type-errors.js";
import type { RegisteredParameterType } from "../binding/parameter-type-config.js";
import { createParameterTypeRegistry } from "../binding/registry.js";
import type { PrimitiveClass } from "../binding/schema-shape.js";
import { availableParameterTypeNames, CAPTURED_CLASS } from "../check/binding-check.js";
import { formatVocabularyError } from "./vocabulary.js";
import { commandTookTheName, VALID_STEP_NAME } from "./option-defaults.js";
import { DESCRIPTION_TODO_PREFIX } from "../tend/types.js";
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
// `--description` is written as the step's description, a JSON string
// literal like the pattern. Without it the description is
// `TODO: describe <name>`, which imports and runs, so `nuka tend` reports
// it (`step-description-todo`) by the same prefix; `--command` has a real
// sentence of its own instead, which `--description` replaces.
//
// The template keeps one comment line per lesson a first reader needs, not
// the lesson itself: `returns` carries the values a failure is diagnosed
// from, not only what later steps cite, and an absence (`false`, `0`) needs
// proof the read was valid beside it (docs/spec.md "Typed steps" has the
// reasoning). `run` (outside `--command`) always throws
// `not implemented: <name>`, so the step is discoverable (`nuka steps`) the moment it is scaffolded but fails every
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
// pattern that `nuka check` would refuse in this project is refused here
// instead, before a file exists: an unnamed or repeated capture, an
// unterminated `{`, a cucumber-expressions syntax error, and a type name
// the project does not register. The registry is the one `nuka check`
// builds, the built-ins plus `config.parameterTypes` plus each compat
// `defineParameterType` discovery finds, so a type the project does
// register is written as it is. Discovery imports every step file, so it
// runs only when the pattern names a type the built-ins lack. That refusal
// lists the registered names, and for `number`, the word a zod schema uses,
// names `int` and `float`, the Gherkin ones.
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
//
// `--command` is the When step of a command-line program, the step every
// CLI project writes first: it runs `process.execPath` on one entry point
// with the args as argv, in `scratch.dir()`, and returns `exitCode`,
// `stdout`, and `stderr`. Those three keys are written into `returns` so a
// Then step can be scaffolded `--from` it at once, with no hand edit in
// between. The entry point is the one thing scaffold cannot read from the
// project, so `--command <entry point>` takes it as a value and writes it
// into `resolve(...)` as a JSON string literal (JSON's escapes are valid
// JavaScript, so any path reads back as itself). Without a value the line
// holds a TODO, and `run` throws `fill in the entry point: <file>:<line>`
// while it does. Without that guard, Node would be asked to run a path that
// does not exist: `runCommand` rightly treats a nonzero exit as a result,
// so the When step passed and the cause surfaced only as an empty `stdout`
// in the next step. The placeholder is not a program under test, so it
// fails by name instead. A value is the same trap with a typo in it, so
// scaffold refuses one that does not name a regular file under the
// directory `nuka` runs in (a directory, a missing path) before a file is
// written: this is the one place that sees the value before it is quoted
// into source, and the question ends only one way here. A step name as
// the value, with `--command` before the positional, is how the parser
// reads a name typed right after the flag (`--command run-y --pattern
// ...`), so that refusal names the option order too. `--command` and
// `--then` are refused together, because a step that runs a program
// changes state and a Then step declares that it does not.
//
// A stub's thrown message names its args, so a project that compiles with
// `noUnusedParameters` accepts the file as written, and the first failed
// run shows what the feature line bound. An args key that would shadow a
// name the body reads (`JSON`, `cli`, ...) is refused, because the file
// would not compile.

export interface RunScaffoldOptions {
  rootDir: string;
  name: string;
  /** The `--pattern` text, or `null` for a step called by name only. */
  pattern: string | null;
  then: boolean;
  /** `--command`: run a program and return its exit code and output. */
  command: boolean;
  /** `--command`'s value, the entry point the step runs, or `null` to
   * leave the TODO line that `run` refuses until it is filled in. */
  entryPoint: string | null;
  /** Whether `--command` came before the name on the command line, which
   * is how a name ends up as its value. */
  commandBeforeName: boolean;
  /** `--description`, or `null` for the TODO `nuka tend` reports (or,
   * with `--command`, the sentence that describes running the program). */
  description: string | null;
  /** Each `--from` value as typed, `<step>.<key>`, in order. */
  from: readonly string[];
  stdout: WritableSink;
  stderr: WritableSink;
}

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
 * producer is imported as, the specifier it is imported from, and the
 * class of the value the producer's schema holds. */
interface ChainedField extends FromRequest {
  readonly identifier: string;
  readonly specifier: string;
  readonly valueClass: PrimitiveClass;
}

/** What the step is for, which decides its outcome and its body. */
type Variant = "when" | "then" | "command";

interface VariantShape {
  /** Names the written `run` reads, so no args key may take them. */
  readonly bodyNames: ReadonlySet<string>;
  /** Module-level bindings the template declares, beside `defineStep` and `z`. */
  readonly moduleNames: ReadonlySet<string>;
}

const STUB_BODY_NAMES: ReadonlySet<string> = new Set(["Error", "JSON", "String"]);

const VARIANTS: Readonly<Record<Variant, VariantShape>> = {
  when: { bodyNames: STUB_BODY_NAMES, moduleNames: new Set() },
  then: { bodyNames: STUB_BODY_NAMES, moduleNames: new Set() },
  command: {
    bodyNames: new Set(["cli", "runCommand", "process", "scratch", "String"]),
    // `process` is a global the body reads, so an import may not shadow it either.
    moduleNames: new Set(["cli", "runCommand", "resolve", "process"]),
  },
};

/** One args field: its key and the class of the value it holds. */
interface Field {
  readonly key: string;
  readonly valueClass: PrimitiveClass;
}

interface StepTemplate {
  readonly name: string;
  readonly pattern: string | null;
  readonly captures: readonly Capture[];
  readonly chained: readonly ChainedField[];
  readonly variant: Variant;
  readonly entryPoint: string | null;
  readonly description: string | null;
  /** The written file, relative to the project root, as the guard names it. */
  readonly relativeFilePath: string;
}

/** The text `cli` holds until someone names the entry point. */
const ENTRY_POINT_PLACEHOLDER = "<TODO: the entry point>";

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
export function importIdentifiers(
  stepNames: readonly string[],
  moduleNames: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, string> {
  const taken = new Set<string>([...TAKEN_IDENTIFIERS, ...moduleNames]);
  const identifiers = new Map<string, string>();
  const used = new Set<string>(taken);
  for (const stepName of stepNames) {
    if (identifiers.has(stepName)) continue;
    const parts = stepName.split("-").filter((part) => part !== "");
    let base = parts.map((part, index) => (index === 0 ? part : part[0]!.toUpperCase() + part.slice(1))).join("");
    if (base === "" || /^[0-9]/.test(base)) base = `step${base[0]?.toUpperCase() ?? ""}${base.slice(1)}`;
    let identifier = taken.has(base) ? `${base}Step` : base;
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

function fieldsOf(captures: readonly Capture[], chained: readonly ChainedField[]): Field[] {
  return [
    ...captures.map((capture) => ({ key: capture.key, valueClass: CAPTURED_CLASS.get(capture.type) ?? "other" })),
    ...chained.map(({ key, valueClass }) => ({ key, valueClass })),
  ];
}

/** The stub's body: it throws, naming the step and the args it was given.
 * A bigint (or a value of unknown class, which may be one) has no JSON
 * form, so a replacer writes it as text only when a field may hold one. */
function stubBody(name: string, fields: readonly Field[]): string {
  if (fields.length === 0) return `    throw new Error(${JSON.stringify(`not implemented: ${name}`)});`;
  const mayHoldBigint = fields.some((field) => field.valueClass === "bigint" || field.valueClass === "other");
  const replacer = mayHoldBigint ? ', (_key, value) => (typeof value === "bigint" ? String(value) : value)' : "";
  const keys = fields.map((field) => field.key).join(", ");
  return `    throw new Error(\`not implemented: ${name}; args \${JSON.stringify({ ${keys} }${replacer})}\`);`;
}

/** One argv element per field, in order: a string as it is, anything else
 * as its text. */
function commandArgv(fields: readonly Field[]): string {
  return ["cli", ...fields.map((field) => (field.valueClass === "string" ? field.key : `String(${field.key})`))].join(", ");
}

function stepTemplate({ name, pattern, captures, chained, variant, entryPoint, description, relativeFilePath }: StepTemplate): string {
  const fields = fieldsOf(captures, chained);
  const keys = fields.map((field) => field.key);
  const argsParameter = keys.length === 0 ? "" : `{ ${keys.join(", ")} }`;
  const patternLine =
    pattern === null
      ? ['  // pattern: "the feature line this step matches", (without one, the step is called by name only)']
      : [`  pattern: ${JSON.stringify(pattern)},`];
  const command = variant === "command";
  const headerLines = command
    ? [
        'import { defineStep, runCommand, z } from "nukadoko";',
        'import { resolve } from "node:path";',
        ...importLines(chained),
        "",
        `const cli = resolve(${JSON.stringify(entryPoint ?? ENTRY_POINT_PLACEHOLDER)});`,
      ]
    : ['import { defineStep, z } from "nukadoko";', ...importLines(chained)];
  // The `cli` line is the last header line, so its 1-based number is the header's length.
  const placeholderGuard =
    command && entryPoint === null
      ? [
          `    if (cli.includes(${JSON.stringify(ENTRY_POINT_PLACEHOLDER)})) throw new Error(${JSON.stringify(
            `fill in the entry point: ${relativeFilePath}:${headerLines.length}`,
          )});`,
        ]
      : [];
  const describedAs =
    description ??
    (command ? "Run the command under test in an empty scratch directory" : `${DESCRIPTION_TODO_PREFIX} ${name}`);
  const outcomeLines =
    variant === "then"
      ? ["  mutates: false,"]
      : variant === "command"
        ? [
            "  returns: z.object({",
            "    exitCode: z.number().nullable(),",
            "    stdout: z.string(),",
            "    stderr: z.string(),",
            "  }),",
          ]
        : [
            "  // Return what later steps cite and the values this step's correctness rests on;",
            '  // beside an absence (false, 0, ""), return proof the read was valid.',
            "  returns: z.object({}),",
          ];
  const runLines = command
    ? [
        `  async run({ scratch }${argsParameter === "" ? "" : `, ${argsParameter}`}) {`,
        ...placeholderGuard,
        `    return await runCommand(process.execPath, [${commandArgv(fields)}], { cwd: scratch.dir() });`,
      ]
    : [`  run(${argsParameter === "" ? "" : `{}, ${argsParameter}`}) {`, stubBody(name, fields)];
  return [
    ...headerLines,
    "",
    "export default defineStep({",
    `  description: ${JSON.stringify(describedAs)},`,
    ...patternLine,
    "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
    ...argsLines(captures, chained),
    ...fromLines(chained),
    ...outcomeLines,
    ...runLines,
    "  },",
    "});",
    "",
  ].join("\n");
}

/** What the pattern captures, read against the built-in types alone, or
 * the reason `nuka check` would refuse it in any project. `projectTypes`
 * holds each type name the built-ins lack, which only the project's own
 * registry can settle. */
interface ReadPattern {
  readonly captures: readonly Capture[];
  readonly projectTypes: readonly string[];
}

function readPattern(pattern: string): ReadPattern | { refusal: string } {
  if (pattern === "") {
    // defineStep reads an empty `pattern` as no pattern at all, so the step
    // would quietly match no feature line.
    return { refusal: "the pattern is empty" };
  }
  const builtins = createParameterTypeRegistry();
  let captures: readonly Capture[];
  try {
    captures = buildExpression(pattern, builtins).captures;
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
  const projectTypes = [
    ...new Set(captures.map((capture) => capture.type).filter((type) => builtins.lookupByTypeName(type) === undefined)),
  ];
  return { captures, projectTypes };
}

/** Why the pattern names a type this project does not register, or `null`
 * when every type it names is registered. */
function projectTypeRefusal(
  pattern: string,
  captures: readonly Capture[],
  registeredTypes: readonly RegisteredParameterType[],
  importFailureCount: number,
): string | null {
  let registry: ReturnType<typeof createParameterTypeRegistry>;
  try {
    registry = createParameterTypeRegistry(registeredTypes);
  } catch (error) {
    // The project's registry itself is broken; `nuka check` reports it as
    // parameter-type-invalid, with the same message.
    if (error instanceof ParameterTypeCollisionError) return error.message;
    throw error;
  }
  try {
    buildExpression(pattern, registry);
    return null;
  } catch (error) {
    if (!(error instanceof UndefinedParameterTypeError)) throw error;
    const type = error.undefinedParameterTypeName;
    const key = captures.find((capture) => capture.type === type)?.key ?? "value";
    const hint = type === "number" ? `; did you mean {${key}:int} or {${key}:float}?` : "";
    const unread =
      importFailureCount === 0 ? "" : `; ${importFailureCount} step file(s) did not import, and \`nuka check\` names them`;
    return `the pattern names type ${JSON.stringify(type)}, and this project registers none by that name; registered types: ${availableParameterTypeNames(registry).join(", ")}${hint}${unread}`;
  }
}

/** The `--from` requests, or why they cannot all fill a distinct args key
 * beside the pattern's captures, one the step body does not read. */
function readFromFlags(
  texts: readonly string[],
  captures: readonly Capture[],
  bodyNames: ReadonlySet<string>,
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
  const shadowing = [...keys].filter((key) => bodyNames.has(key));
  if (shadowing.length > 0) {
    return {
      refusal: `args key ${shadowing.map((key) => `"${key}"`).join(", ")} would hide a name the written step body reads (${[...bodyNames].join(", ")}); name the capture or the key something else`,
    };
  }
  return { requests };
}

/** The class of a chained value, read from the producer's schema itself:
 * an optional or nullable string may hold no string at all, so only a bare
 * `z.string()` or `z.number()` counts as one, and anything else is passed
 * through `String()` and the stub's bigint replacer. */
function chainedClass(schema: z.ZodTypeAny): PrimitiveClass {
  return schema.type === "string" || schema.type === "number" ? schema.type : "other";
}

/** Resolves each request against the project's typed steps, or names the
 * first producer that cannot give the key. */
function resolveChain(
  requests: readonly FromRequest[],
  typedSteps: ReadonlyMap<string, TypedVocabularyEntry>,
  rootDir: string,
  stepDir: string,
  importFailureCount: number,
  moduleNames: ReadonlySet<string>,
): { chained: readonly ChainedField[] } | { refusal: string } {
  const identifiers = importIdentifiers(requests.map((request) => request.step), moduleNames);
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
    const shape = (returns as z.ZodObject).shape;
    const returnKeys = Object.keys(shape);
    if (!returnKeys.includes(request.key)) {
      const named = returnKeys.length === 0 ? "it returns no keys" : `its keys are ${returnKeys.join(", ")}`;
      return { refusal: `${request.step} does not return "${request.key}"; ${named}` };
    }
    chained.push({
      ...request,
      identifier: identifiers.get(request.step)!,
      specifier: importSpecifier(stepDir, path.resolve(rootDir, producer.filePath)),
      valueClass: chainedClass(shape[request.key] as z.ZodTypeAny),
    });
  }
  return { chained };
}

/** Why `--command`'s value cannot be the program the step runs, or `null`
 * when it names a regular file. */
async function entryPointRefusal(rootDir: string, entryPoint: string, commandBeforeName: boolean): Promise<string | null> {
  const resolved = path.resolve(rootDir, entryPoint);
  const isFile = await stat(resolved).then(
    (stats) => stats.isFile(),
    () => false,
  );
  if (isFile) return null;
  const order = commandBeforeName && VALID_STEP_NAME.test(entryPoint) ? `; ${commandTookTheName(entryPoint)}` : "";
  return `entry point ${JSON.stringify(entryPoint)} is not a file (looked at ${resolved}); pass the path of the program the step runs, relative to the directory nuka runs in, or give --command no value to leave a TODO${order}`;
}

/** The relative `.js`, `.mjs`, and `.cjs` specifiers a TypeScript source
 * loads statically, in source order. A whole-statement `import type` or
 * `export type` is left out: Node's type stripping erases it, so it loads
 * nothing. Only a statement that starts its line is read, so an import
 * spelled inside a string is not; a dynamic `import()` is not read either,
 * and comments are dropped first. What is missed is never claimed. */
export function relativeJsImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const statement =
    /^[ \t]*(?:import|export)\s+(?!type\s+(?!from\b)[\w${*])(?:[^;'"]*?\bfrom\s*)?(["'])(\.{1,2}\/[^"'\r\n]*\.[mc]?js)\1/gm;
  return [...code.matchAll(statement)].map((match) => match[2]!);
}

/** Why a TypeScript entry point cannot start under plain `node`, or `null`.
 * Node runs a `.ts` file by stripping its types and does not rewrite a
 * `./greet.js` specifier to the `./greet.ts` beside it, so the program exits
 * with ERR_MODULE_NOT_FOUND before it runs. Only the entry file's own imports
 * are read, and only a `.js` target that is absent while its TypeScript
 * sibling is present is claimed: anything else may still resolve. */
async function unloadableImportRefusal(rootDir: string, entryPoint: string): Promise<string | null> {
  const resolved = path.resolve(rootDir, entryPoint);
  if (!/\.[mc]?ts$/.test(resolved)) return null;
  // An unreadable file is not claimed: the step may run under other permissions.
  const source = await readFile(resolved, "utf8").catch(() => "");
  for (const specifier of relativeJsImports(source)) {
    const target = path.resolve(path.dirname(resolved), specifier);
    if (existsSync(target)) continue;
    const sibling = target.replace(/js$/, "ts");
    if (!existsSync(sibling)) continue;
    const siblingName = path.relative(rootDir, sibling).split(path.sep).join("/");
    const tsSpecifier = specifier.replace(/js$/, "ts");
    return `entry point ${JSON.stringify(entryPoint)} imports ${JSON.stringify(specifier)}, which does not exist (${siblingName} does); node runs a .ts file without rewriting that specifier, so the step would exit 1 with ERR_MODULE_NOT_FOUND. Point --command at the built program (for example dist/cli.js, after npm run build), or import ${JSON.stringify(tsSpecifier)} with "rewriteRelativeImportExtensions": true in tsconfig.json`;
  }
  return null;
}

export async function runScaffold(options: RunScaffoldOptions): Promise<number> {
  const { rootDir, name, pattern, then, command, entryPoint, description, from, stdout, stderr } = options;

  if (!VALID_STEP_NAME.test(name)) {
    stderr.write(
      `Invalid step name "${name}": must match [a-z0-9-]+ (kebab-case; it becomes the step's file name)\n`,
    );
    return 1;
  }

  if (command && then) {
    stderr.write(
      "Refusing to scaffold: --command and --then together; a step that runs a program changes state, and a Then step declares mutates: false\n",
    );
    return 1;
  }
  const variant: Variant = command ? "command" : then ? "then" : "when";
  const variantShape = VARIANTS[variant];
  // The placeholder guard throws an `Error`, so an args key may not hide it.
  const shape: VariantShape =
    command && entryPoint === null
      ? { ...variantShape, bodyNames: new Set([...variantShape.bodyNames, "Error"]) }
      : variantShape;

  if (description === "") {
    stderr.write(
      "Refusing to scaffold: --description is empty; say what the step does, or leave the flag out for a TODO that nuka tend reports\n",
    );
    return 1;
  }

  if (entryPoint !== null) {
    const refusal =
      (await entryPointRefusal(rootDir, entryPoint, options.commandBeforeName)) ??
      (await unloadableImportRefusal(rootDir, entryPoint));
    if (refusal !== null) {
      stderr.write(`Refusing to scaffold: ${refusal}\n`);
      return 1;
    }
  }

  const read: ReadPattern | { refusal: string } = pattern === null ? { captures: [], projectTypes: [] } : readPattern(pattern);
  if ("refusal" in read) {
    stderr.write(`Refusing to scaffold: ${read.refusal}\n`);
    return 1;
  }
  const fromFlags = readFromFlags(from, read.captures, shape.bodyNames);
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
  if (fromFlags.requests.length > 0 || read.projectTypes.length > 0) {
    // Tolerant, as `nuka check` is: an unrelated broken step file must not
    // stop a chain to a producer that loads.
    const { vocabulary, importFailures, compatParameterTypes } = await discoverSteps(rootDir, config.featuresDir, {
      tolerateImportFailures: true,
    });
    if (read.projectTypes.length > 0 && pattern !== null) {
      const refusal = projectTypeRefusal(
        pattern,
        read.captures,
        [...config.parameterTypes, ...compatParameterTypes],
        importFailures.length,
      );
      if (refusal !== null) {
        stderr.write(`Refusing to scaffold: ${refusal}\n`);
        return 1;
      }
    }
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
      shape.moduleNames,
    );
    if ("refusal" in resolved) {
      stderr.write(`Refusing to scaffold: ${resolved.refusal}\n`);
      return 1;
    }
    chained = resolved.chained;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    stepTemplate({
      name,
      pattern,
      captures: read.captures,
      chained,
      variant,
      entryPoint,
      description,
      relativeFilePath: relativeFilePath.split(path.sep).join("/"),
    }),
  );

  stdout.write(`${relativeFilePath}\n`);
  return 0;
}
