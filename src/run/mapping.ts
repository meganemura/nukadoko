import type { NukadokoConfig } from "../config/schema.js";

// Responsibility: whether the mapping changed since `nuka run --base`'s
// ref (docs/spec.md "Verdicts"). The mapping is what turns a sentence into
// what runs: every file under the features directory except the `.feature`
// files (step files, their helpers, support code, fixtures data), and the
// mapping part of the config. It is one unit, so a run knows only "the
// mapping changed" or "it did not", never which criterion a changed helper
// reaches: an earlier comparison that followed the files a step registers
// in missed a helper module no step file registers, and an unchanged
// criterion over a rewritten helper read as held. Imports out of the
// features directory are not followed either: what is outside it is the
// program's code, which the base world measures. Boundary: pure. Listing
// and hashing the files is src/run/base-run.ts's.
//
// The config's mapping part is `fixtures`, `parameterTypes`, `secrets`, and
// `worldParameters`: what decides what a step receives and how a sentence
// binds. A function in them is compared by its source text, the one thing
// a config written in TypeScript says about it. The rest of the config
// (where features and state live, the browser, retention, timeouts) is the
// run's own setting, and changing it does not change what an approved
// sentence means.
//
// The program file's `conditions` on each environment and its
// `defaultEnvironments` are part of the mapping too, though the program file
// otherwise goes with the code: they decide which cells of a criterion are
// required and which are controls, so an unchanged sentence under changed
// conditions can be asked to hold somewhere it never had to.

/** The mapping of one tree. */
export interface MappingSnapshot {
  /** Each file under the features directory except `.feature` files, by its
   * path relative to that directory, with a hash of its bytes. */
  readonly files: ReadonlyMap<string, string>;
  /** `configMappingText` of the tree's config, or why it did not load. */
  readonly config: { readonly text: string } | { readonly problem: string };
  /** `programMappingOf` the tree's program file, or why it did not
   * load. */
  readonly program: ProgramMapping | { readonly problem: string };
}

/** The part of a program file that is mapping, as text two trees
 * compare. */
export interface ProgramMapping {
  /** Each environment's `conditions`, as text, by environment name. */
  readonly conditions: ReadonlyMap<string, string>;
  readonly defaultEnvironments: string;
}

export interface MappingComparison {
  readonly changed: boolean;
  /** Each file added, removed, or edited, relative to the features
   * directory, sorted. */
  readonly files: readonly string[];
  /** Whether the config's mapping part differs, or could not be read at
   * the ref. */
  readonly config: boolean;
  /** Each environment whose `conditions` differ, sorted; every
   * environment when the program file could not be read at the ref. */
  readonly conditions: readonly string[];
  /** Whether `defaultEnvironments` differs, or could not be read at the
   * ref. */
  readonly defaultEnvironments: boolean;
}

function canonical(value: unknown, seen: Set<unknown>): unknown {
  if (typeof value === "function") return { function: value.toString() };
  if (value instanceof RegExp) return { regexp: value.toString() };
  if (value === undefined) return { undefined: true };
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return { cycle: true };
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => canonical(entry, seen))
    : Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key], seen)]),
      );
  seen.delete(value);
  return result;
}

/** The config's mapping part as text two trees compare (this file's
 * header). Pure. */
export function configMappingText(config: Pick<NukadokoConfig, "fixtures" | "parameterTypes" | "secrets" | "worldParameters">): string {
  const part = { fixtures: config.fixtures, parameterTypes: config.parameterTypes, secrets: config.secrets, worldParameters: config.worldParameters };
  return JSON.stringify(canonical(part, new Set()));
}

/** The program file's mapping part (this file's header), from what a
 * loaded program holds: `null` for a tree with no program file, whose
 * environments declare no conditions. Pure. */
export function programMappingOf(program: { readonly environments?: Readonly<Record<string, { readonly conditions?: unknown }>> } | null): ProgramMapping {
  const conditions = new Map<string, string>();
  for (const [name, environment] of Object.entries(program?.environments ?? {})) {
    conditions.set(name, JSON.stringify(canonical(environment.conditions ?? null, new Set())));
  }
  // Read by name, so a program file of a release that has no such field
  // reads as one that leaves the default selection alone.
  const defaults = (program as { readonly defaultEnvironments?: unknown } | null)?.defaultEnvironments;
  return { conditions, defaultEnvironments: JSON.stringify(canonical(defaults ?? null, new Set())) };
}

/** What differs between the mapping at the ref and at head. A config or a
 * program file that did not load at the ref counts as changed: nothing
 * shows its mapping part is the one head has. Pure. */
export function compareMapping(base: MappingSnapshot, head: MappingSnapshot): MappingComparison {
  const paths = new Set([...base.files.keys(), ...head.files.keys()]);
  const files = [...paths].filter((file) => base.files.get(file) !== head.files.get(file)).sort();
  const config = !("text" in base.config) || !("text" in head.config) || base.config.text !== head.config.text;
  let conditions: string[];
  let defaultEnvironments: boolean;
  if ("problem" in base.program || "problem" in head.program) {
    const names = new Set([
      ...("problem" in base.program ? [] : base.program.conditions.keys()),
      ...("problem" in head.program ? [] : head.program.conditions.keys()),
    ]);
    conditions = [...names].sort();
    defaultEnvironments = true;
  } else {
    const before = base.program;
    const after = head.program;
    const names = new Set([...before.conditions.keys(), ...after.conditions.keys()]);
    const none = JSON.stringify(null);
    conditions = [...names].filter((name) => (before.conditions.get(name) ?? none) !== (after.conditions.get(name) ?? none)).sort();
    defaultEnvironments = before.defaultEnvironments !== after.defaultEnvironments;
  }
  const programChanged = conditions.length > 0 || defaultEnvironments || "problem" in base.program || "problem" in head.program;
  return { changed: files.length > 0 || config || programChanged, files, config, conditions, defaultEnvironments };
}
