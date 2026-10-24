import { commandWords, type ProgramRecipe } from "../config/program-schema.js";

// Responsibility: fill the placeholders a program file writes in its
// commands and its env (docs/spec.md "Program"), and name each one a world
// has no value for before anything runs. Pure: values in, text out.
// Boundary: which values a running world has is src/program/world.ts's;
// which worlds a command checks is the command's.
//
// Only the six names below are placeholders. Any other text in braces is
// left as written, so a command that passes JSON or a shell brace needs no
// escape. A placeholder this world has no value for (`{port}` in a world
// that does not serve, anything but `{root}` in a build command) is
// refused by name instead of becoming an empty string, which would start
// a server on no port or point a database at no directory.
//
// Which placeholders a world has follows from its recipe alone, so the
// refusal does not wait for a world to start: `placeholderGaps` names
// each one from the recipe, and `nuka check`, `nuka run`, and `nuka do`
// refuse before a build or a prepare command has run.

export const PLACEHOLDER_NAMES = ["port", "url", "dir", "root", "world", "token"] as const;

export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

export type PlaceholderValues = Readonly<Partial<Record<PlaceholderName, string>>>;

const PLACEHOLDER = new RegExp(`\\{(${PLACEHOLDER_NAMES.join("|")})\\}`, "g");

/** `text` with each placeholder replaced by its value, or the first
 * placeholder `values` has none for. */
export function fillPlaceholders(text: string, values: PlaceholderValues): { readonly text: string } | { readonly missing: PlaceholderName } {
  let missing: PlaceholderName | undefined;
  const filled = text.replace(PLACEHOLDER, (whole, name: PlaceholderName) => {
    const value = values[name];
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

/** Why a world of `reach` has no value for `name`, or `undefined` when it
 * has one. A build has `{root}` alone. */
export function placeholderAbsence(name: PlaceholderName, reach: ProgramRecipe["reach"]["kind"] | "build"): string | undefined {
  if (reach === "build") return name === "root" ? undefined : BUILD_WHY;
  if (name === "port" && reach !== "serve") return "this world does not serve";
  if (name === "url" && reach === "none") return "this world has neither serve nor url";
  return undefined;
}

/** Each field of `recipe`, and each placeholder it names, that its world
 * has no value for, in the order the world would reach them: build,
 * prepare, serve, then env. A placeholder named twice in one field is one
 * gap. */
export function placeholderGaps(recipe: Pick<ProgramRecipe, "build" | "prepare" | "reach" | "env">): PlaceholderGap[] {
  const fields: { readonly where: string; readonly texts: readonly string[]; readonly reach: ProgramRecipe["reach"]["kind"] | "build" }[] = [
    ...recipe.build.map((command, index) => ({ where: `build[${index}]`, texts: commandWords(command), reach: "build" as const })),
    ...recipe.prepare.map((command, index) => ({ where: `prepare[${index}]`, texts: commandWords(command), reach: recipe.reach.kind })),
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
        const why = placeholderAbsence(name, field.reach);
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
  worlds: readonly { readonly name: string; readonly recipe: Pick<ProgramRecipe, "build" | "prepare" | "reach" | "env"> }[],
  programFile: string,
): { readonly message: string; readonly fix: string } | undefined {
  const gaps = worlds.flatMap((world) => placeholderGaps(world.recipe).map((gap) => ({ world: world.name, gap })));
  const first = gaps[0];
  if (first === undefined) return undefined;
  return {
    message: `${gaps.map(({ world, gap }) => `world ${world}: ${describePlaceholderGap(gap)}`).join("; ")}; nothing ran`,
    fix: placeholderGapFix(first.gap, first.world, programFile),
  };
}

/** The edit that closes `gap` in world `world` of `programFile`. */
export function placeholderGapFix(gap: PlaceholderGap, world: string, programFile: string): string {
  if (gap.where.startsWith("build")) {
    return `Write only {root} in ${gap.where} of ${programFile}, or move the command to prepare, which runs once per world.`;
  }
  const reach = gap.name === "port" ? "serve" : "serve or url";
  return `Remove {${gap.name}} from ${gap.where} of ${programFile}, or give world ${world} ${reach}.`;
}
