// Responsibility: read one already-fetched TypeScript source file's tree
// (never the file itself -- see this module's own `extractStepDeclarations`
// doc comment) and pull out every `defineStep`/compat `Given`/`When`/`Then`
// pattern it can resolve without running the file, plus a reason for every
// one it can't. This module never imports, requires, or evaluates the
// source it is given; parsing it with tree-sitter (src/extraction/tree-
// sitter-runtime.ts) is the one and only thing that happens to it. That is
// the whole point: the workspace file this text came from may be broken,
// malicious, or mid-edit, and none of that may ever run.
//
// Both `defineStep` and `Given`/`When`/`Then` are recognized only when the
// exact, unaliased name is imported from the exact module the real runtime
// binds them to ("nukadoko" and "nukadoko/compat" respectively) --
// otherwise a same-named local helper or a different library's export would
// be misread as a step declaration. Import aliasing
// (`import { defineStep as ds } from "nukadoko"`) is out of scope for this
// version: an aliased import is simply invisible here, the same as any
// other name this module doesn't recognize, never reported as unresolved
// (it was never a candidate declaration to begin with).
import type { Node } from "web-tree-sitter";
import { getTsxLanguage, getTypeScriptLanguage, Parser } from "./tree-sitter-runtime.js";

export interface SourcePosition {
  readonly row: number;
  readonly column: number;
}

export interface ExtractedPattern {
  readonly declarationFile: string;
  readonly declarationPosition: SourcePosition;
  readonly kind: "typed" | "compat";
  readonly pattern: string | RegExp;
}

export interface UnresolvedDeclaration {
  readonly declarationFile: string;
  readonly declarationPosition: SourcePosition;
  readonly reason: string;
}

export interface ExtractionResult {
  readonly patterns: readonly ExtractedPattern[];
  readonly unresolved: readonly UnresolvedDeclaration[];
}

function toSourcePosition(point: { row: number; column: number }): SourcePosition {
  return { row: point.row, column: point.column };
}

/** Concatenates a `string`/`template_string` node's own content children
 * (`string_fragment` verbatim, `escape_sequence` decoded) into the text the
 * literal actually denotes. Caller decides first whether the node qualifies
 * as a literal at all (`extractLiteralStringValue` below); this function
 * only reads the parts once that decision is made. */
function decodeQuotedParts(node: Node): string {
  let result = "";
  for (const child of node.namedChildren) {
    if (child.type === "string_fragment") {
      result += child.text;
    } else if (child.type === "escape_sequence") {
      result += decodeEscapeSequence(child.text);
    }
  }
  return result;
}

/** Common escapes only -- a cucumber-expression pattern almost never needs
 * more than these, and the acceptance cases for this module don't exercise
 * any of them. An escape this doesn't recognize (a unicode/hex escape, most
 * notably) falls back to its body with the backslash dropped: a readable,
 * if not fully accurate, best effort rather than a crash. */
function decodeEscapeSequence(raw: string): string {
  const body = raw.slice(1);
  switch (body) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "0":
      return "\0";
    case "\\":
      return "\\";
    case "'":
      return "'";
    case '"':
      return '"';
    case "`":
      return "`";
    default:
      return body;
  }
}

/** `undefined` when `node` is not a static string literal -- a plain quoted
 * string always qualifies; a template literal qualifies only when it has no
 * `${...}` substitution, since a substitution's value can only be known by
 * running the file. Anything else (an identifier, a call, a member
 * expression, ...) is never a literal either, for the same reason. */
function extractLiteralStringValue(node: Node): string | undefined {
  if (node.type === "string") {
    return decodeQuotedParts(node);
  }
  if (node.type === "template_string") {
    const hasSubstitution = node.namedChildren.some((child) => child.type === "template_substitution");
    if (hasSubstitution) {
      return undefined;
    }
    return decodeQuotedParts(node);
  }
  return undefined;
}

function getStringLiteralText(node: Node | null): string | undefined {
  if (!node || node.type !== "string") {
    return undefined;
  }
  return decodeQuotedParts(node);
}

/** The sole non-comment argument to a call, if it is a plain object literal
 * -- `defineStep`'s contract is exactly one object argument
 * (src/step/define-step.ts's `StepDefinitionInput`), so any other shape (no
 * arguments, several, a spread, a variable reference) is not this module's
 * to resolve. */
