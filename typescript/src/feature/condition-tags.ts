import type { GherkinDocument, Tag } from "@cucumber/messages";
import { isConditionShaped, isExpectsShaped, readConditionTag, readExpectsTag, type ConditionTag, type ExpectedFailure } from "../condition/condition.js";

// Responsibility: every content tag a feature file writes that
// src/condition/condition.ts reads, condition tags and `@expects:` tags,
// where it is written: on the Feature, a Rule, a Scenario, or an Examples
// block, each with its own line. Boundary: reads the document and nothing
// else; what a tag means is src/condition/condition.ts's, and which
// findings follow is src/check/condition-check.ts's and
// src/check/expects-check.ts's.
//
// The document, not the pickles: a pickle carries every tag its Feature,
// Rule, and Examples carry, with no line, so a tag on the Feature line
// would be found once per scenario and placed on none of them.

/** One tag of a family as the file writes it. */
export interface TagOccurrence<T> {
  readonly relativePath: string;
  readonly line: number;
  /** The tag as written, `@` included. */
  readonly tag: string;
  /** What it names, or `undefined` when it does not read. */
  readonly read: T | undefined;
}

/** One condition-shaped tag as the file writes it. */
export type ConditionTagOccurrence = TagOccurrence<ConditionTag>;

/** One `@expects:`-shaped tag as the file writes it. */
export type ExpectsTagOccurrence = TagOccurrence<ExpectedFailure>;

/** Every condition-shaped tag in `gherkinDocument`, in file order. Pure. */
export function findConditionTags(gherkinDocument: GherkinDocument, relativePath: string): ConditionTagOccurrence[] {
  return findShapedTags(gherkinDocument, relativePath, isConditionShaped, readConditionTag);
}

/** Every `@expects:`-shaped tag in `gherkinDocument`, in file order. Pure. */
export function findExpectsTags(gherkinDocument: GherkinDocument, relativePath: string): ExpectsTagOccurrence[] {
  return findShapedTags(gherkinDocument, relativePath, isExpectsShaped, readExpectsTag);
}

function findShapedTags<T>(
  gherkinDocument: GherkinDocument,
  relativePath: string,
  shaped: (tag: string) => boolean,
  read: (tag: string) => T | undefined,
): TagOccurrence<T>[] {
  const found: TagOccurrence<T>[] = [];
  const note = (tags: readonly Tag[]): void => {
    for (const tag of tags) {
      if (!shaped(tag.name)) continue;
      found.push({ relativePath, line: tag.location.line, tag: tag.name, read: read(tag.name) });
    }
  };
  const feature = gherkinDocument.feature;
  if (feature === undefined) return found;
  note(feature.tags);
  const scenario = (child: { readonly scenario?: { readonly tags: readonly Tag[]; readonly examples: readonly { readonly tags: readonly Tag[] }[] } }): void => {
    if (child.scenario === undefined) return;
    note(child.scenario.tags);
    for (const examples of child.scenario.examples) note(examples.tags);
  };
  for (const child of feature.children) {
    if (child.rule !== undefined) {
      note(child.rule.tags);
      for (const ruleChild of child.rule.children) scenario(ruleChild);
    } else {
      scenario(child);
    }
  }
  return found;
}
