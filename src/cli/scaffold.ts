import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config/load-config.js";
import { locateConfig, noConfigLine, scaffoldParentRefusal } from "../config/config-presence.js";
import { isCommonJsProject } from "../config/module-kind.js";
import { UndefinedParameterTypeError } from "@cucumber/cucumber-expressions/dist/Errors.js";
import { duplicateCaptureKeys } from "../binding/capture.js";
import { buildExpression } from "../binding/expression.js";
import { type Capture, stripCaptureNames } from "../binding/pattern.js";
import { ParameterTypeCollisionError } from "../binding/parameter-type-errors.js";
import type { RegisteredParameterType } from "../binding/parameter-type-config.js";
import { createParameterTypeRegistry } from "../binding/registry.js";
import { loadFeaturesFromDirs } from "../feature/load-features.js";
import type { PrimitiveClass } from "../binding/schema-shape.js";
import { availableParameterTypeNames, CAPTURED_CLASS } from "../check/binding-check.js";
import { formatFinding } from "../finding/finding.js";
import { configMissingFinding, refuse, type RefusalSinks } from "./refusal.js";
import { commandTookTheName, VALID_STEP_NAME } from "./option-defaults.js";
import { DESCRIPTION_TODO_PREFIX } from "../tend/types.js";
import { discoverSteps, type TypedVocabularyEntry } from "../discover/discover-steps.js";
import { tsExtensionImports, type TsExtensionImports } from "./tsconfig-edit.js";
import { declaresReturns } from "../step/define-step.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { shellWord } from "../shell/shell-word.js";

// Responsibility: `nuka scaffold <name>`'s actual work, kept out of
// run-cli.ts so it's unit-testable without going
// through yargs (same split as cli/do.ts and cli/init.ts). Unlike `init`,
// this command assumes a project already exists: it needs `featuresDir` from
// a successfully loaded config, so a load
// failure here is reported exactly like any other command that loads config
// (a refusal through cli/refusal.ts), not a scaffold-specific
// error.
//
// `name` becomes the generated file's name, so it is restricted to
// `[a-z0-9-]+` (kebab-case — the existing "1 step = 1 file, file name is the
// step name" convention from docs/spec.md "Typed steps"), checked before
// anything else so an invalid name never reaches the filesystem. An
// existing file at the target path is refused rather than overwritten: a
// step that already has a real implementation must never be silently
// replaced by this template. `--replace` overwrites one kind of file only:
// one this template writes today, byte for byte, under some set of
// options, which holds nothing a scaffold run could not write again. That
// covers the stub `--feature` writes, which a newcomer redoes as a
// `--command` or `--from` step, and a step scaffolded with one option
// wrong; without the flag each one cost an `rm` first.
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
// reasoning). `run` (outside `--command` and a one-capture `--then`) throws
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
// With one capture, the expected value, the body is an assertion rather
// than the stub: `node:assert/strict` (a CLI or API project has no
// Playwright `expect` installed) compares `actual` against it, with a
// message that names both, because a failed step keeps no `result` and
// its message is where the observed value survives. `actual` is the one
// `--from` value, or `undefined` under a TODO until someone reads it, so
// the step still fails until it is implemented. More captures or more
// chained values leave which one is expected to the author, so they keep
// the stub.
//
// `--from <step>.<key>` writes the chain to an earlier step: the import of
// the producer's file, an args field, the `from` entry, and the key in
// `run`'s destructuring. The args field is the producer's own schema for
// that key (`producer.returns.shape.key`) rather than a copy of it, so the
// two cannot drift apart and the producer's `.describe()` text reaches
// `nuka describe` for this step too. Scaffold reads the producer through
// discovery, the same as `nuka steps`, so a producer that does not return
// the key is refused here with the keys it does return, not later as a
// `from` finding in `nuka check`. Several `--from` for one key write one
// `from` entry with every producer as a candidate, since the binding-order
// check already decides, per scenario, which one ran. The args field holds
// one type, so the producers have to declare the same JSON Schema for the
// key (descriptions aside); the field reads the first one's schema.
//
// `--command` is the When step of a command-line program, the step every
// CLI project writes first: it runs `process.execPath` on one entry point
// with the pattern's captures as argv, in `scratch.dir()`, and returns `exitCode`,
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
// `--cwd <key>` runs the program in the directory an args key holds rather
// than in a new `scratch.dir()`, which is empty by construction: a file a
// Given step wrote lives in the directory that Given returned, so the
// program never saw it. The key leaves argv, and its value has to be a
// bare string, the one type `runCommand`'s `cwd` takes.
//
// `--argv <key>` spreads one string capture into argv, split on whitespace
// alone, so one feature line carries every flag. A quoting rule would need
// a shell-words parser, which is a dependency. A `--command` step writes
// `mutates: true`, the default it would get anyway, because whether the
// program writes outside scratch is the author's declaration, and a line
// left out is a decision nobody sees.
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
  /** `--cwd`: the args key whose value is `--command`'s working
   * directory, or `null` for a new `scratch.dir()`. */
  cwd: string | null;
  /** `--argv`: the string capture `--command` splits on whitespace into
   * argv elements, or `null` to pass each capture as one element. */
  argvKey: string | null;
  /** `--request`'s value, `<METHOD> <path>`, for a When step that sends
   * one request through Playwright's `request`, or `null`. */
  request: string | null;
  /** `--body`: the args key `--request` sends as the request's data. */
  bodyKey: string | null;
  /** `--replace`: overwrite the target file while it still holds the
   * unedited stub `--feature` (or scaffold without options) wrote. */
  replace: boolean;
  /** The words typed after `nuka`, so a refusal the project has to be
   * changed for can name this same command as the one to run after. */
  argv: readonly string[];
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

/** One producer of a chained key: the identifier it is imported as and
 * the specifier it is imported from. */
export interface Producer {
  readonly step: string;
  readonly identifier: string;
  readonly specifier: string;
}

/** One args key filled through `from`: every `--from` that names it, in
 * the order given, and the class of the value their schemas hold. */
export interface ChainedField {
  readonly key: string;
  readonly producers: readonly [Producer, ...Producer[]];
  readonly valueClass: PrimitiveClass;
}