function getSoleObjectArgument(callExpression: Node): Node | undefined {
  const argumentsNode = callExpression.childForFieldName("arguments");
  if (!argumentsNode) {
    return undefined;
  }
  const nonComments = argumentsNode.namedChildren.filter((child) => child.type !== "comment");
  const [sole] = nonComments;
  if (nonComments.length !== 1 || !sole) {
    return undefined;
  }
  return sole.type === "object" ? sole : undefined;
}

function findPair(objectNode: Node, keyName: string): Node | undefined {
  return objectNode.namedChildren.find((child) => {
    if (child.type !== "pair") {
      return false;
    }
    const keyNode = child.childForFieldName("key");
    return keyNode?.type === "property_identifier" && keyNode.text === keyName;
  });
}

const COMPUTED_PATTERN_REASON =
  "pattern is a computed value (a variable, a function call, or a template literal with an expression), which cannot be resolved statically";

function processTypedStepCall(
  callExpression: Node,
  filePath: string,
  patterns: ExtractedPattern[],
  unresolved: UnresolvedDeclaration[],
): void {
  const position = toSourcePosition(callExpression.startPosition);
  const objectArgument = getSoleObjectArgument(callExpression);
  if (!objectArgument) {
    unresolved.push({
      declarationFile: filePath,
      declarationPosition: position,
      reason:
        "defineStep's argument is not a single static object literal, so its pattern(s) cannot be read without running the file",
    });
    return;
  }

  const patternPair = findPair(objectArgument, "pattern");
  const patternsPair = findPair(objectArgument, "patterns");

  // Neither field given at all is not an error: `pattern`/`patterns` are
  // both optional (src/step/define-step.ts's `StepDefinitionInput`), and a
  // step with neither is valid CLI-only vocabulary that Gherkin never binds
  // to -- nothing to extract, and nothing wrong to report either.
  if (!patternPair && !patternsPair) {
    return;
  }

  if (patternPair) {
    const valueNode = patternPair.childForFieldName("value");
    const literal = valueNode ? extractLiteralStringValue(valueNode) : undefined;
    if (literal !== undefined) {
      patterns.push({ declarationFile: filePath, declarationPosition: position, kind: "typed", pattern: literal });
    } else {
      unresolved.push({ declarationFile: filePath, declarationPosition: position, reason: COMPUTED_PATTERN_REASON });
    }
  }

  if (patternsPair) {
    const valueNode = patternsPair.childForFieldName("value");
    if (!valueNode || valueNode.type !== "array") {
      unresolved.push({
        declarationFile: filePath,
        declarationPosition: position,
        reason: "patterns is a computed value, not a static array literal, so its entries cannot be resolved statically",
      });
    } else {
      for (const element of valueNode.namedChildren.filter((child) => child.type !== "comment")) {
        const literal = extractLiteralStringValue(element);
        if (literal !== undefined) {
          patterns.push({
            declarationFile: filePath,
            declarationPosition: position,
            kind: "typed",
            pattern: literal,
          });
        } else {
          unresolved.push({
            declarationFile: filePath,
            declarationPosition: position,
            reason: "one entry of patterns is a computed value, which cannot be resolved statically",
          });
        }
      }
    }
  }
}

function processCompatCall(
  callExpression: Node,
  filePath: string,
  patterns: ExtractedPattern[],
  unresolved: UnresolvedDeclaration[],
): void {
  const position = toSourcePosition(callExpression.startPosition);
  const argumentsNode = callExpression.childForFieldName("arguments");
  const firstArgument = argumentsNode?.namedChildren.filter((child) => child.type !== "comment")[0];
  if (!firstArgument) {
    unresolved.push({
      declarationFile: filePath,
      declarationPosition: position,
      reason: "call has no pattern argument to read",
    });
    return;
  }

  if (firstArgument.type === "regex") {
    const patternField = firstArgument.childForFieldName("pattern");
    const flagsField = firstArgument.childForFieldName("flags");
    const source = patternField ? patternField.text : "";
    const flags = flagsField ? flagsField.text : "";
    try {
      patterns.push({
        declarationFile: filePath,
        declarationPosition: position,
        kind: "compat",
        pattern: new RegExp(source, flags),
      });
    } catch (error) {
      unresolved.push({
        declarationFile: filePath,
        declarationPosition: position,
        reason: `regex literal could not be read statically: ${String(error)}`,
      });
    }
    return;
  }

  const literal = extractLiteralStringValue(firstArgument);
  if (literal !== undefined) {
    patterns.push({ declarationFile: filePath, declarationPosition: position, kind: "compat", pattern: literal });
    return;
  }

  unresolved.push({ declarationFile: filePath, declarationPosition: position, reason: COMPUTED_PATTERN_REASON });
}

