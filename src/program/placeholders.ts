import type { Conditions } from "../condition/condition.js";
import { commandWords, type ProgramRecipe } from "../config/program-schema.js";

// Responsibility: fill the placeholders a program file writes in its
// commands and its env (docs/spec.md "Program"), and name each one a world
// has no value for before anything runs. Pure: values in, text out.
// Boundary: which values a running world has is src/program/world.ts's;
// which worlds a command checks is the command's.
//
// Only the six names below and `{condition.<name>}` are placeholders. Any
// other text in braces is left as written, so a command that passes JSON or
// a shell brace needs no escape. A placeholder this world has no value for
// (`{port}` or `{url}` in a world with neither `serve` nor `url`,
// anything but `{root}` in a build command) is refused by name instead of
// becoming an empty string, which would start a server on no port or point
// a database at no directory.
//
// Every world with a URL has a port: the one nukadoko gave `serve`, or the
// port of the `url` (written, or the scheme's), so an environment that
// swaps `serve` for `url` keeps the top level's `PORT: "{port}"`.
//
// `{condition.<name>}` is the environment's own value for one of its
// `conditions`, as text: `true`, `false`, or the string. A program file
// that derives its switch from it (`env: { BANNER: "{condition.banner}" }`)
// cannot declare one side of a switch and run the other, which is what a
// condition is trusted to say (docs/spec.md "Verdicts"). A condition the
// environment does not declare has no value here, though a tag reads it
// as off: an empty or made-up "false" would set a switch nobody declared.
//
// Which placeholders a world has follows from its recipe alone, so the
// refusal does not wait for a world to start: `placeholderGaps` names
// each one from the recipe, and `nuka check`, `nuka run`, and `nuka do`
// refuse, for the worlds they resolve, before a build or a prepare
// command has run.

export const PLACEHOLDER_NAMES = ["port", "url", "dir", "root", "world", "token"] as const;

/** The prefix of the placeholder that names one condition of the world's
 * environment: `{condition.banner}`. */
export const CONDITION_PLACEHOLDER_PREFIX = "condition.";

export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number] | `${typeof CONDITION_PLACEHOLDER_PREFIX}${string}`;

/** The values one world fills: one per fixed name it has, and the
 * conditions its environment declares, which fill `{condition.<name>}`. */
export type PlaceholderValues = Readonly<Partial<Record<(typeof PLACEHOLDER_NAMES)[number], string>>> & {
  readonly conditions?: Conditions | undefined;
};

// A condition's name is CONDITION_NAME_PATTERN's character set.
const PLACEHOLDER = new RegExp(`\\{(${PLACEHOLDER_NAMES.join("|")}|${CONDITION_PLACEHOLDER_PREFIX.replace(".", "\\.")}[A-Za-z0-9_.-]+)\\}`, "g");

/** The text a placeholder fills, or `undefined` when `values` has none. */
function valueOf(name: PlaceholderName, values: PlaceholderValues): string | undefined {
  if (!name.startsWith(CONDITION_PLACEHOLDER_PREFIX)) return values[name as (typeof PLACEHOLDER_NAMES)[number]];
  const condition = name.slice(CONDITION_PLACEHOLDER_PREFIX.length);
  const conditions = values.conditions;
  return conditions !== undefined && Object.hasOwn(conditions, condition) ? String(conditions[condition]) : undefined;
}

/** `text` with each placeholder replaced by its value, or the first
 * placeholder `values` has none for. */
export function fillPlaceholders(text: string, values: PlaceholderValues): { readonly text: string } | { readonly missing: PlaceholderName } {
  let missing: PlaceholderName | undefined;
  const filled = text.replace(PLACEHOLDER, (whole, name: PlaceholderName) => {
    const value = valueOf(name, values);
    if (value === undefined) {
      missing ??= name;
      return whole;
    }
    return value;
  });
  return missing === undefined ? { text: filled } : { missing };
}

/** A field of a recipe that names a placeholder its world has no value for. */
export interface PlaceholderGap {
  /** The field, as a message names it: `build[0]`, `prepare[1]`,
   * `serve.command`, or `env.PORT`. */
  readonly where: string;
  readonly name: PlaceholderName;
  /** Why the world has no value for it. */
  readonly why: string;
}

const BUILD_WHY = "build runs once per tree, before any world exists";
const NO_URL_WHY = "this world has neither serve nor url";

/** Why a world of `reach` has no value for `name`, or `undefined` when it
 * has one. A build has `{root}` alone. */
export function placeholderAbsence(name: PlaceholderName, reach: ProgramRecipe["reach"]["kind"] | "build"): string | undefined {
  if (reach === "build") return name === "root" ? undefined : BUILD_WHY;
  if ((name === "port" || name === "url") && reach === "none") return NO_URL_WHY;
  return undefined;
}

/** Why a world whose environment declares `conditions` has no value for
 * `{condition.<name>}`, or `undefined` when it has one. */
function conditionAbsence(name: string, conditions: Conditions | undefined): string | undefined {
  if (conditions !== undefined && Object.hasOwn(conditions, name)) return undefined;
  return `its environment declares no condition "${name}" under conditions`;
}

/** Each field of `recipe`, and each placeholder it names, that its world
 * has no value for, in the order the world would reach them: build,
 * prepare, serve, then env. A placeholder named twice in one field is one
 * gap. */
