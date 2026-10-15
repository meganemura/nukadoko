import type { Vocabulary } from "../discover/discover-steps.js";
import { isModel, type Model, type Relation, type RelationStep } from "../step/define-explore.js";
import { isStep, type Step } from "../step/define-step.js";
import type { CheckIssue } from "./types.js";
import { unseededRandomCalls } from "./unseeded-random.js";

// Responsibility: the static half of a model or a relation. A command key
// or a sequence entry either names a step discovery registered, or it does
// not, and that step either destructures `page` or `context` (directly or
// through a fixture that reaches one), or it does not. Both are facts
// about the declaration. This file does not call `initial`, `args`, `pre`,
// `next`, `post`, `follow`, or `relate`, and it does not call `step.run`.
// Calling any of those would turn a check into a run. The one thing it
// reads from a callback is its source text, for a direct random call.

export interface ExploreModelFile {
  readonly filePath: string;
  readonly model: Model;
}

export interface ExploreRelationFile {
  readonly filePath: string;
  readonly relation: Relation;
}

export interface CheckExploreInput {
  readonly vocabulary: Vocabulary;
  readonly models: readonly ExploreModelFile[];
  readonly relations: readonly ExploreRelationFile[];
  /** Whether opening this step's fixture bag opens a browser. The caller
   * supplies the project's fixture graph. This module does not import that
   * graph: the predicate is the only fact the findings need. */
  readonly needsBrowser: (step: Step) => boolean;
}

function registeredName(vocabulary: Vocabulary, step: Step): string | undefined {
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed" && entry.step === step) {
      return entry.name;
    }
  }
  return undefined;
}

/**
 * One finding per command key and per source entry that fails. A
 * request-only step produces nothing here. The second sequence is the
 * return value of `follow`, and a source drawn by a function is the
 * return value of that function; both are only known once a run calls
 * them, so check does not read them. A model source is checked as a
 * model is.
 */
export function checkExploreDeclarations(input: CheckExploreInput): CheckIssue[] {
  const issues: CheckIssue[] = [];

  for (const file of input.models) {
    issues.push(...checkModelCommands(input, file.filePath, file.model, "", true));
  }

  for (const file of input.relations) {
    const { source } = file.relation;
    if (isModel(source)) {
      // An empty model source is not reported: follow and relate still run
      // on the empty source, and they can fail there.
      issues.push(
        ...checkModelCommands(input, file.filePath, source, `relation "${file.relation.name}" source `, false),
      );
      continue;
    }
    // A source drawn by a function has no steps until a run calls it.
    if (!Array.isArray(source)) {
      if (typeof source === "function") {
        for (const call of unseededRandomCalls(String(source))) {
          issues.push({
            code: "explore-unseeded-random",
            message: `relation "${file.relation.name}" source ${unseeded(call)}`,
            file: file.filePath,
          });
        }
      }
      continue;
    }
    (source as readonly RelationStep[]).forEach((entry, index) => {
      const where = `relation "${file.relation.name}" source[${index}]`;
      if (!isStep(entry.step)) {
        issues.push({
          code: "explore-unknown-step",
          message: `${where} names a step that is not in the vocabulary`,
          file: file.filePath,
        });
        return;
      }
      const registered = registeredName(input.vocabulary, entry.step);
      if (registered === undefined) {
        issues.push({
          code: "explore-unknown-step",
          message: `${where} names a step that is not in the vocabulary`,
          file: file.filePath,
        });
        return;
      }
      if (input.needsBrowser(entry.step)) {
        issues.push(browser(file.filePath, registered, where));
      }
    });
  }

  return issues;
}

function checkModelCommands(
  input: CheckExploreInput,
  filePath: string,
  model: Model,
  prefix: string,
  reportEmpty: boolean,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const commands = Object.entries(model.commands);
  if (reportEmpty && commands.length === 0) {
    issues.push({
      code: "explore-empty-model",
      message: "the model has no commands, so every sequence it builds is empty and passes",
      file: filePath,
    });
  }
  for (const [name, command] of commands) {
    const where = `${prefix}command "${name}"`;
    for (const part of ["args", "pre", "next"] as const) {
      const callback: unknown = command[part];
      if (typeof callback !== "function") continue;
      for (const call of unseededRandomCalls(String(callback))) {
        issues.push({
          code: "explore-unseeded-random",
          message: `${where} ${part} ${unseeded(call)}`,
          file: filePath,
          step: name,
        });
      }
    }
    if (!isStep(command.step)) {
      issues.push(unknown(filePath, name, where));
      continue;
    }
    const registered = registeredName(input.vocabulary, command.step);
    if (registered === undefined) {
      issues.push(unknown(filePath, name, where));
      continue;
    }
    if (registered !== name) {
      issues.push({
        code: "explore-unknown-step",
        message: `${where} is not the step registered as "${registered}"`,
        file: filePath,
        step: name,
      });
      continue;
    }
    if (input.needsBrowser(command.step)) {
      issues.push(browser(filePath, name, where));
    }
  }
  return issues;
}

function unseeded(call: string): string {
  return `calls ${call}, which the seed does not drive, so a run cannot be replayed or shrunk. Use draw.int or draw.pick`;
}

function unknown(filePath: string, stepName: string, where: string): CheckIssue {
  return {
    code: "explore-unknown-step",
    message: `${where} names "${stepName}", which is not in the vocabulary`,
    file: filePath,
    step: stepName,
  };
}

function browser(filePath: string, stepName: string, where: string): CheckIssue {
  return {
    code: "explore-browser-step",
    message: `${where} names "${stepName}", which needs a browser (page or context). Explore does not run a step that needs a browser`,
    file: filePath,
    step: stepName,
  };
}