/** What the step is for, which decides its outcome and its body. */
export type Variant = "when" | "then" | "command" | "request";

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
  // `request` is destructured beside the args, so an args key may not take it either.
  request: { bodyNames: new Set(["request", "response"]), moduleNames: new Set() },
  command: {
    bodyNames: new Set(["cli", "runCommand", "process", "scratch", "String"]),
    // `process` is a global the body reads, so an import may not shadow it either.
    moduleNames: new Set(["cli", "runCommand", "resolve", "process"]),
  },
};

// The assertion body reads these, so no args key may take them and no
// import may shadow `assert`.
const ASSERT_BODY_NAMES: readonly string[] = ["assert", "actual"];

/** Whether a Then step's body asserts, rather than throwing the stub. */
function assertsInBody(variant: Variant, captureCount: number, chainedCount: number): boolean {
  return variant === "then" && captureCount === 1 && chainedCount <= 1;
}

/** One args field: its key and the class of the value it holds. */
interface Field {
  readonly key: string;
  readonly valueClass: PrimitiveClass;
}

export interface StepTemplate {
  readonly name: string;
  readonly pattern: string | null;
  readonly captures: readonly Capture[];
  readonly chained: readonly ChainedField[];
  readonly variant: Variant;
  readonly entryPoint: string | null;
  readonly cwd: string | null;
  /** The capture `--command` splits on whitespace into argv, if any. */
  readonly argvKey?: string | null;
  readonly description: string | null;
  /** The written file, relative to the project root, as the guard names it. */
  readonly relativeFilePath: string;
  /** The docstring or table the feature line carries, when the stub is read from one. */
  readonly attachment?: Attachment | null;
  /** What a `request` step sends. */
  readonly request?: RequestShape | null;
  /** The args key a `request` step sends as its data. */
  readonly bodyKey?: string | null;
}

/** One piece of a `--request` path: text sent as it is, or an args key
 * whose value is put in its place. */
export type PathSegment = { readonly text: string } | { readonly key: string };

/** `--request <METHOD> <path>`, read. */
export interface RequestShape {
  readonly method: string;
  readonly path: readonly PathSegment[];
}

/** `<METHOD> <path>`, or the reason it is not one. A `{key}` in the path
 * names an args key; any other brace is refused, so the written path
 * never holds a brace the author meant as text and got as a key. */
export function parseRequestFlag(text: string): RequestShape | { refusal: string } {
  const refusal = {
    refusal: `--request takes "<METHOD> <path>", an upper-case method and a path with no space, each {key} in it an args key, such as "GET /items/{id}", and got ${JSON.stringify(text)}`,
  };
  const parts = /^([A-Z]+) (\S+)$/.exec(text);
  if (parts === null) return refusal;
  const path: PathSegment[] = [];
  const piece = /\{([A-Za-z_$][A-Za-z0-9_$]*)\}|([^{}]+)/gy;
  let consumed = 0;
  for (const match of parts[2]!.matchAll(piece)) {
    consumed += match[0].length;
    path.push(match[1] !== undefined ? { key: match[1] } : { text: match[2]! });
  }
  if (consumed !== parts[2]!.length) return refusal;
  return { method: parts[1]!, path };
}

/** The path as a JavaScript expression: a string literal, or a template
 * literal with each key in its place, the value inserted as it is. */