export function placeholderGaps(
  recipe: Pick<ProgramRecipe, "build" | "prepare" | "reach" | "env"> & { readonly conditions?: Conditions | undefined },
): PlaceholderGap[] {
  const fields: { readonly where: string; readonly texts: readonly string[]; readonly reach: ProgramRecipe["reach"]["kind"] | "build" }[] = [
    ...recipe.build.map(({ command }, index) => ({ where: `build[${index}]`, texts: commandWords(command), reach: "build" as const })),
    ...recipe.prepare.map(({ command }, index) => ({ where: `prepare[${index}]`, texts: commandWords(command), reach: recipe.reach.kind })),
    ...(recipe.reach.kind === "serve" ? [{ where: "serve.command", texts: commandWords(recipe.reach.serve.command), reach: recipe.reach.kind }] : []),
    ...Object.entries(recipe.env).map(([key, value]) => ({ where: `env.${key}`, texts: [value], reach: recipe.reach.kind })),
  ];
  const gaps: PlaceholderGap[] = [];
  for (const field of fields) {
    const seen = new Set<PlaceholderName>();
    for (const text of field.texts) {
      for (const match of text.matchAll(PLACEHOLDER)) {
        const name = match[1] as PlaceholderName;
        if (seen.has(name)) continue;
        seen.add(name);
        const why =
          name.startsWith(CONDITION_PLACEHOLDER_PREFIX) && field.reach !== "build"
            ? conditionAbsence(name.slice(CONDITION_PLACEHOLDER_PREFIX.length), recipe.conditions)
            : placeholderAbsence(name, field.reach);
        if (why !== undefined) gaps.push({ where: field.where, name, why });
      }
    }
  }
  return gaps;
}

/** One gap as a sentence: `prepare[1] names {port}, which has no value
 * here: this world does not serve`. */
export function describePlaceholderGap(gap: PlaceholderGap): string {
  return `${gap.where} names {${gap.name}}, which has no value here: ${gap.why}`;
}

/** The refusal for the worlds a command is about to start, before any of
 * them runs a command: every gap of every world in one message, and the
 * edit for the first. `undefined` when no world has a gap. */
export function placeholderRefusal(
  worlds: readonly { readonly name: string; readonly recipe: Parameters<typeof placeholderGaps>[0] }[],
  programFile: string,
  environments: ProgramEnvironments,
): { readonly message: string; readonly fix: string; readonly first: { readonly world: string; readonly gap: PlaceholderGap } } | undefined {
  const gaps = worlds.flatMap((world) => placeholderGaps(world.recipe).map((gap) => ({ world: world.name, gap })));
  const first = gaps[0];
  if (first === undefined) return undefined;
  return {
    message: `${gaps.map(({ world, gap }) => `world ${world}: ${describePlaceholderGap(gap)}`).join("; ")}; nothing ran`,
    fix: placeholderGapFix(first.gap, first.world, programFile, environments),
    first,
  };
}

/** The edit for a `{condition.<name>}` gap in a world that is no
 * environment of the program file: the default world when `environments`
 * has no `default` entry. Such a world declares no conditions, and the
 * file has no place to declare one for it, so the edit is to run in an
 * environment that declares the condition. `environment` is the first of
 * them, for a command to name; `undefined` when none does. `undefined` as
 * a whole for any other gap, which `placeholderGapFix` covers. */
export function conditionOutsideEnvironmentsFix(
  gap: PlaceholderGap,
  environments: ProgramEnvironments,
  programFile: string,
): { readonly fix: string; readonly environment: string | undefined } | undefined {
  if (!gap.name.startsWith(CONDITION_PLACEHOLDER_PREFIX) || gap.where.startsWith("build")) return undefined;
  const condition = gap.name.slice(CONDITION_PLACEHOLDER_PREFIX.length);
  const declaring = Object.entries(environments)
    .filter(([, environment]) => environment.conditions !== undefined && Object.hasOwn(environment.conditions, condition))
    .map(([name]) => name);
  const outside = "The default world declares no conditions, and only an environment can";
  if (declaring.length === 0) {
    return {
      fix: `${outside}; none in ${programFile} declares ${condition}. Declare it under conditions of an environment, or remove {${gap.name}} from ${gap.where}.`,
      environment: undefined,
    };
  }
  return {
    fix: `${outside}: ${declaring.join(", ")} ${declaring.length === 1 ? "declares" : "declare"} ${condition}. Name one with --env, or remove {${gap.name}} from ${gap.where}.`,
    environment: declaring[0],
  };
}

/** The program file's `environments`, as far as a fix reads them. */
export type ProgramEnvironments = Readonly<Record<string, { readonly conditions?: Conditions | undefined }>>;

/** The edit that closes `gap` in world `world` of `programFile`: it names
 * only what the world lacks. Outside a build, only a world with neither
 * `serve` nor `url` lacks a value (`placeholderAbsence`), so the edit
 * offers either one; a world that has one of them is never told to add
 * the other, which the file refuses beside it. A condition is declared on
 * the world's environment, and a world that is no entry of `environments`
 * is sent to one that declares it. */
export function placeholderGapFix(gap: PlaceholderGap, world: string, programFile: string, environments: ProgramEnvironments): string {
  if (!Object.hasOwn(environments, world)) {
    const outside = conditionOutsideEnvironmentsFix(gap, environments, programFile);
    if (outside !== undefined) return outside.fix;
  }
  if (gap.name.startsWith(CONDITION_PLACEHOLDER_PREFIX) && !gap.where.startsWith("build")) {
    const condition = gap.name.slice(CONDITION_PLACEHOLDER_PREFIX.length);
    return `Declare ${condition} under conditions of world ${world} in ${programFile}, or remove {${gap.name}} from ${gap.where}.`;
  }
  if (gap.where.startsWith("build")) {
    return `Write only {root} in ${gap.where} of ${programFile}, or move the command to prepare, which runs once per world.`;
  }
  return `Remove {${gap.name}} from ${gap.where} of ${programFile}, or give world ${world} serve or url.`;
}
