import type { ParameterTypeConfig } from "../config/schema.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `parameter-type-unused` note, a `config.parameterTypes`
// entry no typed *or* compat pattern's `{...}` token ever names. Boundary:
// compat's own `defineParameterType` registrations (support-side) are out of
// scope; only entries this project's `nukadoko.config.ts` declares are
// checked here.
//
// A typed pattern's token is always `{key:type}` (src/binding/pattern.ts's
// `stripCaptureNames` throws `UnnamedCaptureError` on any typed pattern
// token without a `:`, so every token binding-check.ts accepts already has
// one); a compat pattern's token is plain, unnamed cucumber-expressions
// syntax, `{type}` with no key at all (docs/spec.md "Compat steps": compat
// prose needs no named-capture syntax, src/check/binding-check.ts's header
// on why compat is never run through `stripCaptureNames`). Those are two
// different token grammars, so this cannot reuse `stripCaptureNames` (which
// would throw on every unnamed compat token) or binding-check.ts's
// `CheckedPattern[]` (whose `captures` field is *always* `[]` for a compat
// entry: compat has no named-capture concept to bind a table/docstring key
// against, which is a different question from "which type name did this
// token use"). `referencedTypeNames` below reads only the *type name* half
// of a `{...}` token, the text after the first `:` if there is one,
// otherwise the whole token, which both grammars agree on. Only a compat
// string pattern is scanned; a compat RegExp pattern uses JS regex capture
// groups, an unrelated mechanism with no `{type}` token at all.
//
// Malformed patterns (an unterminated `{`, an invalid capture key) already
// have their own findings (src/check/binding-check.ts); this scan stops at
// the first unterminated `{` and reports nothing further for that pattern
// rather than guessing.

function referencedTypeNames(pattern: string): string[] {
  const names: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      i += 2;
      continue;
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end === -1) {
        break; // Unterminated — src/check/binding-check.ts's own finding, not this one's to repeat.
      }
      const token = pattern.slice(i + 1, end);
      const colonIndex = token.indexOf(":");
      const typeName = colonIndex === -1 ? token : token.slice(colonIndex + 1);
      if (typeName !== "") {
        names.push(typeName);
      }
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return names;
}

export function findUnusedParameterTypes(
  vocabulary: Vocabulary,
  parameterTypes: readonly ParameterTypeConfig[],
): CheckIssue[] {
  if (parameterTypes.length === 0) {
    return [];
  }

  const usedNames = new Set<string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      for (const pattern of entry.step.patterns) {
        for (const name of referencedTypeNames(pattern)) {
          usedNames.add(name);
        }
      }
    } else if (typeof entry.compat.pattern === "string") {
      for (const name of referencedTypeNames(entry.compat.pattern)) {
        usedNames.add(name);
      }
    }
  }

  const issues: CheckIssue[] = [];
  for (const parameterType of parameterTypes) {
    if (usedNames.has(parameterType.name)) {
      continue;
    }
    issues.push({
      code: "parameter-type-unused",
      message: `Configured parameter type "${parameterType.name}" is not referenced by any typed or compat pattern.`,
    });
  }
  return issues;
}