interface ImportInfo {
  readonly defineStepFromNukadoko: boolean;
  readonly compatNamesFromNukadokoCompat: ReadonlySet<string>;
}

const COMPAT_KEYWORDS = new Set(["Given", "When", "Then"]);

/** Reads every top-level `import { ... } from "..."` in the file and
 * decides which of `defineStep`/`Given`/`When`/`Then` this file's own code
 * can actually reach unaliased from "nukadoko"/"nukadoko/compat" -- the
 * source of truth every call-site check below consults, so a same-named
 * import from anywhere else, or an aliased one, is never mistaken for the
 * real thing (this module's own header explains why). */
function collectImportInfo(root: Node): ImportInfo {
  let defineStepFromNukadoko = false;
  const compatNames = new Set<string>();

  for (const importStatement of root.descendantsOfType(["import_statement"])) {
    const moduleSpecifier = getStringLiteralText(importStatement.childForFieldName("source"));
    if (moduleSpecifier === undefined) {
      continue;
    }

    for (const specifier of importStatement.descendantsOfType(["import_specifier"])) {
      const nameNode = specifier.childForFieldName("name");
      const aliasNode = specifier.childForFieldName("alias");
      if (!nameNode || aliasNode) {
        // Aliased (`as`) import: the local binding this file's code
        // actually calls is never checked against the imported name below,
        // so recognizing it would require import-alias support this
        // version deliberately doesn't have (this module's own header).
        continue;
      }
      const importedName = nameNode.text;
      if (moduleSpecifier === "nukadoko" && importedName === "defineStep") {
        defineStepFromNukadoko = true;
      }
      if (moduleSpecifier === "nukadoko/compat" && COMPAT_KEYWORDS.has(importedName)) {
        compatNames.add(importedName);
      }
    }
  }

  return { defineStepFromNukadoko, compatNamesFromNukadokoCompat: compatNames };
}

/**
 * Parses `sourceText` (already read by the caller -- see this module's own
 * header for why this function never reads the file itself) with
 * tree-sitter and returns every `export default defineStep(...)`/compat
 * `Given`/`When`/`Then` pattern it can read statically, plus one
 * {@link UnresolvedDeclaration} per declaration it found but couldn't
 * (a computed pattern, a non-literal `defineStep` argument). A step file
 * with neither `pattern` nor `patterns` at all (valid CLI-only vocabulary)
 * contributes nothing to either list -- see `processTypedStepCall`'s own
 * comment.
 */
export async function extractStepDeclarations(filePath: string, sourceText: string): Promise<ExtractionResult> {
  const language = filePath.endsWith(".tsx") ? await getTsxLanguage() : await getTypeScriptLanguage();
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(sourceText);
    if (!tree) {
      return { patterns: [], unresolved: [] };
    }
    try {
      const root = tree.rootNode;
      const importInfo = collectImportInfo(root);
      const patterns: ExtractedPattern[] = [];
      const unresolved: UnresolvedDeclaration[] = [];

      if (importInfo.defineStepFromNukadoko) {
        for (const exportStatement of root.descendantsOfType(["export_statement"])) {
          const valueNode = exportStatement.childForFieldName("value");
          if (!valueNode || valueNode.type !== "call_expression") {
            continue;
          }
          const functionNode = valueNode.childForFieldName("function");
          if (!functionNode || functionNode.type !== "identifier" || functionNode.text !== "defineStep") {
            continue;
          }
          processTypedStepCall(valueNode, filePath, patterns, unresolved);
        }
      }

      if (importInfo.compatNamesFromNukadokoCompat.size > 0) {
        for (const callExpression of root.descendantsOfType(["call_expression"])) {
          const functionNode = callExpression.childForFieldName("function");
          if (!functionNode || functionNode.type !== "identifier") {
            continue;
          }
          if (!importInfo.compatNamesFromNukadokoCompat.has(functionNode.text)) {
            continue;
          }
          processCompatCall(callExpression, filePath, patterns, unresolved);
        }
      }

      return { patterns, unresolved };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