export function requestPathExpression(path: readonly PathSegment[]): string {
  if (path.every((segment) => "text" in segment)) return JSON.stringify(path.map((segment) => ("text" in segment ? segment.text : "")).join(""));
  const body = path
    .map((segment) => ("key" in segment ? `\${${segment.key}}` : segment.text.replace(/[\\`]|\$\{/g, (found) => `\\${found}`)))
    .join("");
  return `\`${body}\``;
}

/** `requestPathExpression`, read back, or `null` for any other text. */
export function readRequestPath(expression: string): PathSegment[] | null {
  if (expression.startsWith('"')) {
    const text = jsonString(expression);
    return text === null ? null : [{ text }];
  }
  if (!expression.startsWith("`") || !expression.endsWith("`") || expression.length < 2) return null;
  const segments: PathSegment[] = [];
  let text = "";
  const inner = expression.slice(1, -1);
  for (let at = 0; at < inner.length; ) {
    if (inner[at] === "\\") {
      const next = inner[at + 1];
      if (next === "\\" || next === "`") {
        text += next;
        at += 2;
      } else if (next === "$" && inner[at + 2] === "{") {
        text += "${";
        at += 3;
      } else return null;
      continue;
    }
    if (inner[at] === "`") return null;
    const key = /^\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}/.exec(inner.slice(at));
    if (key !== null) {
      if (text !== "") segments.push({ text });
      text = "";
      segments.push({ key: key[1]! });
      at += key[0].length;
      continue;
    }
    if (inner.startsWith("${", at)) return null;
    text += inner[at];
    at += 1;
  }
  if (text !== "") segments.push({ text });
  return segments;
}

/** The `--request` text a shape was read from. */
export function requestFlagText(shape: RequestShape): string {
  return `${shape.method} ${shape.path.map((segment) => ("key" in segment ? `{${segment.key}}` : segment.text)).join("")}`;
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

/** How a relative import names a TypeScript file: by its own name, or by
 * the JavaScript name tsc maps back to it. */
export type ImportSpelling = "ts" | "js";

const JS_NAME: Readonly<Record<string, string>> = { ".ts": ".js", ".mts": ".mjs", ".cts": ".cjs" };

/** The relative specifier one step file imports another by. The `.ts` name
 * loads under plain `node` as well as under nuka, and tsc accepts it only
 * with `rewriteRelativeImportExtensions` or `allowImportingTsExtensions`.
 * The `.js` name is the one tsc accepts under any options, and nuka's
 * loader falls back from it to the `.ts` file beside it. */
export function importSpecifier(fromDir: string, toFile: string, spelling: ImportSpelling): string {
  const relative = path.relative(fromDir, toFile).split(path.sep).join("/");
  const extension = path.posix.extname(relative);
  const named = spelling === "js" && JS_NAME[extension] !== undefined ? `${relative.slice(0, -extension.length)}${JS_NAME[extension]}` : relative;
  return named.startsWith(".") ? named : `./${named}`;
}

/** What a feature line carries below it. bindStepArgs hands a docstring
 * over as a string and a table as its rows of cells, into the one args key
 * no capture fills, so the stub declares that key or check refuses it. */
export type Attachment = "docstring" | "table";

const ATTACHMENT_FIELD: Readonly<Record<Attachment, { readonly field: Field; readonly schema: string }>> = {
  docstring: { field: { key: "docstring", valueClass: "string" }, schema: "z.string()" },
  table: { field: { key: "table", valueClass: "other" }, schema: "z.array(z.array(z.string()))" },
};

/** The attachment every line the pattern matches carries, or `null` when
 * no line matches or the lines disagree: a stub written before its feature
 * line, or for lines that carry different things, cannot know the key. */
export function lineAttachment(
  matches: (text: string) => boolean,
  steps: Iterable<{ readonly text: string; readonly argument?: { readonly docString?: unknown; readonly dataTable?: unknown } }>,
): Attachment | null {
  const kinds = new Set<Attachment | null>();
  for (const step of steps) {
    if (!matches(step.text)) continue;
    kinds.add(step.argument?.docString !== undefined ? "docstring" : step.argument?.dataTable !== undefined ? "table" : null);
  }
  return kinds.size === 1 ? [...kinds][0]! : null;
}

/** What the project's feature lines that this pattern matches carry below
 * them. A pattern that names a type the config does not register reads no
 * line, which leaves the key out as before. */
export function attachmentInFeatures(rootDir: string, pattern: string, config: Awaited<ReturnType<typeof loadConfig>>): Attachment | null {
  let expression;
  try {
    expression = buildExpression(pattern, createParameterTypeRegistry([...config.parameterTypes])).expression;
  } catch {
    return null;
  }
  const { features } = loadFeaturesFromDirs(rootDir, config.featuresDir, config.additionalFeatureDirs, config.oaths);
  return lineAttachment(
    (text) => expression.match(text) !== null,
    features.flatMap((feature) => feature.pickles.flatMap((pickle) => pickle.steps)),
  );
}

function argsLines(captures: readonly Capture[], attachment: Attachment | null, chained: readonly ChainedField[]): string[] {
  if (captures.length === 0 && attachment === null && chained.length === 0) {
    return ["  args: z.object({}),"];
  }
  const fields = captures.map((capture) => {
    const captured = CAPTURED_CLASS.get(capture.type);
    const schema = (captured && ZOD_FOR_CLASS.get(captured)) ?? "z.unknown()";
    return `    ${capture.key}: ${schema},`;
  });
  const attachmentFields =
    attachment === null ? [] : [`    ${ATTACHMENT_FIELD[attachment].field.key}: ${ATTACHMENT_FIELD[attachment].schema},`];
  const chainedFields = chained.map((field) => `    ${field.key}: ${field.producers[0].identifier}.returns.shape.${field.key},`);
  return ["  args: z.object({", ...fields, ...attachmentFields, ...chainedFields, "  }),"];
}

function fromLines(chained: readonly ChainedField[]): string[] {
  if (chained.length === 0) return [];
  return [
    "  from: {",
    ...chained.map((field) => {
      const candidates = field.producers.map((producer) => `[${producer.identifier}, ${JSON.stringify(field.key)}]`);
      return `    ${field.key}: ${candidates.length === 1 ? candidates[0] : `[${candidates.join(", ")}]`},`;
    }),
    "  },",
  ];
}

function importLines(chained: readonly ChainedField[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { identifier, specifier } of chained.flatMap((field) => field.producers)) {
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    lines.push(`import ${identifier} from ${JSON.stringify(specifier)};`);
  }
  return lines;
}

function fieldsOf(captures: readonly Capture[], chained: readonly ChainedField[]): Field[] {
  return [
    ...captures.map((capture) => ({ key: capture.key, valueClass: CAPTURED_CLASS.get(capture.type) ?? "other" })),
    ...chained.map(({ key, valueClass }) => ({ key, valueClass })),
  ];
}

// A bigint has no JSON form, and a value of unknown class may hold one.
const BIGINT_REPLACER = '(_key, value) => (typeof value === "bigint" ? String(value) : value)';

/** The stub's body: it throws, naming the step and the args it was given.
 * A bigint (or a value of unknown class, which may be one) has no JSON
 * form, so a replacer writes it as text only when a field may hold one. */
function stubBody(name: string, fields: readonly Field[]): string {
  if (fields.length === 0) return `    throw new Error(${JSON.stringify(`not implemented: ${name}`)});`;
  const mayHoldBigint = fields.some((field) => field.valueClass === "bigint" || field.valueClass === "other");
  const replacer = mayHoldBigint ? `, ${BIGINT_REPLACER}` : "";
  const keys = fields.map((field) => field.key).join(", ");
  return `    throw new Error(\`not implemented: ${name}; args \${JSON.stringify({ ${keys} }${replacer})}\`);`;
}

/** The expression that writes one compared value into the message. */
function messageText(key: string, valueClass: PrimitiveClass): string {
  if (valueClass === "bigint") return `\${${key}}`;
  if (valueClass === "other") return `\${JSON.stringify(${key}, ${BIGINT_REPLACER})}`;
  return `\${JSON.stringify(${key})}`;
}

/** The keys a `--command` step returns a program's text in. Neither a
 * capture nor a docstring can end with the newline a program prints last,
 * so comparing them as they are fails for every program that ends its
 * output the usual way. */
const OUTPUT_STREAMS: ReadonlySet<string> = new Set(["stdout", "stderr"]);

/** The Then body that compares the one chained value, or a TODO
 * placeholder, against the one captured value. A custom type may produce
 * an object, so its value is compared by structure. */
function assertBody(expected: Field, chained: Field | undefined): string[] {
  const actualClass = chained?.valueClass ?? expected.valueClass;
  const method = expected.valueClass === "other" ? "deepEqual" : "equal";
  const message = `${expected.key}: expected ${messageText(expected.key, expected.valueClass)}, got ${messageText("actual", actualClass)}`;
  const actualLines =
    chained === undefined
      ? [
          "    // TODO: read the value this line checks, for example from an earlier step's returns through `from`.",
          "    const actual: unknown = undefined;",
        ]
      : OUTPUT_STREAMS.has(chained.key) && chained.valueClass === "string" && expected.valueClass === "string"
        ? [
            "    // The program ends its output with a newline that the feature line does not show.",
            `    const actual = ${chained.key}.replace(/\\r?\\n$/, "");`,
          ]
        : [`    const actual = ${chained.key};`];
  return [...actualLines, `    assert.${method}(actual, ${expected.key}, \`${message}\`);`];
}

/** Stands for the 1-based number of the line that holds it, filled in
 * once the whole file is assembled. */
const LINE_MARKER = "\u0000line";

/** The guard a `--command` step throws while a chained value has nowhere
 * to go yet. The values are in its message, so the step compiles under
 * `noUnusedParameters`, and the first failed run shows what was bound. */
function unplacedGuard(relativeFilePath: string, unplaced: readonly Field[], reader: "program" | "request"): string[] {
  const keys = unplaced.map((field) => field.key);
  const mayHoldBigint = unplaced.some((field) => field.valueClass === "bigint" || field.valueClass === "other");
  const replacer = mayHoldBigint ? `, ${BIGINT_REPLACER}` : "";
  const todo =
    reader === "program"
      ? [
          "    // TODO: pass each chained value where the program reads it: an environment",
          "    // variable (runCommand's env, with ...process.env), a flag, or --cwd. Then delete the throw.",
        ]
      : [
          "    // TODO: pass each value where the request reads it: the path, or fetch's",
          "    // data, headers, or params option. Then delete the throw.",
        ];
  return [
    ...todo,
    `    throw new Error(\`pass ${keys.join(", ")} where the ${reader} reads them: ${relativeFilePath}:${LINE_MARKER}; args \${JSON.stringify({ ${keys.join(", ")} }${replacer})}\`);`,
  ];
}

/** The expression that splits a string on whitespace into argv elements.
 * No quoting rule: a shell-words parser would be a dependency, and a
 * feature line that needs a space inside one argument keeps a capture per
 * argument instead. */
export function whitespaceSplit(key: string): string {
  return `${key}.split(/\\s+/).filter((part) => part !== "")`;
}

/** One argv element per field, in order: a string as it is, anything else
 * as its text, and the `--argv` capture spread as its words. */
function commandArgv(fields: readonly Field[], argvKey: string | null): string {
  return [
    "cli",
    ...fields.map((field) =>
      field.key === argvKey ? `...${whitespaceSplit(field.key)}` : field.valueClass === "string" ? field.key : `String(${field.key})`,
    ),
  ].join(", ");
}

export function stepTemplate({
  name,
  pattern,
  captures,
  chained,
  variant,
  entryPoint,
  cwd,
  argvKey = null,
  description,
  relativeFilePath,
  attachment = null,
  request = null,
  bodyKey = null,
}: StepTemplate): string {
  const attached = attachment === null ? [] : [ATTACHMENT_FIELD[attachment].field];
  const fields = [...fieldsOf(captures, []), ...attached, ...fieldsOf([], chained)];
  const keys = fields.map((field) => field.key);
  const argsParameter = keys.length === 0 ? "" : `{ ${keys.join(", ")} }`;
  const patternLine =
    pattern === null
      ? ['  // pattern: "the feature line this step matches", (without one, the step is called by name only)']
      : [`  pattern: ${JSON.stringify(pattern)},`];
  const command = variant === "command";
  const sends = variant === "request" && request !== null;
  const asserts = assertsInBody(variant, captures.length + attached.length, chained.length);
  const headerLines = command
    ? [
        'import { defineStep, runCommand, z } from "nukadoko";',
        'import { resolve } from "node:path";',
        ...importLines(chained),
        "",
        `const cli = resolve(${JSON.stringify(entryPoint ?? ENTRY_POINT_PLACEHOLDER)});`,
      ]
    : [
        'import { defineStep, z } from "nukadoko";',
        ...(asserts ? ['import assert from "node:assert/strict";'] : []),
        ...importLines(chained),
      ];
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
    (command
      ? `${
          cwd === null ? "Run the command under test in an empty scratch directory" : `Run the command under test in the directory ${cwd} names`
        }${argvKey === null ? "" : `, with ${argvKey} split on whitespace into its arguments`}`
      : sends
        ? `Send ${requestFlagText(request)} and return the response's status and body`
        : `${DESCRIPTION_TODO_PREFIX} ${name}`);
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
            "  // Set this to false when the program changes nothing outside a scratch directory.",
            "  mutates: true,",
          ]
        : sends
          ? [
              "  returns: z.object({",
              "    status: z.number(),",
              "    body: z.string(),",
              "  }),",
              "  // The method is no proof either way: set this to false when the request changes nothing on the server.",
              "  mutates: true,",
            ]
          : [
            "  // Return what later steps cite and the values this step's correctness rests on;",
            '  // beside an absence (false, 0, ""), return proof the read was valid. Declare them here:',
            "  // returns: z.object({ ... }),",
          ];
  // A chained value is the program's context (a directory, an environment
  // variable, a flag's value), never a bare positional argument, so argv
  // holds the captures alone.
  const unplaced = fieldsOf([], chained).filter((field) => field.key !== cwd);
  const argvFields = fieldsOf(captures, []).filter((field) => field.key !== cwd);
  const placedInRequest = new Set(
    sends ? [...request.path.flatMap((segment) => ("key" in segment ? [segment.key] : [])), ...(bodyKey === null ? [] : [bodyKey])] : [],
  );
  const unsent = fields.filter((field) => !placedInRequest.has(field.key));
  const runLines = sends
    ? [
        `  async run({ request }${argsParameter === "" ? "" : `, ${argsParameter}`}) {`,
        ...(unsent.length === 0 ? [] : unplacedGuard(relativeFilePath, unsent, "request")),
        `    const response = await request.fetch(${requestPathExpression(request.path)}, { method: ${JSON.stringify(request.method)}${bodyKey === null ? "" : `, data: ${bodyKey}`} });`,
        "    return { status: response.status(), body: await response.text() };",
      ]
    : command
    ? [
        `  async run(${cwd === null ? "{ scratch }" : "{}"}${argsParameter === "" ? "" : `, ${argsParameter}`}) {`,
        ...placeholderGuard,
        ...(unplaced.length === 0 ? [] : unplacedGuard(relativeFilePath, unplaced, "program")),
        `    return await runCommand(process.execPath, [${commandArgv(argvFields, argvKey)}], { cwd: ${cwd === null ? "scratch.dir()" : cwd} });`,
      ]
    : [
        `  run(${argsParameter === "" ? "" : `{}, ${argsParameter}`}) {`,
        ...(asserts ? assertBody(fields[0]!, fields[1]) : [stubBody(name, fields)]),
      ];
  const lines = [
    ...headerLines,
    "",
    "export default defineStep({",
    `  description: ${JSON.stringify(describedAs)},`,
    ...patternLine,
    "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
    ...argsLines(captures, attachment, chained),
    ...fromLines(chained),
    ...outcomeLines,
    ...runLines,
    "  },",
    "});",
    "",
  ];
  return lines.map((line, index) => line.replace(LINE_MARKER, String(index + 1))).join("\n");
}

const PATTERN_LINE = /^ {2}pattern: (".*"),$/m;
const DESCRIPTION_LINE = /^ {2}description: (".*"),$/m;
const CLI_LINE = /^const cli = resolve\((".*")\);$/m;
const CWD_OPTION = /\{ cwd: ([A-Za-z_$][A-Za-z0-9_$]*) \}\);$/m;
const ARGV_SPREAD = /\.\.\.([A-Za-z_$][A-Za-z0-9_$]*)\.split\(/;
const REQUEST_CALL = /^ {4}const response = await request\.fetch\((.*), \{ method: ("[A-Z]+")(?:, data: ([A-Za-z_$][A-Za-z0-9_$]*))? \}\);$/m;
const RELATIVE_IMPORT = /^import ([A-Za-z_$][A-Za-z0-9_$]*) from ("\.[^"\n]*");$/gm;
const FROM_ENTRY = /^ {4}([A-Za-z_$][A-Za-z0-9_$]*): \[.*\],$/;
const FROM_CANDIDATE = /\[([A-Za-z_$][A-Za-z0-9_$]*), "([A-Za-z_$][A-Za-z0-9_$]*)"\]/g;

const TEMPLATE_VARIANTS: readonly Variant[] = ["when", "then", "command", "request"];
const TEMPLATE_ATTACHMENTS: readonly (Attachment | null)[] = [null, "docstring", "table"];
const CHAINED_CLASSES: readonly PrimitiveClass[] = ["string", "number", "other"];

// Each chained key multiplies the renders by three; a file with more keys
// than this is refused rather than rendered thousands of times.
const MAX_CHAINED_KEYS = 6;

function jsonString(literal: string | undefined): string | null {
  if (literal === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(literal);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** The `from` entries a file declares, each with its producers' import
 * identifiers and specifiers, or `null` when an entry names an identifier
 * the file does not import, or does not read as one this template writes. */
function chainedFromFile(source: string): { key: string; producers: Producer[] }[] | null {
  const specifiers = new Map<string, string>();
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const specifier = jsonString(match[2]);
    if (specifier === null) return null;
    specifiers.set(match[1]!, specifier);
  }
  const lines = source.split("\n");
  const open = lines.indexOf("  from: {");
  if (open === -1) return [];
  const fields: { key: string; producers: Producer[] }[] = [];
  for (const line of lines.slice(open + 1)) {
    if (line === "  },") return fields;
    const entry = FROM_ENTRY.exec(line);
    if (entry === null) return null;
    const producers: Producer[] = [];
    for (const candidate of line.matchAll(FROM_CANDIDATE)) {
      const specifier = specifiers.get(candidate[1]!);
      if (specifier === undefined || candidate[2] !== entry[1]) return null;
      producers.push({ step: candidate[1]!, identifier: candidate[1]!, specifier });
    }
    if (producers.length === 0) return null;
    fields.push({ key: entry[1]!, producers });
  }
  return null;
}

/** Every assignment of a value class to each of `count` chained keys. */
function classAssignments(count: number): PrimitiveClass[][] {
  let assignments: PrimitiveClass[][] = [[]];
  for (let index = 0; index < count; index += 1) {
    assignments = assignments.flatMap((assignment) => CHAINED_CLASSES.map((valueClass) => [...assignment, valueClass]));
  }
  return assignments;
}

/** Whether `source` is, byte for byte, a file this template writes for
 * this name and path under some set of scaffold options: what `--feature`
 * writes, or what `--then`, `--command`, `--from`, `--cwd`, `--argv`, and
 * `--description` write, before anyone edits it. Only such a file holds
 * nothing a scaffold run could not write again, so only such a file
 * `--replace` may overwrite. The options are read back from the file
 * itself (its pattern, description, entry point, `cwd`, `--argv` key,
 * imports, and `from` entries), and what the file cannot say (the variant,
 * the attachment, and the class of each chained value) is tried every way.
 * Equality decides: a reading that is wrong only fails to match, so it can
 * refuse a file scaffold wrote but never pass one someone edited. A guess
 * (a TODO marker that survives beside a real body) would let it destroy
 * work. */
export function isUneditedStub(source: string, name: string, relativeFilePath: string): boolean {
  const declared = PATTERN_LINE.exec(source);
  let pattern: string | null = null;
  let captures: readonly Capture[] = [];
  if (declared !== null) {
    pattern = jsonString(declared[1]);
    if (pattern === null) return false;
    try {
      captures = stripCaptureNames(pattern).captures;
    } catch {
      return false;
    }
  }
  const description = jsonString(DESCRIPTION_LINE.exec(source)?.[1]);
  if (description === null) return false;
  const cliLine = CLI_LINE.exec(source);
  const cliText = cliLine === null ? null : jsonString(cliLine[1]);
  if (cliLine !== null && cliText === null) return false;
  const entryPoint = cliText === ENTRY_POINT_PLACEHOLDER ? null : cliText;
  const cwd = CWD_OPTION.exec(source)?.[1] ?? null;
  const argvKey = ARGV_SPREAD.exec(source)?.[1] ?? null;
  const chainedKeys = chainedFromFile(source);
  if (chainedKeys === null || chainedKeys.length > MAX_CHAINED_KEYS) return false;
  const call = REQUEST_CALL.exec(source);
  const method = call === null ? null : jsonString(call[2]);
  const requestPath = call === null ? null : readRequestPath(call[1]!);
  const request = method === null || requestPath === null ? null : { method, path: requestPath };
  const bodyKey = call?.[3] ?? null;
  return classAssignments(chainedKeys.length).some((classes) => {
    const chained = chainedKeys.map(({ key, producers }, index): ChainedField => ({
      key,
      producers: producers as [Producer, ...Producer[]],
      valueClass: classes[index]!,
    }));
    return TEMPLATE_VARIANTS.some((variant) =>
      TEMPLATE_ATTACHMENTS.some(
        (attachment) =>
          stepTemplate({
            name,
            pattern,
            captures,
            chained,
            variant,
            entryPoint,
            cwd,
            argvKey,
            description,
            relativeFilePath,
            attachment,
            request,
            bodyKey,
          }) === source,
      ),
    );
  });
}

/** What the pattern captures, read against the built-in types alone, or
 * the reason `nuka check` would refuse it in any project. `projectTypes`
 * holds each type name the built-ins lack, which only the project's own
 * registry can settle. */
export interface ReadPattern {
  readonly captures: readonly Capture[];
  readonly projectTypes: readonly string[];
}

export function readPattern(pattern: string): ReadPattern | { refusal: string } {
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
  const given = new Set<string>();
  for (const text of texts) {
    const request = parseFromFlag(text);
    if ("refusal" in request) return request;
    if (keys.has(request.key) && !requests.some((earlier) => earlier.key === request.key)) {
      return {
        refusal: `args key "${request.key}" is filled by a capture and by --from, and one args field holds one value`,
      };
    }
    if (given.has(text)) return { refusal: `--from ${text} is given twice` };
    given.add(text);
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

/** A schema's JSON Schema with every `description` (and the `$schema`
 * dialect line) dropped, as text, or `null` when zod cannot represent it:
 * two producers that describe one key differently still declare one type. */
export function declaredType(schema: z.ZodType): string | null {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "description" && key !== "$schema")
        .map(([key, inner]) => [key, strip(inner)]),
    );
  };
  try {
    return JSON.stringify(strip(z.toJSONSchema(schema)));
  } catch {
    return null;
  }
}

/** Resolves each request against the project's typed steps, grouped by
 * key in the order each key first appears, or names the first producer
 * that cannot give the key. */
function resolveChain(
  requests: readonly FromRequest[],
  typedSteps: ReadonlyMap<string, TypedVocabularyEntry>,
  rootDir: string,
  stepDir: string,
  importFailureCount: number,
  moduleNames: ReadonlySet<string>,
  spelling: ImportSpelling,
): { chained: readonly ChainedField[] } | { refusal: string; fix?: string } {
  const identifiers = importIdentifiers(requests.map((request) => request.step), moduleNames);
  const byKey = new Map<string, { producers: [Producer, ...Producer[]]; schema: z.ZodType }>();
  for (const request of requests) {
    const producer = typedSteps.get(request.step);
    if (producer === undefined) {
      const unread =
        importFailureCount === 0 ? "" : `; ${importFailureCount} step file(s) did not import, and \`nuka check\` names them`;
      return { refusal: `no typed step is named "${request.step}" (\`nuka steps\` lists the vocabulary)${unread}` };
    }
    const returns = producer.step.returns as z.ZodTypeAny;
    const producerFile = path.relative(rootDir, path.resolve(rootDir, producer.filePath));
    const returnIt = `return ${request.key} from its run()`;
    if (!declaresReturns(producer.step)) {
      return {
        refusal: `${request.step} declares no returns, so it has no key to chain; declare returns with "${request.key}" in ${producerFile}`,
        fix: `add returns: z.object({ ${request.key}: <its schema> }) to ${producerFile} and ${returnIt}`,
      };
    }
    if (returns.type !== "object") {
      return {
        refusal: `${request.step}'s returns is not a z.object, so it has no key to chain`,
        fix: `make returns in ${producerFile} a z.object with a "${request.key}" key and ${returnIt}`,
      };
    }
    const shape = (returns as z.ZodObject).shape;
    const returnKeys = Object.keys(shape);
    if (!returnKeys.includes(request.key)) {
      const named = returnKeys.length === 0 ? "it returns no keys" : `its keys are ${returnKeys.join(", ")}`;
      return {
        refusal: `${request.step} does not return "${request.key}"; ${named}`,
        fix: `add "${request.key}" to returns in ${producerFile} and ${returnIt}`,
      };
    }
    const schema = shape[request.key] as z.ZodType;
    const resolved: Producer = {
      step: request.step,
      identifier: identifiers.get(request.step)!,
      specifier: importSpecifier(stepDir, path.resolve(rootDir, producer.filePath), spelling),
    };
    const earlier = byKey.get(request.key);
    if (earlier === undefined) {
      byKey.set(request.key, { producers: [resolved], schema });
      continue;
    }
    const first = earlier.producers[0].step;
    const firstType = declaredType(earlier.schema);
    const thisType = declaredType(schema);
    if (firstType === null || thisType === null || firstType !== thisType) {
      const shown = (type: string | null) => type ?? "a schema that JSON Schema cannot represent";
      return {
        refusal: `--from ${first}.${request.key} and --from ${request.step}.${request.key} fill one args field, which holds one type, and their schemas differ (${shown(firstType)} and ${shown(thisType)}); give both producers the same schema for "${request.key}", or chain them into different keys`,
      };
    }
    earlier.producers.push(resolved);
  }
  const chained = [...byKey].map(([key, { producers, schema }]) => ({
    key,
    producers,
    valueClass: chainedClass(schema as z.ZodTypeAny),
  }));
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

/** Why `--argv <key>` cannot split that key, and the command that would,
 * or `null` when the key is a string capture that stays in argv. */
function argvKeyRefusal(
  key: string,
  command: boolean,
  cwd: string | null,
  captures: readonly Capture[],
  typed: readonly string[],
): { refusal: string; fix?: string; do?: string } | null {
  if (!command) return { refusal: "--argv names the capture a --command step splits into argv, and only a --command step runs a program" };
  if (key === cwd) return { refusal: `--argv ${key} and --cwd ${key} name one key, and --cwd takes its key out of argv` };
  const captured = captures.find((capture) => capture.key === key);
  if (captured !== undefined && CAPTURED_CLASS.get(captured.type) === "string") return null;
  const strings = captures.filter((capture) => CAPTURED_CLASS.get(capture.type) === "string").map((capture) => capture.key);
  const why =
    captured === undefined
      ? `--argv ${key} names no capture of the pattern`
      : `--argv ${key} names a {${key}:${captured.type}} capture, which does not hand the step a string`;
  const first = strings[0];
  if (first === undefined) {
    return { refusal: `${why}, and the pattern captures no string`, fix: "Put an {args:string} capture where the arguments go in --pattern, and pass --argv args." };
  }
  const rerun = typed.flatMap((word, index) =>
    word.startsWith("--argv=") ? [`--argv=${first}`] : typed[index - 1] === "--argv" ? [first] : [word],
  );
  return {
    refusal: `${why}; its string captures are ${strings.join(", ")}`,
    do: ["nuka", ...rerun].map(shellWord).join(" "),
  };
}

/** Writes the refusal, or the missing-config line, for both scaffold
 * forms. The exit code when scaffold must stop, and null otherwise: a step
 * file written below the directory that holds the config is not one that
 * config reads. */
export function refusedBelowParentConfig(rootDir: string, sinks: RefusalSinks): number | null {
  const presence = locateConfig(rootDir);
  const refusal = scaffoldParentRefusal(rootDir, presence);
  if (refusal !== null) return refuse(sinks, `Refusing to scaffold: ${refusal}`, "config-in-parent");
  const line = noConfigLine(rootDir, presence);
  if (line !== null) sinks.stderr.write(formatFinding(configMissingFinding(line)));
  return null;
}

export async function runScaffold(options: RunScaffoldOptions): Promise<number> {
  const { rootDir, name, pattern, then, command, entryPoint, cwd, description, from, stdout, stderr } = options;
  const sinks = { json: false, stdout, stderr, command: "scaffold" };
  // After the edit a refusal names, the same command runs again as typed.
  const rerun = ["nuka", ...options.argv].map(shellWord).join(" ");

  if (!VALID_STEP_NAME.test(name)) {
    return refuse(sinks, `Invalid step name "${name}": must match [a-z0-9-]+ (kebab-case; it becomes the step's file name)`, "invalid-value");
  }

  if (command && then) {
    return refuse(sinks, "Refusing to scaffold: --command and --then together; a step that runs a program changes state, and a Then step declares mutates: false", "invalid-arguments");
  }
  let request: RequestShape | null = null;
  if (options.request !== null) {
    if (command) return refuse(sinks, "Refusing to scaffold: --request and --command together; one When step either sends a request or runs a program", "invalid-arguments");
    if (then) {
      return refuse(sinks, "Refusing to scaffold: --request and --then together; the step that sends the request is a When, and a Then step reads its status or body with --from", "invalid-arguments");
    }
    const parsed = parseRequestFlag(options.request);
    if ("refusal" in parsed) return refuse(sinks, `Refusing to scaffold: ${parsed.refusal}`, "invalid-value");
    request = parsed;
  }
  if (options.bodyKey !== null && request === null) {
    return refuse(sinks, "Refusing to scaffold: --body names the args key a --request step sends, and only a --request step sends one", "invalid-arguments");
  }
  if (cwd !== null && !command) {
    return refuse(sinks, "Refusing to scaffold: --cwd names the directory the program runs in, and only a --command step runs one", "invalid-arguments");
  }
  const variant: Variant = command ? "command" : request !== null ? "request" : then ? "then" : "when";
  const variantShape = VARIANTS[variant];

  if (description === "") {
    return refuse(sinks, "Refusing to scaffold: --description is empty; say what the step does, or leave the flag out for a TODO that nuka tend reports", "invalid-value");
  }

  if (entryPoint !== null) {
    const refusal =
      (await entryPointRefusal(rootDir, entryPoint, options.commandBeforeName)) ??
      (await unloadableImportRefusal(rootDir, entryPoint));
    if (refusal !== null) {
      return refuse(sinks, `Refusing to scaffold: ${refusal}`, "invalid-value");
    }
  }

  const read: ReadPattern | { refusal: string } = pattern === null ? { captures: [], projectTypes: [] } : readPattern(pattern);
  if ("refusal" in read) {
    return refuse(sinks, `Refusing to scaffold: ${read.refusal}`, "invalid-value");
  }
  const fromKeys = new Set(from.map((text) => text.slice(text.indexOf(".") + 1)));
  // The entry-point guard throws an `Error`, and the unplaced-value guard
  // also reads `JSON`, so an args key may not hide either.
  const unplacedFrom = [...fromKeys].some((key) => key !== cwd);
  const guardNames = [...(entryPoint === null || unplacedFrom ? ["Error"] : []), ...(unplacedFrom ? ["JSON"] : [])];
  const shape: VariantShape =
    request !== null
      ? { ...variantShape, bodyNames: new Set([...variantShape.bodyNames, "Error", "JSON"]) }
      : command && guardNames.length > 0
      ? { ...variantShape, bodyNames: new Set([...variantShape.bodyNames, ...guardNames]) }
      : // Several --from for one key fill one field, so the count is of keys.
        assertsInBody(variant, read.captures.length, fromKeys.size)
        ? {
            bodyNames: new Set([...variantShape.bodyNames, ...ASSERT_BODY_NAMES]),
            moduleNames: new Set([...variantShape.moduleNames, "assert"]),
          }
        : variantShape;
  const fromFlags = readFromFlags(from, read.captures, shape.bodyNames);
  if ("refusal" in fromFlags) {
    return refuse(sinks, `Refusing to scaffold: ${fromFlags.refusal}`, "invalid-value");
  }
  const argsKeys = [...read.captures.map((capture) => capture.key), ...new Set(fromFlags.requests.map((request) => request.key))];
  if (cwd !== null && !argsKeys.includes(cwd)) {
    const keys = argsKeys.length === 0 ? "it has none" : `its keys are ${argsKeys.join(", ")}`;
    return refuse(sinks, `Refusing to scaffold: --cwd ${cwd} names no args key of this step (${keys}); pass the key a --from or a capture fills`, "invalid-value");
  }

  if (request !== null) {
    const unknown = request.path.flatMap((segment) => ("key" in segment && !argsKeys.includes(segment.key) ? [segment.key] : []));
    if (unknown.length > 0) {
      const keys = argsKeys.length === 0 ? "it has none" : `its keys are ${argsKeys.join(", ")}`;
      return refuse(
        sinks,
        `Refusing to scaffold: --request's path names ${unknown.map((key) => `{${key}}`).join(", ")}, which no capture or --from fills (${keys}); a {key} in the path is put in by that args key's value`,
        "invalid-value",
      );
    }
  }

  if (options.argvKey !== null) {
    const refusal = argvKeyRefusal(options.argvKey, command, cwd, read.captures, options.argv);
    if (refusal !== null) {
      return refuse(sinks, `Refusing to scaffold: ${refusal.refusal}`, "invalid-arguments", {
        ...(refusal.fix !== undefined ? { fix: refusal.fix } : {}),
        ...(refusal.do !== undefined ? { do: refusal.do } : {}),
      });
    }
  }

  const belowParent = refusedBelowParentConfig(rootDir, sinks);
  if (belowParent !== null) return belowParent;

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    return refuse(sinks, error, "unexpected-error");
  }

  // The same `isCommonJsProject` call `nuka init` already defers to
  // (src/config/module-kind.ts's own header): a project with no
  // "type": "module" in package.json either reads a plain .ts file as
  // CommonJS ("type": "commonjs") or reparses it with a warning on every
  // load (no "type"), so a step file scaffolded there is .mts, matching the
  // nukadoko.config.mts that `nuka init` wrote.
  const stepExtension = isCommonJsProject(rootDir) ? ".mts" : ".ts";
  const relativeFilePath = path.join(config.featuresDir, "steps", `${name}${stepExtension}`);
  const filePath = path.join(rootDir, relativeFilePath);

  if (existsSync(filePath)) {
    const posixPath = relativeFilePath.split(path.sep).join("/");
    const unedited = isUneditedStub(await readFile(filePath, "utf8"), name, posixPath);
    const removeIt = {
      fix: `Delete ${relativeFilePath} if it holds no step to keep, or choose another step name.`,
      do: rerun,
    };
    if (!options.replace) {
      return unedited
        ? refuse(
            sinks,
            `Refusing to scaffold: ${relativeFilePath} already exists, and it still holds what scaffold wrote`,
            "file-exists",
            { do: ["nuka", ...options.argv, "--replace"].map(shellWord).join(" ") },
          )
        : refuse(sinks, `Refusing to scaffold: ${relativeFilePath} already exists`, "file-exists", removeIt);
    }
    if (!unedited) {
      return refuse(
        sinks,
        `Refusing to scaffold: ${relativeFilePath} is not what scaffold writes (someone edited it, or scaffold did not write it), so --replace leaves it`,
        "file-edited",
        removeIt,
      );
    }
  }

  // A project whose tsc refuses `./x.ts` gets the `.js` name instead, so the
  // file this command writes passes the project's own type check as it
  // stands. With no tsconfig.json there is no tsc setting to follow.
  const tsImports = tsExtensionImports(rootDir);
  const spelling: ImportSpelling = tsImports.kind === "refused" || tsImports.kind === "unread" ? "js" : "ts";
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
        return refuse(sinks, `Refusing to scaffold: ${refusal}`, "invalid-value");
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
      spelling,
    );
    if ("refusal" in resolved) {
      return refuse(
        sinks,
        `Refusing to scaffold: ${resolved.refusal}`,
        "step-inputs-invalid",
        resolved.fix === undefined ? undefined : { fix: `${resolved.fix.charAt(0).toUpperCase()}${resolved.fix.slice(1)}.`, do: rerun },
      );
    }
    chained = resolved.chained;
  }

  const cwdField = fieldsOf(read.captures, chained).find((field) => field.key === cwd);
  if (cwdField !== undefined && cwdField.valueClass !== "string") {
    return refuse(
      sinks,
      `Refusing to scaffold: --cwd ${cwdField.key} may hold a value that is not a string, and runCommand takes cwd as a string; chain a key whose schema is a bare z.string(), or capture it as {${cwdField.key}:string}`,
      "invalid-value",
    );
  }

  // A command's docstring has no place in argv, so it stays the author's call.
  const attachment = pattern === null || variant === "command" ? null : attachmentInFeatures(rootDir, pattern, config);
  if (options.bodyKey !== null) {
    const sendable = [...argsKeys, ...(attachment === null ? [] : [ATTACHMENT_FIELD[attachment].field.key])];
    if (!sendable.includes(options.bodyKey)) {
      const attached =
        options.bodyKey === "docstring" || options.bodyKey === "table"
          ? `; no feature line this pattern matches carries a ${options.bodyKey} (write the line first)`
          : "";
      return refuse(
        sinks,
        `Refusing to scaffold: --body ${options.bodyKey} names no args key of this step (${sendable.length === 0 ? "it has none" : `its keys are ${sendable.join(", ")}`})${attached}`,
        "invalid-value",
      );
    }
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
      cwd,
      argvKey: options.argvKey,
      description,
      relativeFilePath: relativeFilePath.split(path.sep).join("/"),
      attachment,
      request,
      bodyKey: options.bodyKey,
    }),
  );

  stdout.write(`${relativeFilePath}\n`);
  if (spelling === "js" && chained.length > 0) stderr.write(`note: ${jsImportNote(tsImports)}\n`);
  return 0;
}

function jsImportNote(tsImports: TsExtensionImports): string {
  if (tsImports.kind !== "unread") return JS_IMPORT_NOTE;
  return `the import names the .js file, because the tsconfig chain stops at ${tsImports.file} (${tsImports.detail}), so nothing in it says tsc accepts a .ts name; nuka loads the .ts file under that name. Once ${tsImports.file} is fixed and the chain sets "rewriteRelativeImportExtensions": true, scaffold imports by the .ts name`;
}

export const JS_IMPORT_NOTE =
  'the import names the .js file, because tsconfig.json sets neither rewriteRelativeImportExtensions nor allowImportingTsExtensions and tsc refuses a .ts name without one; nuka loads the .ts file under that name. Add "rewriteRelativeImportExtensions": true to compilerOptions to import by the .ts name';
