import path from "node:path";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `step-description-todo` note, a typed step whose
// `description` is still the placeholder `nuka scaffold` writes. The
// placeholder imports, binds, and runs green, so nothing else reports it,
// and it reaches `nuka steps` and `nuka describe` as the step's
// description. Boundary: the match is the scaffold's own literal prefix, so
// the note claims only what scaffold wrote and a person left. It is a note,
// not an error or a warning, because the step runs as it is.

/** The start of the description `nuka scaffold` writes when it is given
 * none: this prefix and the step's name. */
export const DESCRIPTION_TODO_PREFIX = "TODO: describe";

export function findDescriptionTodos(vocabulary: Vocabulary, rootDir: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed" || entry.step.description?.startsWith(DESCRIPTION_TODO_PREFIX) !== true) continue;
    issues.push({
      code: "step-description-todo",
      message: `Step "${entry.name}" still has the description nuka scaffold wrote (${JSON.stringify(entry.step.description)}); nuka steps and nuka describe show it to whoever picks a step, so say what the step does.`,
      file: path.relative(rootDir, entry.filePath),
      step: entry.name,
    });
  }
  return issues;
}
